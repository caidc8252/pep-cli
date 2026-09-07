import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthService } from "./auth-service.js";
import type { OAuthClient } from "./oauth-client.js";
import type {
  CliConfig,
  ConfigStore,
  CredentialStore,
  DiscoveryDocument,
  StoredAuthorization,
} from "./types.js";

const CONFIG: CliConfig = {
  version: 1,
  issuer: "https://pep.example.com",
  clientId: "pep-cli",
  redirectUri: "http://localhost:53682/callback",
};
const DISCOVERY: DiscoveryDocument = {
  issuer: CONFIG.issuer,
  authorizationEndpoint: `${CONFIG.issuer}/api/oauth/authorize`,
  tokenEndpoint: `${CONFIG.issuer}/api/oauth/token`,
  revocationEndpoint: `${CONFIG.issuer}/api/oauth/revoke`,
  userinfoEndpoint: `${CONFIG.issuer}/api/oauth/userinfo`,
};

function authorization(expiresAt: number, suffix = "old"): StoredAuthorization {
  return {
    version: 1,
    issuer: CONFIG.issuer,
    clientId: CONFIG.clientId,
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    tokenType: "Bearer",
    expiresAt,
    scopes: ["openid", "profile", "email"],
  };
}

describe("auth service", () => {
  let savedAuthorization: StoredAuthorization | null;
  let savedConfig: CliConfig | null;
  let credentialStore: CredentialStore;
  let configStore: ConfigStore;
  let oauth: OAuthClient;
  let lock: string;

  beforeEach(async () => {
    savedAuthorization = null;
    savedConfig = null;
    credentialStore = {
      read: vi.fn(async () => savedAuthorization),
      write: vi.fn(async (value) => {
        savedAuthorization = value;
      }),
      delete: vi.fn(async () => {
        savedAuthorization = null;
      }),
    };
    configStore = {
      read: vi.fn(async () => savedConfig),
      write: vi.fn(async (value) => {
        savedConfig = value;
      }),
      delete: vi.fn(async () => {
        savedConfig = null;
      }),
    };
    oauth = {
      discover: vi.fn(async () => DISCOVERY),
      exchangeCode: vi.fn(async () => authorization(Date.now() + 3_600_000, "login")),
      refresh: vi.fn(async () => authorization(Date.now() + 3_600_000, "new")),
      userInfo: vi.fn(async () => ({ sub: "subject", email: "user@example.com" })),
      revoke: vi.fn(async () => undefined),
    };
    const directory = await mkdtemp(join(tmpdir(), "pep-cli-test-"));
    await mkdir(directory, { recursive: true });
    lock = join(directory, "authorization.lock");
  });

  it("logs in through localhost PKCE and stores the authorization", async () => {
    let launchedUrl = "";
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
      launchBrowser: vi.fn(async (url) => {
        launchedUrl = url;
      }),
      receiveCode: async ({ onListening }) => {
        await onListening();
        return "authorization-code";
      },
    });
    await expect(service.login(CONFIG)).resolves.toMatchObject({ accessToken: "access-login" });
    const parsed = new URL(launchedUrl);
    // ⚠ 这条断言钉的是「默认只申请这四个」。`skills:read` **刻意不在内** —— 默认清单里
    // 放一个客户端未获准的 scope，会让整个登录被 `invalid_scope` 拒掉（理由见 config.ts）。
    expect(parsed.searchParams.get("scope")).toBe("openid profile email docs:read");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(oauth.exchangeCode).toHaveBeenCalledWith(
      DISCOVERY,
      CONFIG,
      "authorization-code",
      expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
    );
    expect(savedConfig).toEqual(CONFIG);
    expect(savedAuthorization?.refreshToken).toBe("refresh-login");
  });

  it("refreshes near expiry and replaces both rotating tokens", async () => {
    savedAuthorization = authorization(Date.now() + 30_000);
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
    });
    await expect(service.currentAuthorization()).resolves.toMatchObject({
      accessToken: "access-new",
      refreshToken: "refresh-new",
    });
    expect(oauth.refresh).toHaveBeenCalledWith(
      DISCOVERY,
      expect.objectContaining({ refreshToken: "refresh-old" }),
    );
    expect(savedAuthorization?.refreshToken).toBe("refresh-new");
  });

  it("does not rotate a token that remains safely valid", async () => {
    savedAuthorization = authorization(Date.now() + 120_000);
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
    });
    await expect(service.currentAuthorization()).resolves.toBe(savedAuthorization);
    expect(oauth.refresh).not.toHaveBeenCalled();
  });

  it("removes local credentials even when remote revocation is unavailable", async () => {
    savedAuthorization = authorization(Date.now() + 120_000);
    vi.mocked(oauth.revoke).mockRejectedValueOnce(new Error("offline"));
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
    });
    const result = await service.logout();
    expect(result).toMatchObject({
      wasLoggedIn: true,
      revocationError: expect.objectContaining({ message: "offline" }),
    });
    expect(savedAuthorization).toBeNull();
  });

  // ⚠ 这两条钉的是一次真实的踩坑：`--resource urn:…:probe` 只在某一个环境登记过，它被存进
  // config 后跟着换到了另一个环境，下一次登录被 `/authorize` 回 `invalid_target` 拒掉 ——
  // 而那个错来自服务端，命令行上看不出是本地记着的参数在捣鬼。
  it("logout 清掉记住的 clientId / resources，下一次登录才是干净的", async () => {
    savedAuthorization = authorization(Date.now() + 120_000);
    savedConfig = {
      version: 1,
      issuer: "https://pep.example.com",
      clientId: "one-off-client",
      redirectUri: "http://localhost:53682/callback",
      resources: ["urn:newland:pep:docs", "urn:newland:pep:probe"],
    };
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
    });

    await service.logout();

    expect(savedConfig).toBeNull();
    expect(configStore.delete).toHaveBeenCalled();
  });

  it("本来就没登录时也清 —— 「退出」就该把本地状态归零", async () => {
    savedAuthorization = null;
    savedConfig = {
      version: 1,
      issuer: "https://pep.example.com",
      clientId: "one-off-client",
      redirectUri: "http://localhost:53682/callback",
      resources: ["urn:newland:pep:probe"],
    };
    const service = createAuthService({
      configStore,
      credentialStore,
      oauth,
      authorizationLockPath: lock,
    });

    const result = await service.logout();

    expect(result).toEqual({ wasLoggedIn: false });
    expect(savedConfig).toBeNull();
  });
});

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
    // `docs:read` 在默认 scope 里：取文档正文那条路的必要条件，少了它文档平台回 403。
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
});

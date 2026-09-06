import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  authorizationUrl,
  createOAuthClient,
  createPkce,
  discover,
  waitForAuthorizationCallback,
} from "./oauth-client.js";
import type { CliConfig, DiscoveryDocument } from "./types.js";

const ISSUER = "https://pep.example.com";
const CONFIG: CliConfig = {
  version: 1,
  issuer: ISSUER,
  clientId: "pep-cli",
  redirectUri: "http://localhost:53682/callback",
};
const DISCOVERY: DiscoveryDocument = {
  issuer: ISSUER,
  authorizationEndpoint: `${ISSUER}/api/oauth/authorize`,
  tokenEndpoint: `${ISSUER}/api/oauth/token`,
  revocationEndpoint: `${ISSUER}/api/oauth/revoke`,
  userinfoEndpoint: `${ISSUER}/api/oauth/userinfo`,
};

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function unusedLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not allocate test port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("OAuth protocol client", () => {
  it("creates an RFC 7636 S256 verifier and matching challenge", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
  });

  it("builds the authorization request with exact callback, state, scopes and PKCE", () => {
    const url = new URL(
      authorizationUrl({
        discovery: DISCOVERY,
        config: CONFIG,
        state: "state-value",
        challenge: "challenge-value",
        scopes: ["openid", "profile"],
      }),
    );
    expect(url.origin + url.pathname).toBe(DISCOVERY.authorizationEndpoint);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "pep-cli",
      redirect_uri: CONFIG.redirectUri,
      scope: "openid profile",
      state: "state-value",
      code_challenge: "challenge-value",
      code_challenge_method: "S256",
    });
  });

  // ── RFC 8707 受众 ────────────────────────────────────────────────────────
  // 不带 `resource` 签出来的令牌没有受众，资源服务器内省时一律 `{"active":false}`，且与
  // 「令牌不存在」不可区分 —— 从响应上看不出是少配了一个参数。所以这两条都要钉住。
  it("carries every configured resource, appended not collapsed", () => {
    const url = new URL(
      authorizationUrl({
        discovery: DISCOVERY,
        config: { ...CONFIG, resources: ["urn:newland:pep:docs", "urn:newland:pep:search"] },
        state: "state-value",
        challenge: "challenge-value",
        scopes: ["openid"],
      }),
    );
    // ⚠ `getAll`，不是 `get`：一个对象字面量只留得下同名键的最后一个，那会把「发给 A 和 B」
    // 静默截成「只发给 A」，客户端拿到一枚看起来正常、却在 B 那里用不了的令牌。
    expect(url.searchParams.getAll("resource")).toEqual([
      "urn:newland:pep:docs",
      "urn:newland:pep:search",
    ]);
  });

  it("omits resource entirely when none is configured", () => {
    const url = new URL(
      authorizationUrl({
        discovery: DISCOVERY,
        config: CONFIG,
        state: "state-value",
        challenge: "challenge-value",
        scopes: ["openid"],
      }),
    );
    // 缺省时不该发一个空的 `resource=` —— 空值与「没有受众」在服务端不是一回事。
    expect(url.searchParams.has("resource")).toBe(false);
  });

  it("accepts only discovery metadata for the configured issuer", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({
        issuer: ISSUER,
        authorization_endpoint: DISCOVERY.authorizationEndpoint,
        token_endpoint: DISCOVERY.tokenEndpoint,
        revocation_endpoint: DISCOVERY.revocationEndpoint,
        userinfo_endpoint: DISCOVERY.userinfoEndpoint,
      });
    });
    const fetcher = fetchMock as unknown as typeof fetch;
    await expect(discover(ISSUER, fetcher)).resolves.toEqual(DISCOVERY);
    expect(fetcher).toHaveBeenCalledWith(
      `${ISSUER}/.well-known/openid-configuration`,
      expect.objectContaining({ headers: { Accept: "application/json" }, redirect: "error" }),
    );
  });

  it("exchanges a code and preserves the rotating token response", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile",
      });
    });
    const fetcher = fetchMock as unknown as typeof fetch;
    const before = Date.now();
    const result = await createOAuthClient(fetcher).exchangeCode(
      DISCOVERY,
      CONFIG,
      "code",
      "verifier",
    );
    expect(result).toMatchObject({
      issuer: ISSUER,
      clientId: "pep-cli",
      accessToken: "access",
      refreshToken: "refresh",
      scopes: ["openid", "profile"],
    });
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 3_600_000);
    const request = fetchMock.mock.calls[0]![1]!;
    expect(String(request.body)).toContain("code_verifier=verifier");
    expect(String(request.body)).toContain("client_id=pep-cli");
  });

  it("surfaces an OAuth error description without exposing a token", async () => {
    const fetcher = vi.fn(async () =>
      jsonResponse(
        { error: "invalid_grant", error_description: "authorization code expired" },
        400,
      ),
    ) as unknown as typeof fetch;
    await expect(
      createOAuthClient(fetcher).exchangeCode(DISCOVERY, CONFIG, "expired-code", "verifier"),
    ).rejects.toThrow("authorization code expired");
  });

  it("keeps listening after a bad state and accepts the matching localhost callback", async () => {
    const port = await unusedLocalPort();
    const redirectUri = `http://localhost:${port}/callback`;
    let wrongStateStatus = 0;
    let validStateStatus = 0;
    let requestsDone = Promise.resolve();
    const code = await waitForAuthorizationCallback({
      redirectUri,
      state: "expected-state",
      timeoutMs: 5_000,
      onListening: () => {
        requestsDone = (async () => {
          wrongStateStatus = (await fetch(`${redirectUri}?state=wrong-state&code=attacker-code`))
            .status;
          validStateStatus = (
            await fetch(`${redirectUri}?state=expected-state&code=authorization-code`)
          ).status;
        })();
        return requestsDone;
      },
    });
    await requestsDone;
    expect(wrongStateStatus).toBe(400);
    expect(validStateStatus).toBe(200);
    expect(code).toBe("authorization-code");
  });
});

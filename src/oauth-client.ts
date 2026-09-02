import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import type { CliConfig, DiscoveryDocument, StoredAuthorization, UserInfo } from "./types.js";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15 * 1000;

type WireDiscovery = Record<string, unknown>;
type WireTokens = Record<string, unknown>;

export type OAuthClient = ReturnType<typeof createOAuthClient>;

function endpoint(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`Discovery document is missing ${name}.`);
  const url = new URL(value);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error(`Discovery ${name} is not a secure HTTP endpoint.`);
  }
  return url.toString();
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  const body = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(`${operation} returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${operation} returned malformed JSON.`);
  const record = parsed as Record<string, unknown>;
  if (!response.ok) {
    const description =
      typeof record.error_description === "string" ? record.error_description : undefined;
    const code = typeof record.error === "string" ? record.error : `HTTP ${response.status}`;
    throw new Error(`${operation} failed: ${description ?? code}`);
  }
  return record;
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function discover(
  issuer: string,
  fetcher: typeof fetch = fetch,
): Promise<DiscoveryDocument> {
  const response = await fetcher(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const body: WireDiscovery = await responseJson(response, "OAuth discovery");
  if (body.issuer !== issuer)
    throw new Error("Discovery issuer does not match the configured PEP issuer.");
  return {
    issuer,
    authorizationEndpoint: endpoint(body.authorization_endpoint, "authorization_endpoint"),
    tokenEndpoint: endpoint(body.token_endpoint, "token_endpoint"),
    revocationEndpoint: endpoint(body.revocation_endpoint, "revocation_endpoint"),
    userinfoEndpoint: endpoint(body.userinfo_endpoint, "userinfo_endpoint"),
  };
}

export function authorizationUrl(args: {
  discovery: DiscoveryDocument;
  config: CliConfig;
  state: string;
  challenge: string;
  scopes: readonly string[];
}): string {
  const url = new URL(args.discovery.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: args.config.clientId,
    redirect_uri: args.config.redirectUri,
    scope: args.scopes.join(" "),
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

function callbackHtml(isSuccess: boolean): string {
  const title = isSuccess ? "PEP login complete" : "PEP login failed";
  const message = isSuccess
    ? "You can close this window and return to the terminal."
    : "Return to the terminal for details.";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${message}</p></main></body></html>`;
}

export async function waitForAuthorizationCallback(args: {
  redirectUri: string;
  state: string;
  onListening: () => Promise<void>;
  timeoutMs?: number;
}): Promise<string> {
  const redirect = new URL(args.redirectUri);
  if (redirect.protocol !== "http:" || redirect.hostname !== "localhost" || !redirect.port) {
    throw new Error("CLI redirect URI must be an http://localhost URL with an explicit port.");
  }
  let server: Server | undefined;
  return new Promise<string>((resolve, reject) => {
    const finish = (error?: Error, code?: string) => {
      clearTimeout(timeout);
      server?.close();
      if (error) reject(error);
      else resolve(code!);
    };
    const timeout = setTimeout(
      () => finish(new Error("Login timed out while waiting for the browser callback.")),
      args.timeoutMs ?? CALLBACK_TIMEOUT_MS,
    );
    server = createServer((request, response) => {
      const current = new URL(request.url ?? "/", args.redirectUri);
      if (request.method !== "GET" || current.pathname !== redirect.pathname) {
        response.writeHead(404).end();
        return;
      }
      if (current.searchParams.get("state") !== args.state) {
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(callbackHtml(false));
        return;
      }
      const oauthError = current.searchParams.get("error");
      if (oauthError) {
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(callbackHtml(false));
        finish(
          new Error(
            `Authorization failed: ${current.searchParams.get("error_description") ?? oauthError}`,
          ),
        );
        return;
      }
      const code = current.searchParams.get("code");
      if (!code) {
        response
          .writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
          .end(callbackHtml(false));
        return;
      }
      response
        .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        .end(callbackHtml(true));
      finish(undefined, code);
    });
    server.once("error", (error) => finish(error));
    server.listen(Number(redirect.port), "localhost", () => {
      args.onListening().catch((error: unknown) => finish(error as Error));
    });
  });
}

export function openBrowser(url: string): Promise<void> {
  const command =
    process.platform === "win32"
      ? "rundll32.exe"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
  const commandArgs = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function parseTokens(body: WireTokens, config: CliConfig): StoredAuthorization {
  if (
    typeof body.access_token !== "string" ||
    typeof body.refresh_token !== "string" ||
    body.token_type !== "Bearer" ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0 ||
    typeof body.scope !== "string"
  ) {
    throw new Error("Token endpoint returned a malformed token response.");
  }
  return {
    version: 1,
    issuer: config.issuer,
    clientId: config.clientId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    tokenType: "Bearer",
    expiresAt: Date.now() + body.expires_in * 1000,
    scopes: body.scope.split(/\s+/).filter(Boolean),
  };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  operation: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams(form),
    redirect: "error",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  return responseJson(response, operation);
}

export function createOAuthClient(fetcher: typeof fetch = fetch) {
  return {
    discover: (issuer: string) => discover(issuer, fetcher),
    async exchangeCode(
      discovery: DiscoveryDocument,
      config: CliConfig,
      code: string,
      verifier: string,
    ) {
      const body = await postForm(
        discovery.tokenEndpoint,
        {
          grant_type: "authorization_code",
          client_id: config.clientId,
          code,
          redirect_uri: config.redirectUri,
          code_verifier: verifier,
        },
        "Authorization code exchange",
        fetcher,
      );
      return parseTokens(body, config);
    },
    async refresh(discovery: DiscoveryDocument, authorization: StoredAuthorization) {
      const config: CliConfig = {
        version: 1,
        issuer: authorization.issuer,
        clientId: authorization.clientId,
        redirectUri: "",
      };
      const body = await postForm(
        discovery.tokenEndpoint,
        {
          grant_type: "refresh_token",
          client_id: authorization.clientId,
          refresh_token: authorization.refreshToken,
        },
        "Token refresh",
        fetcher,
      );
      return parseTokens(body, config);
    },
    async userInfo(discovery: DiscoveryDocument, accessToken: string): Promise<UserInfo> {
      const response = await fetcher(discovery.userinfoEndpoint, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const body = await responseJson(response, "User info");
      if (typeof body.sub !== "string") throw new Error("User info response is missing sub.");
      return {
        sub: body.sub,
        ...(typeof body.email === "string" ? { email: body.email } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
      };
    },
    async revoke(discovery: DiscoveryDocument, authorization: StoredAuthorization): Promise<void> {
      const response = await fetcher(discovery.revocationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: authorization.clientId,
          token: authorization.refreshToken,
          token_type_hint: "refresh_token",
        }),
        redirect: "error",
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!response.ok) await responseJson(response, "Token revocation");
    },
  };
}

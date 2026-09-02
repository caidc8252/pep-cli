import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { DEFAULT_SCOPES, lockPath, normalizeIssuer } from "./config.js";
import {
  authorizationUrl,
  createPkce,
  openBrowser,
  waitForAuthorizationCallback,
  type OAuthClient,
} from "./oauth-client.js";
import type {
  CliConfig,
  ConfigStore,
  CredentialStore,
  StoredAuthorization,
  UserInfo,
} from "./types.js";

const REFRESH_EARLY_MS = 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 10 * 1000;

export type AuthServiceDependencies = {
  configStore: ConfigStore;
  credentialStore: CredentialStore;
  oauth: OAuthClient;
  launchBrowser?: (url: string) => Promise<void>;
  receiveCode?: typeof waitForAuthorizationCallback;
  now?: () => number;
  authorizationLockPath?: string;
};

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withAuthorizationLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      const handle = await open(path, "wx", 0o600);
      try {
        return await action();
      } finally {
        await handle.close();
        await unlink(path).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number;
      try {
        age = Date.now() - (await stat(path)).mtimeMs;
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      if (age > LOCK_STALE_MS) {
        await unlink(path).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt > LOCK_WAIT_MS)
        throw new Error("Another PEP authentication command is still running.");
      await delay(100);
    }
  }
}

export function createAuthService(dependencies: AuthServiceDependencies) {
  const now = dependencies.now ?? Date.now;

  async function requireAuthorization(): Promise<StoredAuthorization> {
    const authorization = await dependencies.credentialStore.read();
    if (!authorization) throw new Error("Not logged in. Run `pep auth login` first.");
    return authorization;
  }

  async function currentAuthorization(): Promise<StoredAuthorization> {
    return withAuthorizationLock(dependencies.authorizationLockPath ?? lockPath(), async () => {
      const authorization = await requireAuthorization();
      if (!authorization.scopes.includes("docs:read")) {
        throw new Error("Stored authorization does not contain the required docs:read scope.");
      }
      if (authorization.expiresAt - now() > REFRESH_EARLY_MS) return authorization;
      const discovery = await dependencies.oauth.discover(authorization.issuer);
      const refreshed = await dependencies.oauth.refresh(discovery, authorization);
      await dependencies.credentialStore.write(refreshed);
      return refreshed;
    });
  }

  return {
    async login(
      config: CliConfig,
      onAuthorizationUrl?: (url: string) => void,
    ): Promise<StoredAuthorization> {
      const normalized: CliConfig = { ...config, issuer: normalizeIssuer(config.issuer) };
      const discovery = await dependencies.oauth.discover(normalized.issuer);
      const state = createPkce().verifier;
      const pkce = createPkce();
      const url = authorizationUrl({
        discovery,
        config: normalized,
        state,
        challenge: pkce.challenge,
        scopes: DEFAULT_SCOPES,
      });
      const code = await (dependencies.receiveCode ?? waitForAuthorizationCallback)({
        redirectUri: normalized.redirectUri,
        state,
        onListening: async () => {
          onAuthorizationUrl?.(url);
          try {
            await (dependencies.launchBrowser ?? openBrowser)(url);
          } catch {
            // The URL was already printed. A missing browser launcher must not invalidate the OAuth attempt.
          }
        },
      });
      const authorization = await dependencies.oauth.exchangeCode(
        discovery,
        normalized,
        code,
        pkce.verifier,
      );
      if (!authorization.scopes.includes("docs:read")) {
        await dependencies.oauth.revoke(discovery, authorization).catch(() => undefined);
        throw new Error("PEP did not grant the required docs:read scope.");
      }
      const previous = await dependencies.credentialStore.read();
      await dependencies.credentialStore.write(authorization);
      await dependencies.configStore.write(normalized);
      if (previous) {
        try {
          const previousDiscovery = await dependencies.oauth.discover(previous.issuer);
          await dependencies.oauth.revoke(previousDiscovery, previous);
        } catch {
          // The new credential is already durable; failure to clean up the superseded family is non-fatal.
        }
      }
      return authorization;
    },
    currentAuthorization,
    async status(): Promise<{ authorization: StoredAuthorization; user: UserInfo }> {
      const authorization = await currentAuthorization();
      const discovery = await dependencies.oauth.discover(authorization.issuer);
      const user = await dependencies.oauth.userInfo(discovery, authorization.accessToken);
      return { authorization, user };
    },
    async logout(): Promise<{ wasLoggedIn: boolean; revocationError?: Error }> {
      return withAuthorizationLock(dependencies.authorizationLockPath ?? lockPath(), async () => {
        const authorization = await dependencies.credentialStore.read();
        if (!authorization) return { wasLoggedIn: false };
        let revocationError: Error | undefined;
        try {
          const discovery = await dependencies.oauth.discover(authorization.issuer);
          await dependencies.oauth.revoke(discovery, authorization);
        } catch (error) {
          revocationError = error as Error;
        } finally {
          await dependencies.credentialStore.delete();
        }
        return { wasLoggedIn: true, ...(revocationError ? { revocationError } : {}) };
      });
    },
  };
}

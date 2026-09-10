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
        // ⚠ **配置必须跟凭据一起清。**
        //
        // 2026-09-10 起 `issuer` / `clientId` / `resources` 不再被下一次 `login` 继承
        // （`cli.ts` 的 `loginConfig` 有完整理由），所以本行不再是「防止旧参数跟着换环境」
        // 那道防线 —— 那道防线已经移到源头了。留着它是因为另外两条：
        //   · `docsUrl` **仍然**会被沿用，退出登录理应把它也归零；
        //   · config.json 记着上次登录打的是哪个 issuer / 哪个 client，那是身份痕迹，
        //     `logout` 说的就是「把本地关于这个账号的东西清掉」。
        //
        // 放在早返回**之前**：本来就没登录时，「退出」也该把本地状态归零 —— 那正是操作员敲这
        // 个命令想要的，而残留一份配置只会让下一次登录继续带着旧参数。
        await dependencies.configStore.delete();
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

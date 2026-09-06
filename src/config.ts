import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig, ConfigStore } from "./types.js";

export const DEFAULT_CLIENT_ID = "1b916aae96f69a535d7a1a30c8f2e1dc";
export const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";
// `docs:read` 是取文档正文那条路的必要条件：文档平台先按它判「这个客户端可不可以问文档」，
// 没有就回 403 insufficient_scope。⚠ 它只是**客户端级**授权，不代表这个人能读某一篇 ——
// 逐篇权限由文档平台按内省回的身份自己判。
export const DEFAULT_SCOPES = ["openid", "profile", "email", "docs:read"] as const;

/**
 * 默认申请的受众（RFC 8707 的 `resource`）—— 这枚令牌准备拿去访问谁。
 *
 * 不带它签出来的令牌**没有受众**，文档平台内省时一律得到 `{"active":false}`，且与「令牌
 * 不存在」不可区分 —— 从响应上看不出是少配了一个参数。
 *
 * 与 `issuer` 不同，这里**不按构建环境分叉**：URN 是个名字不是地址，dev / staging / prod
 * 用的是同一个值。这正是平台选 URN 而不选 https 地址的理由 —— 后者换域名就等于换受众，
 * 存量令牌全部失配。
 */
export const DEFAULT_RESOURCES = ["urn:newland:pep:docs"] as const;

export type BuildEnvironment = "development" | "production";

declare const __PEP_BUILD_ENVIRONMENT__: BuildEnvironment | undefined;

export function issuerForEnvironment(environment: BuildEnvironment): string {
  return environment === "production"
    ? "https://pep.newlandnpt.us"
    : "https://pep-webapp-dev.onrender.com";
}

const BUILD_ENVIRONMENT: BuildEnvironment =
  typeof __PEP_BUILD_ENVIRONMENT__ === "undefined"
    ? "development"
    : __PEP_BUILD_ENVIRONMENT__;

export const DEFAULT_ISSUER = issuerForEnvironment(BUILD_ENVIRONMENT);

export function configuredIssuer(explicitIssuer: string | undefined): string {
  return explicitIssuer ?? DEFAULT_ISSUER;
}

function configDirectory(): string {
  if (process.platform === "win32") return join(homedir(), "AppData", "Roaming", "PEP");
  return join(homedir(), ".config", "pep");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function lockPath(): string {
  return join(configDirectory(), "credentials.lock");
}

function isCliConfig(value: unknown): value is CliConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.issuer === "string" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.redirectUri === "string" &&
    // 可选：v0.1.0 写下的配置文件没有这个键，读它们不该报「配置损坏」。
    (candidate.resources === undefined ||
      (Array.isArray(candidate.resources) &&
        candidate.resources.every((one) => typeof one === "string")))
  );
}

export function fileConfigStore(path = configPath()): ConfigStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isCliConfig(parsed)) throw new Error(`PEP CLI config is malformed: ${path}`);
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(config) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

export function normalizeIssuer(raw: string): string {
  const url = new URL(raw);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Issuer must use HTTPS (HTTP is allowed only for a local PEP server).");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

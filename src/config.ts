import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig, ConfigStore, SkillsState, SkillsStateStore } from "./types.js";

export const DEFAULT_CLIENT_ID = "1b916aae96f69a535d7a1a30c8f2e1dc";
export const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";
// `docs:read` 是取文档正文那条路的必要条件：文档平台先按它判「这个客户端可不可以问文档」，
// 没有就回 403 insufficient_scope。⚠ 它只是**客户端级**授权，不代表这个人能读某一篇 ——
// 逐篇权限由文档平台按内省回的身份自己判。
// `docs:read` 是取文档正文那条路的必要条件：文档平台先按它判「这个客户端可不可以问文档」，
// 没有就回 403 insufficient_scope。
//
// ⚠ **`skills:read` 故意不在这里**（`pep skills sync` 需要它）。默认清单里放一个客户端
// 未获准的 scope，代价不是「那个功能用不了」，而是**整个登录失败**：PEP 的 `/authorize`
// 对超出 `allowed_scopes` 的请求回 `invalid_scope` 并直接重定向回调，浏览器都不会打开。
// 于是一个只想读文档的人，会因为一个他根本用不到的能力而登不进去 —— 而错误来自服务端，
// 命令行上看不出是默认清单在捣鬼。真事，栽过一次。
//
// 要用 skills 的话：先在 PEP 那侧把 `skills:read` 加进该客户端的 `allowed_scopes`，
// 再把它加回这个数组。⚠ 存量令牌不会自动获得新 scope，加完得重新 `pep auth login`。
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

export function skillsStatePath(): string {
  return join(configDirectory(), "skills.json");
}

/**
 * `pep skills sync` 的默认落点。
 *
 * **个人级而不是项目级**：本仓这类项目把自己的 `.claude/skills/` 提交进版本库，往那儿写会和
 * 项目自己管着的 skill 撞在同一个目录里 —— 同步下来的算不算改动、要不要 gitignore，每个项目
 * 都得单独回答一遍。写个人级没有这个问题，一次同步这台机器上所有项目都看得见。
 *
 * ⚠ 路径在三个平台上是同一个 —— `~/.claude` 是 Claude Code 自己的约定，不随平台变；
 * 本 CLI 自己的配置目录才按平台分叉（见 `configDirectory`）。
 */
export function defaultSkillsDirectory(): string {
  return join(homedir(), ".claude", "skills");
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
        candidate.resources.every((one) => typeof one === "string"))) &&
    (candidate.docsUrl === undefined || typeof candidate.docsUrl === "string")
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
    async delete() {
      // 本来就没有 = 已经是想要的状态，不是错误。
      await rm(path, { force: true });
    },
  };
}

function isSkillsState(value: unknown): value is SkillsState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.directory === "string" &&
    Array.isArray(candidate.skills) &&
    candidate.skills.every((one) => typeof one === "string") &&
    (candidate.commit === undefined || typeof candidate.commit === "string")
  );
}

export function fileSkillsStateStore(path = skillsStatePath()): SkillsStateStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        // 账坏了不该让同步停摆 —— 当成「没同步过」重来一遍即可，代价只是多写一次盘。
        // 这跟 config 不同：那个坏了就登不上，必须让人看见。
        return isSkillsState(parsed) ? parsed : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (error instanceof SyntaxError) return null;
        throw error;
      }
    },
    async write(state) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

/**
 * 文档平台地址的规范化。
 *
 * 直接复用 `normalizeIssuer` 是有意的：两者的要求一字不差 —— 必须 HTTPS（本地服务才允许
 * HTTP）、剥掉尾斜杠与查询/片段。它本质上是「一个可信的基地址」的规范化，只是先给 issuer
 * 用上了。写第二份实现只会让两处慢慢分叉。
 */
export function normalizeDocsUrl(raw: string): string {
  return normalizeIssuer(raw);
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

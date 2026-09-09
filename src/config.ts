import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig, ConfigStore, SkillsState, SkillsStateStore } from "./types.js";

/**
 * CLI 的 client_id。**一个名字，所有环境通用** —— 与 issuer 不同，它不按构建环境分叉。
 *
 * 这是 2026-09-09 的改法，替掉了「每个环境一枚平台生成的随机十六进制串」。旧办法有两个毛病：
 *
 * ① **多了一个可配错的维度**：issuer 三档、client_id 三档，两者必须同档。2026-09-08 差点
 *    发出去一版「view 的地址 + dev 的客户端」，`/authorize` 回 400 且不带任何解释，看着像
 *    CLI 坏了。改成固定名字之后这个配对根本不存在 —— 没有第二个维度可配错。
 * ② **鸡生蛋**：随机串由平台在登记时生成，于是「生产还没上线 → 登记不了客户端 → 拿不到
 *    client_id → 烘不进 CLI → 发不了包」。而 client_id 只要求在该部署内唯一，并不要求由
 *    平台生成（`app.oauth_client.client_id` 是 varchar(64) 唯一键，随机只是登记台的习惯）。
 *    我们自己定一个名字，顺序就反过来：先发包，各环境照这个名字登记即可。
 *
 * 它**不是秘密**（每次授权都出现在浏览器地址栏里），且本客户端是 public 客户端、靠 PKCE
 * 保护，所以取个可读的名字没有安全代价。
 *
 * ⚠ 代价是**每个部署都得有一枚叫这个名字的客户端**：dev / view / 生产各登记一次。
 * 缺哪个环境，打那个环境时 `/authorize` 回 400（客户端不存在）。
 */
export const DEFAULT_CLIENT_ID = "pep-cli";
export const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";
// `docs:read` 是取文档正文那条路的必要条件：文档平台先按它判「这个客户端可不可以问文档」，
// 没有就回 403 insufficient_scope。⚠ 它只是**客户端级**授权，不代表这个人能读某一篇 ——
// 逐篇权限由文档平台按内省回的身份自己判。
// `docs:read` 是取文档正文那条路的必要条件：文档平台先按它判「这个客户端可不可以问文档」，
// 没有就回 403 insufficient_scope。
//
// `skills:read` 是 `pep skills sync` 的必要条件。
//
// ⚠ **它必须在每个环境的客户端 `allowed_scopes` 里都存在。** 默认清单里放一个客户端未获准
// 的 scope，代价不是「那个功能用不了」，而是**整个登录失败**：PEP 的 `/authorize` 对超出
// `allowed_scopes` 的请求回 `invalid_scope` 并直接重定向回调，浏览器都不会打开。于是一个
// 只想读文档的人，会因为一个他根本用不到的能力而登不进去 —— 而错误来自服务端，命令行上
// 看不出是默认清单在捣鬼。2026-09-07 栽过一次，只能退回上一个提交重新构建。
//
// 所以**新登记一枚客户端时，这两个业务 scope 要一起给**；给旧客户端加 scope 之后，存量
// 令牌不会自动获得它，用户得重新 `pep auth login`。
export const DEFAULT_SCOPES = ["openid", "profile", "email", "docs:read", "skills:read"] as const;

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

export type BuildEnvironment = "development" | "view" | "production";

declare const __PEP_BUILD_ENVIRONMENT__: BuildEnvironment | undefined;

/**
 * 构建环境 → issuer。**issuer 在构建期固化**，`--issuer` 只是覆盖（会被记住，见
 * `configuredIssuer`），所以这个默认值决定了绝大多数用户实际打到哪里。
 *
 * **发布到 npm 的那一版走 `production`**（见 package.json 的 `prepack`）—— 与 Stripe 一类
 * 客户端同一口径：包里只内置生产地址，内部环境靠参数指过去。这样地址变更不需要重发包。
 *
 * ⚠ **2026-09-09 实测生产上还没有授权服务器**：`https://pep.newlandnpt.us` 站点本身活着
 * （307），但 `/.well-known/openid-configuration`、`/api/oauth/openid-configuration`、
 * `/api/oauth/jwks` 全部 **404**，而 view 上同一条路径 200。`DISCOVERY` 这个 handler 不看
 * 任何配置，所以那不是缺配置，是生产跑的构建里根本没有授权服务器模块。
 * ⇒ 在生产补上之前，**默认的 `pep auth login` 会在 discovery 那一步失败**；演示要带
 * `--issuer https://pep-webapp-view.onrender.com`（带一次就记住了）。
 * 这是操作员 2026-09-09 的明确取舍：宁可现在烘对的地址、等生产补齐，也不要为了当下能跑
 * 而烘一个将来必须重发包才能改掉的测试地址。
 */
export function issuerForEnvironment(environment: BuildEnvironment): string {
  if (environment === "production") return "https://pep.newlandnpt.us";
  if (environment === "view") return "https://pep-webapp-view.onrender.com";
  return "https://pep-webapp-dev.onrender.com";
}

const BUILD_ENVIRONMENT: BuildEnvironment =
  typeof __PEP_BUILD_ENVIRONMENT__ === "undefined"
    ? "development"
    : __PEP_BUILD_ENVIRONMENT__;

export const DEFAULT_ISSUER = issuerForEnvironment(BUILD_ENVIRONMENT);

/**
 * 本次 `login` 打哪个 issuer：显式 `--issuer` > 上次登录记住的 > 构建期烘进去的。
 *
 * **中间那一档是 2026-09-09 补的**，此前 `--issuer` 每次都要重新带。补它的直接理由：包里
 * 烘的是生产地址，而生产上授权服务器还没部署（实测 discovery 404），所以在生产补上之前，
 * 演示要靠 `--issuer` 指到 view。若不记住，用户此后**每一条** `login` 都得重复带这个参数，
 * 忘一次就静默打回生产、在 discovery 那步失败，而报错看起来像 CLI 坏了。
 *
 * 与 `clientId` / `resources` 同一口径（都是「显式 > 记住 > 内置」），此前 issuer 是三者中
 * 唯一不记的那个 —— 那个不对称本身就是个坑。
 */
export function configuredIssuer(
  explicitIssuer: string | undefined,
  savedIssuer?: string | undefined,
): string {
  return explicitIssuer ?? savedIssuer ?? DEFAULT_ISSUER;
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

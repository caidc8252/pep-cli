import { cp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { readTar, type TarEntry } from "./tar.js";
import type { SkillsState, SkillsStateStore } from "./types.js";

const ARCHIVE_PATH = "/api/skills/archive";
/** 归档里 skill 所在的子目录。PEP 已经按它收窄过，这里再剥一次是为了不依赖那个约定。 */
const SKILLS_SEGMENT = "skills";

/** 摊平后的一个文件：属于哪个 skill、在它目录里的相对路径。 */
export type SkillFile = { skill: string; path: string; data: Uint8Array };

export type SkillsSyncResult =
  | { status: "unchanged"; commit: string }
  | {
      status: "written";
      commit?: string;
      skills: string[];
      fileCount: number;
      removed: string[];
      directory: string;
      /** 接进了哪个 agent 目录（`--dir` 显式指定时不接，为 undefined）。 */
      linkedInto?: string;
      /** 有多少个是复制而不是链接过去的 —— 建链接失败时的降级，如实汇报。 */
      copiedCount?: number;
    };

/**
 * 归档条目 → 「哪个 skill 的哪个文件」。纯函数。
 *
 * 要剥两层：
 *   1. 归档根 `<项目>-<ref>-<sha>/` —— 每次都不一样（带 sha），留着的话每同步一次就多一个目录。
 *   2. `skills/` —— PEP 传了 `?path=skills`，GitLab 会把它保留在路径里。
 *      判断「在不在」而不是硬剥，这样上游哪天改了打包范围，这里不会静默把 skill 名字当成它。
 *
 * ⚠ 段级白名单挡的是 tar-slip：归档里一条 `../../.ssh/authorized_keys` 会让写盘跳出目标目录。
 * 归档来自我们自己的 PEP + 自己的 GitLab，所以这不是常规情况 —— 是**信号**，因此抛而不是跳过。
 */
export function planSkillFiles(entries: readonly TarEntry[]): SkillFile[] {
  const files: SkillFile[] = [];
  for (const entry of entries) {
    const segments = entry.path
      .split("/")
      .filter((one) => one !== "" && one !== ".");
    if (segments.some((one) => one === "..")) {
      throw new Error(
        `Refusing an archive entry that escapes its directory: ${entry.path}`,
      );
    }
    const withoutRoot = segments.slice(1);
    const relative =
      withoutRoot[0] === SKILLS_SEGMENT ? withoutRoot.slice(1) : withoutRoot;
    // 少于两段 = 不在任何 skill 目录里（归档根下的散文件），不属于同步范围。
    if (relative.length < 2) continue;
    files.push({
      skill: relative[0],
      path: relative.slice(1).join("/"),
      data: entry.data,
    });
  }
  return files;
}

export type SkillsSyncDependencies = {
  issuer: string;
  accessToken: string;
  /** canonical 落点。默认 `~/.agents/skills`（22 家 agent 共读的通用目录）。 */
  directory: string;
  /**
   * 铺完之后再接进哪个 agent 目录（默认 `~/.claude/skills` —— 只有 Claude Code 不读通用目录）。
   * `undefined` = 调用方给了 `--dir`，那时只铺一份、不接任何链接。
   */
  linkInto?: string;
  stateStore: SkillsStateStore;
  fetch?: typeof globalThis.fetch;
};

/** 把 HTTP 状态翻成「你该做什么」。PEP 那侧四种上游故障已经收敛成一个 503。 */
function describeFailure(status: number): string {
  if (status === 401)
    return "PEP rejected the access token. Run `pep auth login` again.";
  if (status === 403) {
    // 这个 CLI 的 `DEFAULT_SCOPES` **含** `skills:read`，所以令牌里没有它只有一个成因：
    // 这枚客户端在 PEP 那侧的 `allowed_scopes` 里没获准。⚠ 措辞必须指向那一侧 ——
    // 早先这句写的是「加进 DEFAULT_SCOPES」，那是 CLI 曾经不申请它时的说法，现在会把人
    // 指错方向（去改一个已经对了的地方）。
    return "This access token carries no `skills:read` scope. Ask an operator to add it to this client's allowed_scopes in PEP, then run `pep auth login` again — existing tokens do not gain new scopes.";
  }
  if (status === 404) {
    // ⚠ 单独一句，不能落到兜底的 `PEP answered 404.`。那句话意思没错，但它不会告诉你
    // 「这个部署压根没有这个端点」—— 而那正是最常见的 404 成因（端点还没部署上去）。
    // 说不清的话，使用者只会以为 CLI 坏了，然后开始重试。
    return "This PEP deployment does not serve skills — it has no /api/skills/archive endpoint. Ask an operator whether skills are enabled here.";
  }
  if (status === 503) {
    return "PEP could not reach the skills repository. Retry shortly, or ask an operator whether this deployment serves skills.";
  }
  return `PEP answered ${status}.`;
}

/**
 * 把 canonical 目录里的一个 skill 接到某个 agent 的 skills 目录下。
 *
 * ── 为什么是「一份实体 + 链接」而不是各写一份 ─────────────────────────────────
 * `~/.agents/skills` 是**通用约定**：Codex / Cursor / Amp / Antigravity 等 22 家 agent 直接
 * 读它。只有 Claude Code 坚持自己的 `~/.claude/skills`，所以只需要给它接一条链，一次同步
 * 就覆盖了 23 家 —— 而不是维护一张「每家 agent 的目录」的表（上游 `skills` 包里那张有 79 项，
 * 且每家自己在改）。更新也只动 canonical 那一份。
 *
 * ── Windows 用 junction，不是 symlink ────────────────────────────────────────
 * 真符号链接在 Windows 上要开发者模式或管理员权限；**目录联接（junction）普通用户就能建**。
 * 代价是 junction 只能指目录、只能指本地卷 —— 对「一个 skill 一个目录」这个形状正好够用。
 * junction 还要求**绝对**目标路径，所以两条分支的 target 不同。
 *
 * ── 相对目标要按**物理**位置算，不是逻辑路径 ─────────────────────────────────
 * 相对符号链接由操作系统从**链接自己所在的真实目录**解析。若 `~/.claude` 本身是一条软链
 * （macOS 上有人把它挪到 iCloud / 外置卷；`/tmp` → `/private/tmp` 也是这形状），按逻辑路径
 * 算出的 `../../.agents/...` 会从那个真实目录往上跳，落到完全不相干的地方 —— **建出来是
 * 一条死链**，而 `symlink()` 本身不会报错（它不检查目标存不存在）。
 * 所以先把链接目录的父级 realpath 掉再算相对。2026-09-11 真实复现过一次。
 *
 * ── 建不成就复制，不报错 ─────────────────────────────────────────────────────
 * 跨卷、文件系统不支持、权限被策略卡住 —— 这些都不该让整次同步失败。复制出来的东西照样能
 * 用，只是下次同步要重新复制一遍。回值告诉调用方走了哪条路，让它能如实汇报。
 */
/**
 * 目录的物理路径：父级 realpath 掉、basename 拼回去。
 *
 * 不整条 realpath 的理由：`linkPath` 自己可能还不存在（我们正要创建它），realpath 会 ENOENT。
 * 取不到就退回逻辑路径 —— 那至少是原来的行为，不会更糟。
 */
async function physicalDir(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return join(await realpath(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

async function linkSkill(
  canonicalSkillDir: string,
  linkPath: string,
): Promise<"linked" | "copied"> {
  await rm(linkPath, { recursive: true, force: true });
  const linkDir = dirname(linkPath);
  await mkdir(linkDir, { recursive: true });
  try {
    const junction = platform() === "win32";
    await symlink(
      junction ? canonicalSkillDir : relative(await physicalDir(linkDir), canonicalSkillDir),
      linkPath,
      junction ? "junction" : undefined,
    );
    return "linked";
  } catch {
    await cp(canonicalSkillDir, linkPath, { recursive: true });
    return "copied";
  }
}

/**
 * 取最新一版 skills 并铺到本地目录。
 *
 * ⚠ **只动自己写过的东西**。目标目录里可能有用户自己放的 skill —— 整个目录清空重来会把它们
 * 一起删掉。所以：要写的那几个各自先删再写（保证上游删掉的文件本地也消失），上一次写过、
 * 这次不在清单里的才移除，其余一概不碰。「上一次写过谁」记在 `skills.json` 里。
 */
export async function syncSkills(
  dependencies: SkillsSyncDependencies,
): Promise<SkillsSyncResult> {
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const response = await doFetch(`${dependencies.issuer}${ARCHIVE_PATH}`, {
    headers: { Authorization: `Bearer ${dependencies.accessToken}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(describeFailure(response.status));
  }

  const commit = response.headers.get("x-skills-commit") ?? undefined;
  const previous = await dependencies.stateStore.read();
  if (
    commit !== undefined &&
    commit === previous?.commit &&
    previous.directory === dependencies.directory
  ) {
    // 已经是这一版了。体还没读完就掐掉，省下传输 —— 这是个半吊子的省法，真要省该是
    // 条件请求（CLI 带 If-None-Match、PEP 答 304），但 PEP 那侧还没做。
    await response.body?.cancel();
    return { status: "unchanged", commit };
  }

  const gzipped = new Uint8Array(await response.arrayBuffer());
  const files = planSkillFiles(readTar(gunzipSync(gzipped)));
  const skills = [...new Set(files.map((file) => file.skill))].sort();

  // 先删后写：上游删掉的文件，本地跟着消失。范围严格限定在这次要写的这几个 skill 目录。
  for (const skill of skills) {
    await rm(join(dependencies.directory, skill), {
      recursive: true,
      force: true,
    });
  }
  for (const file of files) {
    const target = join(
      dependencies.directory,
      file.skill,
      ...file.path.split("/"),
    );
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }

  // 接进 agent 目录。`linkInto` 为空 = 调用方显式指定了 `--dir`，那时只铺一份、不接。
  let copiedCount = 0;
  if (dependencies.linkInto !== undefined) {
    for (const skill of skills) {
      const how = await linkSkill(
        join(dependencies.directory, skill),
        join(dependencies.linkInto, skill),
      );
      if (how === "copied") copiedCount += 1;
    }
  }

  // 上次写过、这次没有了的，移除。**只移除记在账上的** —— 用户自己放的 skill 不归我们管。
  // canonical 与链接两处都要清：只清一边会留下一条指向空处的死链（或一份永不更新的副本）。
  const removed = (previous?.skills ?? []).filter(
    (skill) => !skills.includes(skill),
  );
  for (const skill of removed) {
    await rm(join(previous?.directory ?? dependencies.directory, skill), {
      recursive: true,
      force: true,
    });
    if (previous?.linkedInto !== undefined) {
      await rm(join(previous.linkedInto, skill), { recursive: true, force: true });
    }
  }

  const state: SkillsState = {
    version: 1,
    skills,
    directory: dependencies.directory,
    ...(dependencies.linkInto !== undefined ? { linkedInto: dependencies.linkInto } : {}),
    ...(commit ? { commit } : {}),
  };
  await dependencies.stateStore.write(state);

  return {
    status: "written",
    skills,
    fileCount: files.length,
    removed,
    directory: dependencies.directory,
    ...(dependencies.linkInto !== undefined ? { linkedInto: dependencies.linkInto } : {}),
    ...(copiedCount > 0 ? { copiedCount } : {}),
    ...(commit ? { commit } : {}),
  };
}

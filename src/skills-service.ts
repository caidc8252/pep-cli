import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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
    const segments = entry.path.split("/").filter((one) => one !== "" && one !== ".");
    if (segments.some((one) => one === "..")) {
      throw new Error(`Refusing an archive entry that escapes its directory: ${entry.path}`);
    }
    const withoutRoot = segments.slice(1);
    const relative = withoutRoot[0] === SKILLS_SEGMENT ? withoutRoot.slice(1) : withoutRoot;
    // 少于两段 = 不在任何 skill 目录里（归档根下的散文件），不属于同步范围。
    if (relative.length < 2) continue;
    files.push({ skill: relative[0], path: relative.slice(1).join("/"), data: entry.data });
  }
  return files;
}

export type SkillsSyncDependencies = {
  issuer: string;
  accessToken: string;
  directory: string;
  stateStore: SkillsStateStore;
  fetch?: typeof globalThis.fetch;
};

/** 把 HTTP 状态翻成「你该做什么」。PEP 那侧四种上游故障已经收敛成一个 503。 */
function describeFailure(status: number): string {
  if (status === 401) return "PEP rejected the access token. Run `pep auth login` again.";
  if (status === 403) {
    // 两种成因，说全 —— 这个 CLI 默认**不申请** `skills:read`（理由见 config.ts），
    // 所以最常见的一种是「令牌里压根没有它」，而不是「PEP 不给」。
    return "This access token carries no `skills:read` scope. Add it to DEFAULT_SCOPES (and to this client's allowed_scopes in PEP), then run `pep auth login` again.";
  }
  if (status === 503) {
    return "PEP could not reach the skills repository. Retry shortly, or ask an operator whether this deployment serves skills.";
  }
  return `PEP answered ${status}.`;
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
    await rm(join(dependencies.directory, skill), { recursive: true, force: true });
  }
  for (const file of files) {
    const target = join(dependencies.directory, file.skill, ...file.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.data);
  }

  // 上次写过、这次没有了的，移除。**只移除记在账上的** —— 用户自己放的 skill 不归我们管。
  const removed = (previous?.skills ?? []).filter((skill) => !skills.includes(skill));
  for (const skill of removed) {
    await rm(join(previous?.directory ?? dependencies.directory, skill), {
      recursive: true,
      force: true,
    });
  }

  const state: SkillsState = {
    version: 1,
    skills,
    directory: dependencies.directory,
    ...(commit ? { commit } : {}),
  };
  await dependencies.stateStore.write(state);

  return {
    status: "written",
    skills,
    fileCount: files.length,
    removed,
    directory: dependencies.directory,
    ...(commit ? { commit } : {}),
  };
}

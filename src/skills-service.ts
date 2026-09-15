import { cp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readTar, type TarEntry } from "./tar.js";
import { samePlace } from "./config.js";
import type { SkillsPackageState, SkillsStateStore } from "./types.js";

const ARCHIVE_PATH = "/api/skills/archive";

// ── 归档的三道上限 ──────────────────────────────────────────────────────────
// ⚠ 没有上限的话，一个几 MB 的 gzip 炸弹能解出几十 GB，把用户机器的内存打爆。威胁模型与
// tar-slip 那条相同：`skills add` 收的是那台 GitLab 上的**任意**仓，任何内网用户都建得出。
// `npx skills` 也有这三道（10 MiB / 25 MiB / 1000 个，可用环境变量放宽）。
//
// 我们取的数比它松：这里取的是**整仓**归档（PEP 那侧不再按 path 收窄），正常仓本来就更大。
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 10_000;

function tooBig(what: string, limit: number): Error {
  return new Error(
    `The skills archive is too large (${what} exceeds ${Math.round(limit / 1024 / 1024)} MiB). ` +
      `Refusing to unpack it.`,
  );
}

/** 认一个 skill 的凭据。**目录里有这个文件就是一个 skill，没有就不是** —— 见 `planSkillFiles`。 */
const SKILL_MANIFEST = "SKILL.md";

/** 摊平后的一个文件：属于哪个 skill、在它目录里的相对路径。 */
export type SkillFile = { skill: string; path: string; data: Uint8Array };

/**
 * 「这个 skill 名，账上还有**别的包**也占着」。
 *
 * skill 名就是落盘的目录名（`<canonical>/<skill 名>/`），所以同一个目录下两个包给出同名
 * skill 时，后写的会盖掉先写的 —— 与包内同名是同一件事，见 `planSkillFiles` 的那段注释。
 */
export type SkillConflict = { skill: string; owner: string };

export type SkillsUpdateResult =
  /** 仓库提交没变，连包都没下 —— 体在读完之前就掐了。 */
  | { status: "unchanged"; name: string; commit: string; conflicts: SkillConflict[] }
  | {
      status: "written";
      name: string;
      /** 内容真的变了的那些（含新增）。**这才是用户要看的**。 */
      updated: string[];
      /** 取下来了但内容与上次一字不差的那些 —— 仓里动了别处（README / evals）时就是这一档。 */
      unchanged: string[];
      commit?: string;
      skills: string[];
      fileCount: number;
      removed: string[];
      /** 账上有、盘上已被用户删掉，因而这次**没去碰**的那些（只有 `update` 会有）。 */
      skipped: string[];
      /** 与别的包撞了名字的那些 —— **存量**才到这儿，新撞的直接抛。 */
      conflicts: SkillConflict[];
      directory: string;
      /** 接进了哪个 agent 目录（`--dir` 显式指定时不接，为 undefined）。 */
      linkedInto?: string;
      /** 有多少个是复制而不是链接过去的 —— 建链接失败时的降级，如实汇报。 */
      copiedCount?: number;
    };

/**
 * 归档条目 → 「哪个 skill 的哪个文件」。纯函数。
 *
 * ── 靠找 `SKILL.md` 定位，不按层级猜（2026-09-14 改）────────────────────────────
 * 规则一句话：**凡是直接含 `SKILL.md` 的目录，就是一个 skill**，它自己的名字就是 skill 名，
 * 它底下的一切原样跟着走。仓里其余东西（`evals/`、`README.md`、CI 配置）没有 `SKILL.md`，
 * 自然落不进来。
 *
 * ⚠ 此前是「剥掉归档根，再剥掉一段字面量 `skills`，剩下第一段当 skill 名」。那套要求上游
 * 仓长成 `skills/<名字>/SKILL.md`，于是 PEP 那侧不得不加一个 `path` 去收窄归档 —— 而那个
 * 参数有**两种互相矛盾的语义**（填 `skills` 时它指容器，填别的时它指 skill 自己），指错一层
 * 是**静默**失败：同步报成功、文件全部深一层、agent 找不到 `SKILL.md`。现在两边都不需要了：
 * PEP 整仓取、这里自己找。
 *
 * ⚠ **只认直接子级的 `SKILL.md`**：`a/SKILL.md` 让 `a` 成为 skill，而 `a/b/SKILL.md` 让 `b`
 * 成为 skill。两者同时存在时各算各的，互不吞并 —— 嵌套是上游的自由，不该由这里替它裁决。
 *
 * ⚠ 段级白名单挡的是 tar-slip：归档里一条 `../../.ssh/authorized_keys` 会让写盘跳出目标目录。
 * 归档来自我们自己的 PEP + 自己的 GitLab，所以这不是常规情况 —— 是**信号**，因此抛而不是跳过。
 */
export function planSkillFiles(entries: readonly TarEntry[]): SkillFile[] {
  // 先扫一遍，把「哪些目录是 skill」定下来 —— 一个文件属不属于某个 skill，取决于它上方有没有
  // 一层 `SKILL.md`，而那一层可能排在它后面，所以不能边走边判。
  const roots: string[][] = [];
  for (const entry of entries) {
    const segments = segmentsOf(entry.path);
    if (segments.at(-1) !== SKILL_MANIFEST) continue;
    const root = segments.slice(0, -1);
    // 归档根自己带 `SKILL.md`（整个仓就是一个 skill）时没有名字可用 —— 跳过而不是拿归档根
    // 那个带 sha 的目录名当 skill 名，那个名字每次同步都不一样。
    if (root.length < 2) continue;
    roots.push(root);
  }

  // ⚠ **同名必须抛，不能让后写的盖掉先写的。** skill 名就是目录名，而落盘是
  // `<canonical>/<skill 名>/...` —— 两个不同位置的 `docs/SKILL.md` 会挤进同一个目录，
  // 表现是「装上了，但内容是两个 skill 混起来的、且每次同步取决于归档顺序」。那是静默的，
  // 而这条链路上游是我们自己的 PEP + 自己的 GitLab：重名是上游写错了，该在那边改，
  // 不该由这里挑一个赢家。与 tar-slip 同一口径 —— 不是常规情况，是**信号**。
  // ⚠ 键用小写：win32 / darwin 的文件系统默认不区分大小写，`Docs/` 与 `docs/` 在盘上
  // 是同一个目录。精确比较会放它们过去，然后静默互相覆盖。
  const seen = new Map<string, string>();
  for (const root of roots) {
    const name = root[root.length - 1] as string;
    const where = root.join("/");
    // ⚠ 按**小写**查重，落盘仍用原名。win32 / darwin 的文件系统默认不区分大小写，
    // `Docs/` 与 `docs/` 在盘上是同一个目录 —— 精确比较会放它们过去，然后静默互相覆盖。
    const first = seen.get(name.toLowerCase());
    if (first !== undefined) {
      throw new Error(
        `Two skills in this package would both be called "${name}": ${first} and ${where}. ` +
          `Skill names come from the directory name, so they must be unique within a package.`,
      );
    }
    seen.set(name.toLowerCase(), where);
  }

  const files: SkillFile[] = [];
  for (const entry of entries) {
    const segments = segmentsOf(entry.path);
    // 最深的那个 root 优先：`a/b/SKILL.md` 存在时，`a/b/x` 归 `b` 而不是归 `a`。
    const root = roots
      .filter((r) => r.length < segments.length && r.every((seg, i) => segments[i] === seg))
      .sort((x, y) => y.length - x.length)[0];
    if (!root) continue;
    files.push({
      skill: root[root.length - 1],
      path: segments.slice(root.length).join("/"),
      data: entry.data,
    });
  }
  return files;
}

/**
 * 边读边计数，超了就断开。
 *
 * ⚠ 不能只在 `arrayBuffer()` 之后判大小 —— 那时字节已经全在内存里了，上限等于没设。
 * 也不能指望 `content-length`：PEP 那侧是**流式转发**的，它另建了一份响应头，压根不带这条
 * （2026-09-15 核对 `skills.controller.ts`）。所以唯一真正管用的是自己数。
 */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  /* v8 ignore next -- 上游 !response.ok 已提前返回，能到这儿的响应必有体 */
  if (!reader) return new Uint8Array(await response.arrayBuffer());
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw tooBig("the download", limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** 算出来的落点必须仍在目标目录之内。跑出去就抛 —— 见调用点。 */
export function assertInside(base: string, target: string): void {
  const rel = relative(resolve(base), resolve(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Refusing an archive entry that escapes its directory: ${target}`);
  }
}

/**
 * 路径切段并挡掉 tar-slip。空段与 `.` 丢掉，`..` 抛。
 *
 * ⚠ **必须按 `/` 和 `\` 一起切。** 只切 `/` 的话，`..\..\evil` 会作为**一整段**通过
 * `..` 检查 —— 而 win32 的 `path.join` 把 `\` 当分隔符，于是它在 Windows 上照样逃出目标
 * 目录。2026-09-15 实测：
 *   entry `root/myskill/..\..\..\..\evil.dll`
 *   → 落盘 `C:\Users\evil.dll`（目标本该是 `C:\Users\me\.agents\skills\myskill`）
 *
 * 这道门是真的要挡人，不只是防呆：`skills add` 收的是我们那台 GitLab 上的**任意**仓，
 * 任何内网用户都建得出一个，而装它的人只需要跑一次 `pep skills add`。
 */
function segmentsOf(path: string): string[] {
  const segments = path.split(/[\\/]+/).filter((one) => one !== "" && one !== ".");
  if (segments.some((one) => one === ".." || /^[a-z]:$/i.test(one))) {
    throw new Error(`Refusing an archive entry that escapes its directory: ${path}`);
  }
  return segments;
}

export type SkillsUpdateDependencies = {
  issuer: string;
  accessToken: string;
  /**
   * 要哪个仓：完整 URL，或省略主机的 `群/子群/仓[@ref]`。**必填。**
   * ⚠ 它同时是账上的键 —— 用**调用方原样给的那一串**，不做规范化：规范化之后
   * `a/b` 与 `https://host/a/b` 会归成一条账，而用户看到的 `list` 是他自己敲过的那一串。
   */
  source: string;
  /** canonical 落点。默认 `~/.agents/skills`（22 家 agent 共读的通用目录）。 */
  directory: string;
  /**
   * 铺完之后再接进哪个 agent 目录（默认 `~/.claude/skills` —— 只有 Claude Code 不读通用目录）。
   * `undefined` = 调用方给了 `--dir`，那时只铺一份、不接任何链接。
   */
  linkInto?: string;
  /**
   * 盘上已经没了的那些 skill：**补回来（`add`）还是照旧不管（`update`）**。
   *
   * 操作员 2026-09-15 定的口径：删掉就是删掉。`update` 的职责是「把还在的刷到最新」，
   * 它不复活用户自己删掉的东西；要它回来就显式 `add` 一次 —— 那才是「装上」这个动作的
   * 出口。于是 `add` 传 true，`update` 不传。
   */
  restoreMissing?: boolean;
  /**
   * 下载上限，只为可测而开的缝（与 `fetch` 同一口径）。默认 `MAX_ARCHIVE_BYTES`。
   * ⚠ 真实上限是 64 MiB，用真数据去撞不现实 —— 而不撞一次就测不到「这道上限有没有真的
   * 被接进调用链」。只测 `readCapped` 本身是不够的：它可以完全正确，却一次都没被调用。
   */
  maxArchiveBytes?: number;
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
  if (status === 400)
    return "PEP did not accept that repository address. It must be an https URL on the platform's GitLab host, or a <group>/<project> path on it.";
  if (status === 404) {
    // ⚠ 404 有两个完全不同的成因，而 CLI 分不开它们：
    //   · 那个仓 / 分支取不到（PEP 答的，带 31005）；
    //   · 这个部署压根没有这个端点（框架答的，没有本仓错误码）。
    // 所以措辞把两种都摆出来 —— 替它猜一个的代价是把人指去错的方向。
    return "No such repository or ref on the platform's GitLab (or this PEP deployment has no /api/skills/archive endpoint at all). Check the address, then ask an operator whether skills are enabled here.";
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
 * 一个 skill 目录的内容哈希。
 *
 * ⚠ **路径和内容都要进去**，且路径先排序：只哈希内容的话，改个文件名看起来就没变；
 * 不排序的话，归档顺序一抖动哈希就变，于是每次都报「更新了」。
 *
 * 用 sha256 的前 16 字节转 hex —— 够分辨，账文件也不至于被哈希撑大。
 */
function hashSkill(files: readonly SkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.data);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

/**
 * 取最新一版 skills 并铺到本地目录。
 *
 * ⚠ **只动自己写过的东西**。目标目录里可能有用户自己放的 skill —— 整个目录清空重来会把它们
 * 一起删掉。所以：要写的那几个各自先删再写（保证上游删掉的文件本地也消失），上一次写过、
 * 这次不在清单里的才移除，其余一概不碰。「上一次写过谁」记在 `skills.json` 里。
 *
 * ── 为什么写了还要分 updated / unchanged（2026-09-14）──────────────────────────
 * 判「变没变」只能靠仓库 commit 的话，仓里改一行 README、动一下 `evals/`，commit 就变了，
 * 于是**每个 skill 都被报成「更新了」**。用户真正想知道的是「我关心的那个变了没有」。
 * 所以逐个 skill 比内容哈希，输出分两档。做法参照 `npx skills` 的 `.skill-lock.json`。
 *
 * ⚠ 哈希只用来**汇报**，不用来决定写不写：commit 变了就整包重写。省那几次写盘换来的是
 * 「本地被人手改过却报 unchanged」这种查不出的状态 —— 不值。
 */
/**
 * 同一个目录下，这个 skill 名有没有被**别的包**占着。三处共用：装之前的冲突判定、
 * 清理之前的守卫、以及 `removeSkills`。
 *
 * ⚠ 名字比较**不分大小写**：本 CLI 只跑 win32 / darwin，两者的文件系统默认不区分大小写
 * —— 仓 A 的 `Docs/` 与仓 B 的 `docs/` 在盘上是同一个目录。精确比较会认为它们无关，
 * 于是静默互相覆盖，而那正是这道检查要挡的东西。
 * （目录路径仍按精确比较：它多半是我们自己 join 出来的，只有 `--dir` 由用户敲；
 *  那一档敲成两种大小写时最坏是漏判，而不是误判。）
 */
function otherClaimant(
  packages: Record<string, SkillsPackageState>,
  self: string,
  directory: string,
  skill: string,
): string | undefined {
  const wanted = skill.toLowerCase();
  return Object.entries(packages).find(
    ([other, pkg]) =>
      other !== self &&
      samePlace(pkg.directory, directory) &&
      Object.keys(pkg.skills).some((one) => one.toLowerCase() === wanted),
  )?.[0];
}

export type SkillsRemoveResult = {
  name: string;
  /** 真的删掉了的那些。 */
  deleted: string[];
  /**
   * 账上摘了，但**文件留着没动**的那些 —— 另一个包也占着这个名字（存量撞名）。
   * 那份文件到底是谁的已经说不清，删了就可能是在删别人的东西。
   */
  keptForOthers: SkillConflict[];
  directory: string;
};

/**
 * 把一个包从账上摘掉，并删掉**它铺出来的**那些 skill。
 *
 * 纯本地操作，不打网络 —— 所以调用它不需要令牌（见 cli.ts 里它被放在取令牌之前）。
 *
 * ⚠ 只删**账上记在这个包名下**的那几个目录。用户自己放的、别的包铺的，一概不碰 ——
 * 与 `update` 的清理同一口径。
 *
 * ⚠ 撞名那一档**不删文件**：盘上那一份到底是谁写的已经说不清（谁最后 update 谁就赢），
 * 删了就可能是在删另一个包的内容。摘账、留文件、如实说出来，让用户自己决定。
 */
export async function removeSkills(
  name: string,
  store: SkillsStateStore,
): Promise<SkillsRemoveResult> {
  const state = await store.read();
  const pkg = state?.packages[name];
  if (!state || !pkg) {
    throw new Error(`Not added: ${name}. Run \`pep skills list\` to see what is.`);
  }

  const deleted: string[] = [];
  const keptForOthers: SkillConflict[] = [];
  for (const skill of Object.keys(pkg.skills).sort()) {
    const owner = otherClaimant(state.packages, name, pkg.directory, skill);
    if (owner !== undefined) {
      keptForOthers.push({ skill, owner });
      continue;
    }
    await rm(join(pkg.directory, skill), { recursive: true, force: true });
    // canonical 与链接两处都要清：只清一边会留下一条指向空处的死链。
    if (pkg.linkedInto !== undefined) {
      await rm(join(pkg.linkedInto, skill), { recursive: true, force: true });
    }
    deleted.push(skill);
  }

  const { [name]: _dropped, ...rest } = state.packages;
  await store.write({ version: 4, packages: rest });
  return { name, deleted, keptForOthers, directory: pkg.directory };
}

/**
 * 账上记着、但盘上**已经不在**的那些 —— 也就是「用户自己删掉的」。
 *
 * 只核 canonical 那一份的在否，不核内容。判据落在 canonical 而不是链接上：链接是
 * 「已安装」的实现细节，用户要扔掉一个 skill 时扔的是实体那份。
 *
 * ⚠ 用 `stat` 而不是 `lstat`：它跟随符号链接，于是**悬空的链接算「不在」**。
 */
/** 跳过的那几个在账上的原记录 —— 原样留着，见调用点。 */
function pickSkipped(
  previous: { skills: Record<string, string> } | undefined,
  skipped: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    skipped.map((skill) => [skill, previous?.skills[skill] ?? ""]),
  );
}

async function missingSkills(
  directory: string,
  skills: string[],
): Promise<ReadonlySet<string>> {
  const gone = new Set<string>();
  for (const skill of skills) {
    if (!(await stat(join(directory, skill)).catch(() => null))) gone.add(skill);
  }
  return gone;
}

export async function updateSkills(
  dependencies: SkillsUpdateDependencies,
): Promise<SkillsUpdateResult> {
  const doFetch = dependencies.fetch ?? globalThis.fetch;
  const name = dependencies.source;
  const url = new URL(`${dependencies.issuer.replace(/\/+$/, "")}${ARCHIVE_PATH}`);
  url.searchParams.set("source", name);
  const response = await doFetch(url, {
    headers: { Authorization: `Bearer ${dependencies.accessToken}` },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(describeFailure(response.status));
  }

  const commit = response.headers.get("x-skills-commit") ?? undefined;
  const state = await dependencies.stateStore.read();
  const previous = state?.packages[name];
  // ⚠ 落点也要比，**两段都比**：commit 一样但落点变了（换了 scope、或换了 `--dir`）时
  // 盘上那份还在原处，直接答「没变」等于什么都没做。链接目录单独变了也算变 —— 那一档
  // canonical 已经对了，但新的 agent 目录里还没有链接。
  const sameTarget =
    previous !== undefined &&
    samePlace(previous.directory, dependencies.directory) &&
    (previous.linkedInto === undefined
      ? dependencies.linkInto === undefined
      : dependencies.linkInto !== undefined && samePlace(previous.linkedInto, dependencies.linkInto));
  /**
   * 这个 skill 名在**同一个目录**下有没有被别的包占着。
   *
   * ⚠ 只有落点相同才算撞 —— 两个包各装各的目录（一个个人级一个项目级）本来就互不相干。
   */
  const claimedElsewhere = (skill: string): string | undefined =>
    otherClaimant(state?.packages ?? {}, name, dependencies.directory, skill);

  // 账上记着、盘上已经没了的那些 —— 用户自己删掉的。**两条命令对它的态度相反**，见
  // `restoreMissing` 的注释。
  const gone =
    previous !== undefined && sameTarget
      ? await missingSkills(previous.directory, Object.keys(previous.skills))
      : new Set<string>();

  // ⚠ `add` 在**有东西被删掉**时不许走快路 —— 它的职责就是把那些补回来。`update` 则照走：
  // 删掉的东西它本来就不该复活。
  const nothingToRestore = !dependencies.restoreMissing || gone.size === 0;
  // ⚠ 撞名要在**快路之前**算出来，而且 `unchanged` 也得带着它回去。存量冲突下双方的
  // commit 通常都没变 ⇒ 两边都走快路 ⇒ 两边都报「已经是最新了」，而盘上只有一份内容。
  // 那正是这件事最坏的形态：**它永远不会自己暴露**。
  const standing = Object.keys(previous?.skills ?? {}).flatMap((skill) => {
    const owner = claimedElsewhere(skill);
    return owner ? [{ skill, owner }] : [];
  });

  if (commit !== undefined && commit === previous?.commit && sameTarget && nothingToRestore) {
    // 已经是这一版了。体还没读完就掐掉，省下传输 —— 这是个半吊子的省法，真要省该是
    // 条件请求（CLI 带 If-None-Match、PEP 答 304），但 PEP 那侧还没做。
    await response.body?.cancel();
    return { status: "unchanged", name, commit, conflicts: standing };
  }

  const gzipped = await readCapped(response, dependencies.maxArchiveBytes ?? MAX_ARCHIVE_BYTES);
  // ⚠ `maxOutputLength` 是挡 gzip 炸弹的那一道 —— 超了就抛，而不是解到一半把内存吃光。
  let unpacked: Uint8Array;
  try {
    unpacked = gunzipSync(gzipped, { maxOutputLength: MAX_UNPACKED_BYTES });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw tooBig("the unpacked archive", MAX_UNPACKED_BYTES);
    }
    throw error;
  }
  const entries = readTar(unpacked);
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `The skills archive holds ${entries.length} files (limit ${MAX_ENTRIES}). Refusing to unpack it.`,
    );
  }
  const files = planSkillFiles(entries);

  const bySkill = new Map<string, SkillFile[]>();
  for (const file of files) {
    const group = bySkill.get(file.skill);
    if (group) group.push(file);
    else bySkill.set(file.skill, [file]);
  }
  const inArchive = [...bySkill.keys()].sort();

  // ── 用户删掉的那些，`update` 不复活 ────────────────────────────────────────
  // 操作员 2026-09-15 定的口径：**删掉就是删掉**。`update` 的职责是「把还在的刷到最新」，
  // 不是「把仓里有的都铺满」—— 后者是 `add` 的职责，要它回来就显式 add 一次。
  //
  // ⚠ 判据是「**以前记过、现在没了**」，不能简单写成「盘上没有就跳过」：上游**新增**的
  // skill 盘上本来就没有，那种一律要装 —— 那正是 update 存在的理由。
  const skipped = dependencies.restoreMissing
    ? []
    : inArchive.filter((skill) => gone.has(skill));
  const candidates = inArchive.filter((skill) => !skipped.includes(skill));

  // ── 跨包同名：`add` 抛，`update` 让开 ──────────────────────────────────────
  // skill 名就是落盘的目录名，所以同一个目录下两个仓给出同名 skill 时后写的盖掉先写的
  // —— 与包内同名是同一件事（见 `planSkillFiles` 那段注释），只是这次两个名字来自两个仓。
  //
  // ⚠ **两条命令的态度必须不同**：
  //   · `add` 是一次显式的「我要装这个」⇒ **抛**。让它装进去等于替用户挑一个赢家，
  //     而挑错是静默的。报错里指名是谁占着、怎么绕开。
  //   · `update` 是一次例行刷新 ⇒ **绝不抛、也绝不覆盖**。撞名可能是**上游后来才造成的**
  //     （B 仓新增了一个 A 仓已有的名字），用户什么都没做错；抛出去会让整条
  //     `pep skills update` 当场中断，后面那些仓一个都刷不到。于是让开：不写这一个，
  //     照常写别的，并把它报上去。
  //
  // 让开的后果是这个 skill 被冻在原处，直到用户 `remove` 掉一边 —— 那正是该有的压力：
  // 内容稳定、每次都被说出来、解法明确，而不是谁最后 update 谁赢。
  const conflicts: SkillConflict[] = [];
  for (const skill of candidates) {
    const owner = claimedElsewhere(skill);
    if (owner === undefined) continue;
    if (dependencies.restoreMissing) {
      throw new Error(
        `${owner} already installs a skill named "${skill}" in ${dependencies.directory}. ` +
          `Two repositories cannot both provide "${skill}" there — the second would silently ` +
          `overwrite the first. Install this one elsewhere (-p, or --dir <path>), ` +
          `or run \`pep skills remove ${owner}\` first.`,
      );
    }
    conflicts.push({ skill, owner });
  }
  const skills = candidates.filter((skill) => !conflicts.some((one) => one.skill === skill));

  // 逐个比哈希。⚠ 上次记的是空串（从旧版账迁过来、哈希未知）时一律算「变了」——
  // 把「不知道」说成「没变」会让迁移后的第一次 update 漏掉真正的更新。
  const hashes: Record<string, string> = {};
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const skill of skills) {
    const hash = hashSkill(bySkill.get(skill) as SkillFile[]);
    hashes[skill] = hash;
    const before = previous?.skills[skill];
    // ⚠ 被删掉又补回来的算 **updated** —— 它盘上确实从「没有」变成了「有」。只比哈希的话
    // 内容没变就会报成 unchanged，而用户刚眼看着它回来，那句话是假的。
    if (gone.has(skill)) updated.push(skill);
    else if (before !== undefined && before !== "" && before === hash) unchanged.push(skill);
    else updated.push(skill);
  }

  // ── 先按**旧账**清一遍 ──────────────────────────────────────────────────────
  // 两种要清：上游删掉的那些，以及落点变了之后**整份留在原处**的那些。
  //
  // ⚠ 必须赶在写新的之前做完。落点没变、只是链接目录变了时，旧 canonical 就是新 canonical
  // ——放到写完之后清，会把刚写好的那份删掉。
  // ⚠ 「上游删掉的」要拿**归档里有什么**去比，不能拿这次要写的那批 —— 后者已经把用户
  // 自己删掉的剔出去了，混用会把它们当成上游删的，于是账上也跟着抹掉。
  const removed = Object.keys(previous?.skills ?? {}).filter((skill) => !inArchive.includes(skill));
  if (previous !== undefined) {
    const stale = sameTarget ? removed : Object.keys(previous.skills);
    for (const skill of stale) {
      // ⚠ **别的包也占着这个名字就别删** —— 盘上那份多半是它写的（谁最后 update 谁赢），
      // 删了就是在删别人的东西。`removeSkills` 一直有这道守卫，这两条清理路径此前没有：
      //   · 上游删掉本包某个 skill ⇒ 连带删掉另一个包在同一处的那份
      //   · 本包换落点 ⇒ 旧处整份删掉，同样会连带
      // 后者更坏：让开不写的那个 skill 会被删掉且不写回，等于凭空消失。
      if (otherClaimant(state?.packages ?? {}, name, previous.directory, skill)) continue;
      await rm(join(previous.directory, skill), { recursive: true, force: true });
      // canonical 与链接两处都要清：只清一边会留下一条指向空处的死链（或一份永不更新的副本）。
      if (previous.linkedInto !== undefined) {
        await rm(join(previous.linkedInto, skill), { recursive: true, force: true });
      }
    }
  }

  // 先删后写：上游删掉的文件，本地跟着消失。范围严格限定在这次要写的这几个 skill 目录。
  for (const skill of skills) {
    await rm(join(dependencies.directory, skill), { recursive: true, force: true });
  }
  // ⚠ 不碰的那几个（用户删掉的 + 让给别的包的）**一个文件都不写**。只过滤 `skills` 而不过滤
  // 这里的话，目录照样被重建出来 ——「不复活」「不覆盖」就都成了空话。这条踩过两次了。
  const untouched = new Set([...skipped, ...conflicts.map((one) => one.skill)]);
  for (const file of files) {
    if (untouched.has(file.skill)) continue;
    const target = join(dependencies.directory, file.skill, ...file.path.split("/"));
    // ⚠ 兜底：路径算完之后**再确认一次**没跑出去。段级检查（`segmentsOf`）挡的是已知的
    // 写法，这一句挡的是没想到的 —— 两道都便宜，而写错的代价是往用户机器上任意位置写文件。
    assertInside(dependencies.directory, target);
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

  await dependencies.stateStore.write({
    version: 4,
    packages: {
      // 别的包的账原样留着 —— 装 B 不该把 A 的记录抹掉，那会让 A 铺的目录从此没人清理。
      // v4 起每个包各记各的落点，所以这一份合并不会再把别人的落点带歪。
      ...(state?.packages ?? {}),
      [name]: {
        ...(commit ? { commit } : {}),
        directory: dependencies.directory,
        ...(dependencies.linkInto !== undefined ? { linkedInto: dependencies.linkInto } : {}),
        // 跳过的那些**原样留着上次的哈希** —— 账上仍然认它是这个包的（将来 add 能补回来，
        // 上游删掉时也还清得动），只是这次没去碰它。
        // 跳过的与让开的都**原样留着上次的哈希** —— 账上仍然认它是这个包的（将来 add
        // 能补回来、`remove` 也还清得动），只是这次没去碰它。
        skills: {
          ...pickSkipped(previous, [...skipped, ...conflicts.map((one) => one.skill)]),
          ...hashes,
        },
      },
    },
  });

  return {
    status: "written",
    name,
    updated,
    unchanged,
    skills,
    // ⚠ 扣掉的是 `untouched` 全部（用户删的 + 让给别的包的），不只是 skipped ——
    // 让开没写的那些文件算进去，「N file(s)」就是句假话。
    fileCount: files.filter((one) => !untouched.has(one.skill)).length,
    removed,
    skipped,
    conflicts,
    directory: dependencies.directory,
    ...(dependencies.linkInto !== undefined ? { linkedInto: dependencies.linkInto } : {}),
    ...(copiedCount > 0 ? { copiedCount } : {}),
    ...(commit ? { commit } : {}),
  };
}


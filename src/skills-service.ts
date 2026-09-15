import { cp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { readTar, type TarEntry } from "./tar.js";
import type { SkillsStateStore } from "./types.js";

const ARCHIVE_PATH = "/api/skills/archive";

/** 认一个 skill 的凭据。**目录里有这个文件就是一个 skill，没有就不是** —— 见 `planSkillFiles`。 */
const SKILL_MANIFEST = "SKILL.md";

/** 摊平后的一个文件：属于哪个 skill、在它目录里的相对路径。 */
export type SkillFile = { skill: string; path: string; data: Uint8Array };

export type SkillsUpdateResult =
  /** 仓库提交没变，连包都没下 —— 体在读完之前就掐了。 */
  | { status: "unchanged"; name: string; commit: string }
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
  const seen = new Map<string, string>();
  for (const root of roots) {
    const name = root[root.length - 1];
    const where = root.join("/");
    const first = seen.get(name);
    if (first !== undefined) {
      throw new Error(
        `Two skills in this package would both be called "${name}": ${first} and ${where}. ` +
          `Skill names come from the directory name, so they must be unique within a package.`,
      );
    }
    seen.set(name, where);
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

/** 路径切段并挡掉 tar-slip。空段与 `.` 丢掉，`..` 抛。 */
function segmentsOf(path: string): string[] {
  const segments = path.split("/").filter((one) => one !== "" && one !== ".");
  if (segments.some((one) => one === "..")) {
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
    previous?.directory === dependencies.directory &&
    previous?.linkedInto === dependencies.linkInto;
  if (commit !== undefined && commit === previous?.commit && sameTarget) {
    // 已经是这一版了。体还没读完就掐掉，省下传输 —— 这是个半吊子的省法，真要省该是
    // 条件请求（CLI 带 If-None-Match、PEP 答 304），但 PEP 那侧还没做。
    await response.body?.cancel();
    return { status: "unchanged", name, commit };
  }

  const gzipped = new Uint8Array(await response.arrayBuffer());
  const files = planSkillFiles(readTar(gunzipSync(gzipped)));

  const bySkill = new Map<string, SkillFile[]>();
  for (const file of files) {
    const group = bySkill.get(file.skill);
    if (group) group.push(file);
    else bySkill.set(file.skill, [file]);
  }
  const skills = [...bySkill.keys()].sort();

  // 逐个比哈希。⚠ 上次记的是空串（从旧版账迁过来、哈希未知）时一律算「变了」——
  // 把「不知道」说成「没变」会让迁移后的第一次 update 漏掉真正的更新。
  const hashes: Record<string, string> = {};
  const updated: string[] = [];
  const unchanged: string[] = [];
  for (const skill of skills) {
    const hash = hashSkill(bySkill.get(skill) as SkillFile[]);
    hashes[skill] = hash;
    const before = previous?.skills[skill];
    if (before !== undefined && before !== "" && before === hash) unchanged.push(skill);
    else updated.push(skill);
  }

  // ── 先按**旧账**清一遍 ──────────────────────────────────────────────────────
  // 两种要清：上游删掉的那些，以及落点变了之后**整份留在原处**的那些。
  //
  // ⚠ 必须赶在写新的之前做完。落点没变、只是链接目录变了时，旧 canonical 就是新 canonical
  // ——放到写完之后清，会把刚写好的那份删掉。
  const removed = Object.keys(previous?.skills ?? {}).filter((skill) => !skills.includes(skill));
  if (previous !== undefined) {
    const stale = sameTarget ? removed : Object.keys(previous.skills);
    for (const skill of stale) {
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
  for (const file of files) {
    const target = join(dependencies.directory, file.skill, ...file.path.split("/"));
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
        skills: hashes,
      },
    },
  });

  return {
    status: "written",
    name,
    updated,
    unchanged,
    skills,
    fileCount: files.length,
    removed,
    directory: dependencies.directory,
    ...(dependencies.linkInto !== undefined ? { linkedInto: dependencies.linkInto } : {}),
    ...(copiedCount > 0 ? { copiedCount } : {}),
    ...(commit ? { commit } : {}),
  };
}


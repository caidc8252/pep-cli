import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSkillFiles, removeSkills, updateSkills } from "./skills-service.js";
import type { SkillsState, SkillsStateStore } from "./types.js";
import type { TarEntry } from "./tar.js";

const ROOT = "agent-skills-main-0123456789abcdef0123456789abcdef01234567";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

const tarEntry = (path: string, body = ""): TarEntry => ({
  path,
  data: encoder.encode(body),
});

// planSkillFiles 的用例搬去了 `skills-plan.test.ts` —— 定位方式 2026-09-14 从「按层级剥」
// 改成「找 SKILL.md」，那一组整体重写，放在一起更好读。

function memoryStateStore(
  initial: SkillsState | null = null,
): SkillsStateStore & {
  current: SkillsState | null;
} {
  return {
    current: initial,
    async read() {
      return this.current;
    },
    async write(state) {
      this.current = state;
    },
  };
}

/** 打一个真的 tar.gz —— 解包这一路不打桩，否则测的就不是它了。 */
function gzippedArchive(files: Record<string, string>): Uint8Array {
  const BLOCK = 512;
  const blocks: Uint8Array[] = [];
  for (const [path, body] of Object.entries(files)) {
    const header = new Uint8Array(BLOCK);
    header.set(encoder.encode(path).subarray(0, 100), 0);
    const size = encoder.encode(body).length;
    header.set(encoder.encode(`${size.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    header.set(encoder.encode("ustar\0"), 257);
    blocks.push(header);
    const data = new Uint8Array(Math.ceil(size / BLOCK) * BLOCK);
    data.set(encoder.encode(body));
    blocks.push(data);
  }
  blocks.push(new Uint8Array(BLOCK), new Uint8Array(BLOCK));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.length;
  }
  return new Uint8Array(gzipSync(out));
}

function archiveResponse(
  files: Record<string, string>,
  commit: string | null = COMMIT,
): Response {
  const headers = new Headers({ "content-type": "application/gzip" });
  if (commit) headers.set("x-skills-commit", commit);
  return new Response(gzippedArchive(files), { headers });
}

let directory: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "pep-skills-"));
});

const deps = (
  fetchImpl: unknown,
  stateStore: SkillsStateStore,
  overrides: { directory?: string; linkInto?: string; restoreMissing?: boolean } = {},
) => ({
  issuer: "https://pep.example.com",
  accessToken: "tok",
  source: "group/sub/repo",
  directory,
  stateStore,
  fetch: fetchImpl as typeof globalThis.fetch,
  ...overrides,
});

/**
 * 把一个 skill「已经在盘上」的样子摆出来。
 *
 * ⚠ 断言 `unchanged` 的用例**必须**先调它。快路现在会核一遍盘上那份在不在（账本答不了
 * 这件事），只在账上记一笔而盘上空着，拿到的是 `written` —— 而那正是「手工删了文件」
 * 的形状，不是「已经是这一版了」。
 */
async function alreadyOnDisk(root: string, skill: string, body = "盘上原有的"): Promise<void> {
  await mkdir(join(root, skill), { recursive: true });
  await writeFile(join(root, skill, "SKILL.md"), body);
}

describe("updateSkills —— 失败的归因", () => {
  it.each([
    [401, /pep auth login/],
    // ⚠ 403 必须指向**客户端的 allowed_scopes**，不是 DEFAULT_SCOPES —— 后者是 CLI 曾经
    // 不申请这个 scope 时的说法，留着会把人指去改一个已经对了的地方。
    [403, /allowed_scopes in PEP/],
    // ⚠ 404 要有自己的一句：最常见的成因是端点还没部署，兜底的「answered 404」说不出这件事。
    [400, /not accepted|https URL/],
    [404, /No such repository or ref/],
    [503, /could not reach the skills repository/],
    [500, /answered 500/],
  ])("%i ⇒ 说清楚下一步该做什么", async (status, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status }));
    await expect(
      updateSkills(deps(fetchImpl, memoryStateStore())),
    ).rejects.toThrow(expected);
  });
});

describe("updateSkills —— 落盘", () => {
  it("按 skill 铺开，目录自己建", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      archiveResponse({
        [`${ROOT}/skills/a/SKILL.md`]: "# a",
        [`${ROOT}/skills/a/references/x.md`]: "# x",
        [`${ROOT}/skills/b/SKILL.md`]: "# b",
      }),
    );
    const store = memoryStateStore();

    const result = await updateSkills(deps(fetchImpl, store));

    expect(result).toMatchObject({
      status: "written",
      skills: ["a", "b"],
      fileCount: 3,
    });
    expect(await readFile(join(directory, "a", "SKILL.md"), "utf8")).toBe(
      "# a",
    );
    expect(
      await readFile(join(directory, "a", "references", "x.md"), "utf8"),
    ).toBe("# x");
    expect(await readFile(join(directory, "b", "SKILL.md"), "utf8")).toBe(
      "# b",
    );
    const pkg = store.current?.packages["group/sub/repo"];
    expect(store.current?.version).toBe(4);
    expect(pkg?.commit).toBe(COMMIT);
    // v4 起落点记在**包里**。漏记的话 `update` 不带参数时算不出该往哪儿写，只能退回默认
    // 目录 —— 用 `--dir` / `--project` 装的包会被一次 update 悄悄搬走。
    expect(pkg?.directory).toBe(directory);
    // 哈希是内容算出来的，不钉具体值 —— 钉的是「每个 skill 都记了一个非空哈希」，
    // 因为空串在 update 里当作「不知道」，账里留空等于下次一定误报「变了」。
    expect(Object.keys(pkg?.skills ?? {}).sort()).toEqual(["a", "b"]);
    for (const hash of Object.values(pkg?.skills ?? {})) expect(hash).toMatch(/^[0-9a-f]{32}$/);
    // 内容不同的两个 skill 不该算出同一个哈希。
    expect(pkg?.skills.a).not.toBe(pkg?.skills.b);
  });

  it("带上 Bearer 打 /api/skills/archive", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(archiveResponse({}));
    await updateSkills(deps(fetchImpl, memoryStateStore()));
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe("https://pep.example.com/api/skills/archive");
    // ⚠ 原样带出去，不做规范化 —— 账上的键就是用户敲的那一串。
    expect(url.searchParams.get("source")).toBe("group/sub/repo");
    expect(init).toEqual({ headers: { Authorization: "Bearer tok" } });
  });

  it("同一个提交 ⇒ 不解包、不写盘", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );
    const store = memoryStateStore({
      version: 4,
      packages: { "group/sub/repo": { commit: COMMIT, directory, skills: { "a": "h" } } },
    });
    await alreadyOnDisk(directory, "a");

    expect(await updateSkills(deps(fetchImpl, store))).toEqual({
      status: "unchanged",
      name: "group/sub/repo",
      commit: COMMIT,
      conflicts: [],
    });
    // 没解包：盘上那份还是原样，一个字节没被覆盖。
    expect(await readdir(directory)).toEqual(["a"]);
    expect(await readFile(join(directory, "a", "SKILL.md"), "utf8")).toBe("盘上原有的");
  });

  it("提交没变但换了目录 ⇒ 照写（新目录里还什么都没有）", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );
    const store = memoryStateStore({
      version: 4,
      packages: {
        "group/sub/repo": { commit: COMMIT, directory: "/somewhere/else", skills: { "a": "h" } },
      },
    });

    expect((await updateSkills(deps(fetchImpl, store))).status).toBe("written");
  });

  it("服务端没给提交号 ⇒ 照写，账上不记 commit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }, null),
      );
    const store = memoryStateStore();

    const result = await updateSkills(deps(fetchImpl, store));
    expect(result).toMatchObject({ status: "written" });
    expect(result).not.toHaveProperty("commit");
    expect(store.current?.packages["group/sub/repo"]?.commit).toBeUndefined();
  });

  it("上游删掉的文件，本地跟着消失（先删后写）", async () => {
    await mkdir(join(directory, "a"), { recursive: true });
    await writeFile(join(directory, "a", "stale.md"), "老的");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );

    await updateSkills(
      deps(
        fetchImpl,
        memoryStateStore({
          version: 4,
          packages: { "group/sub/repo": { directory, skills: { "a": "h" } } },
        }),
      ),
    );

    expect(await readdir(join(directory, "a"))).toEqual(["SKILL.md"]);
  });

  it("上一次写过、这次没有了的 skill 被移除", async () => {
    await mkdir(join(directory, "gone"), { recursive: true });
    await writeFile(join(directory, "gone", "SKILL.md"), "旧的");
    // ⚠ `a` 也得在盘上。不在的话它会被当成「用户自己删的」而跳过，这条用例就测不到
    // 它本来要测的东西了（上游删掉的 gone 被移除）。
    await alreadyOnDisk(directory, "a");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );

    const result = await updateSkills(
      deps(
        fetchImpl,
        memoryStateStore({
          version: 4,
          packages: { "group/sub/repo": { directory, skills: { "a": "h", "gone": "h" } } },
        }),
      ),
    );

    expect(result).toMatchObject({ removed: ["gone"] });
    expect(await readdir(directory)).toEqual(["a"]);
  });

  // ⚠ 目标目录里可能有用户自己放的 skill。整个目录清空重来会把它们一起删掉 ——
  // 只有记在账上的才允许被移除。
  it("账上没有的目录一概不碰 —— 用户自己放的 skill 留着", async () => {
    await mkdir(join(directory, "mine"), { recursive: true });
    await writeFile(join(directory, "mine", "SKILL.md"), "我自己写的");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );

    await updateSkills(deps(fetchImpl, memoryStateStore()));

    expect((await readdir(directory)).sort()).toEqual(["a", "mine"]);
    expect(await readFile(join(directory, "mine", "SKILL.md"), "utf8")).toBe(
      "我自己写的",
    );
  });
});

// ⚠ 这一组钉的是「一份实体 + 一条链接」这个落盘模型（2026-09-11）。
//
// canonical 写进 `~/.agents/skills` —— 那是 22 家 agent 共读的通用目录；只有 Claude Code 坚持
// 自己的 `~/.claude/skills`，所以额外接一条链给它。这样一次同步覆盖 23 家，而要维护的常量只有
// 两个路径 —— 替代方案是维护一张「每家 agent 的目录」表（上游 skills 包里那张有 79 项）。
describe("updateSkills —— 接进 agent 目录", () => {
  let linkInto: string;

  beforeEach(async () => {
    linkInto = await mkdtemp(join(tmpdir(), "pep-link-"));
  });

  it("canonical 写实体，链接目录里读到的是同一份内容", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      archiveResponse({ [`${ROOT}/skills/coding/SKILL.md`]: "# coding" }),
    );
    const result = await updateSkills({
      ...deps(fetchImpl, memoryStateStore()),
      linkInto,
    });

    expect(result).toMatchObject({ status: "written", linkedInto: linkInto });
    // ⚠ 钉住「走的是链接那条路」。只断言 status + linkedInto 的话，symlink 若一直静默失败、
    // 每次都退回复制，这条测试照样绿 —— 而那正是最该被发现的坏法（功能还在，但更新不再
    // 只动一处，canonical 与各 agent 目录会分叉）。`copiedCount` 只在降级时出现。
    expect("copiedCount" in result).toBe(false);
    // 实体在 canonical
    expect(await readFile(join(directory, "coding", "SKILL.md"), "utf8")).toBe("# coding");
    // 链接那一侧读到的是同一份 —— 不断言它是 symlink 还是副本：建不成链接时会降级成复制，
    // 那也是成功。要断言的是「读得到同样的内容」，那才是用户关心的事。
    expect(await readFile(join(linkInto, "coding", "SKILL.md"), "utf8")).toBe("# coding");
  });

  it("不给 linkInto（即 --dir）时只铺一份，不往别处写", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      archiveResponse({ [`${ROOT}/skills/coding/SKILL.md`]: "# coding" }),
    );
    const result = await updateSkills(deps(fetchImpl, memoryStateStore()));

    expect(result).toMatchObject({ status: "written" });
    expect("linkedInto" in result).toBe(false);
    expect(await readdir(linkInto)).toEqual([]);
  });

  it("上游删掉的 skill，canonical 与链接**两处都清** —— 只清一边会留下死链", async () => {
    const store = memoryStateStore();
    await updateSkills({
      ...deps(
        vi.fn().mockResolvedValue(
          archiveResponse(
            {
              [`${ROOT}/skills/coding/SKILL.md`]: "# coding",
              [`${ROOT}/skills/retired/SKILL.md`]: "# retired",
            },
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ),
        ),
        store,
      ),
      linkInto,
    });
    expect(await readdir(linkInto)).toEqual(["coding", "retired"]);

    await updateSkills({
      ...deps(
        vi.fn().mockResolvedValue(
          archiveResponse(
            { [`${ROOT}/skills/coding/SKILL.md`]: "# coding" },
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          ),
        ),
        store,
      ),
      linkInto,
    });

    expect(await readdir(directory)).toEqual(["coding"]);
    expect(await readdir(linkInto)).toEqual(["coding"]);
  });

  // ⚠ 2026-09-11 真实复现过：链接目录的**父级本身是一条软链**时（macOS 上有人把 ~/.claude
  // 挪到 iCloud / 外置卷，`/tmp` → `/private/tmp` 也是这形状），按逻辑路径算出的相对目标
  // 会从链接的**真实**所在目录往上跳，落到不相干的地方 —— 建出来是一条**死链**，而
  // `symlink()` 自己不报错（它不检查目标存不存在）。所以相对目标必须按物理位置算。
  it("链接目录的父级是软链时，建出来的链接仍然读得到内容", async () => {
    const physical = await mkdtemp(join(tmpdir(), "pep-physical-"));
    const viaSymlink = join(await mkdtemp(join(tmpdir(), "pep-via-")), "claude");
    await symlink(physical, viaSymlink);

    await updateSkills({
      ...deps(
        vi.fn().mockResolvedValue(
          archiveResponse({ [`${ROOT}/skills/coding/SKILL.md`]: "# coding" }),
        ),
        memoryStateStore(),
      ),
      linkInto: join(viaSymlink, "skills"),
    });

    // 经由软链路径读 —— 这是用户会走的那条
    expect(await readFile(join(viaSymlink, "skills", "coding", "SKILL.md"), "utf8")).toBe(
      "# coding",
    );
    // 也经由物理路径读一次：证明链接不是碰巧在逻辑路径下能解析
    expect(await readFile(join(physical, "skills", "coding", "SKILL.md"), "utf8")).toBe(
      "# coding",
    );
  });

  it("链接目录里同名的东西被就地换掉，不是叠加", async () => {
    await mkdir(join(linkInto, "coding"), { recursive: true });
    await writeFile(join(linkInto, "coding", "STALE.md"), "旧的");

    await updateSkills({
      ...deps(
        vi.fn().mockResolvedValue(
          archiveResponse({ [`${ROOT}/skills/coding/SKILL.md`]: "# coding" }),
        ),
        memoryStateStore(),
      ),
      linkInto,
    });

    expect(await readdir(join(linkInto, "coding"))).toEqual(["SKILL.md"]);
  });
});

// ═══ updated / unchanged 分档（2026-09-14）═══════════════════════════════════
//
// ⚠ 这一组是本次改动的核心。只比仓库 commit 的话，仓里改一行 README、动一下 `evals/`，
// commit 就变了，于是**每个 skill 都被报成「更新了」** —— 而用户来看这行输出，要的恰恰是
// 「我关心的那个变了没有」。
describe("updateSkills —— 哪些 skill 真的变了", () => {
  const archive = (a: string, b: string) =>
    archiveResponse({
      [`${ROOT}/a/SKILL.md`]: a,
      [`${ROOT}/b/SKILL.md`]: b,
    });

  it("内容没变的进 unchanged，变了的进 updated", async () => {
    const store = memoryStateStore();
    const first = vi.fn().mockResolvedValue(archive("# a", "# b"));
    await updateSkills(deps(first, store));

    // 仓库动了（commit 变了），但只有 b 的内容变了。
    const second = vi.fn().mockResolvedValue(archiveResponse(
      { [`${ROOT}/a/SKILL.md`]: "# a", [`${ROOT}/b/SKILL.md`]: "# b changed" },
      "1111111111111111111111111111111111111111",
    ));
    const result = await updateSkills(deps(second, store));

    expect(result).toMatchObject({ status: "written", updated: ["b"], unchanged: ["a"] });
  });

  it("第一次装 ⇒ 全部算 updated（此前没有任何哈希可比）", async () => {
    const result = await updateSkills(
      deps(vi.fn().mockResolvedValue(archive("# a", "# b")), memoryStateStore()),
    );
    expect(result).toMatchObject({ updated: ["a", "b"], unchanged: [] });
  });

  // ⚠ 从旧版账迁过来的哈希是空串 = 「不知道」。把「不知道」说成「没变」会让迁移后的第一次
  // update 漏掉真正的更新，所以那一档必须算 updated。
  it("账上哈希是空串（旧版迁来的）⇒ 算 updated，不算 unchanged", async () => {
    const store = memoryStateStore({
      version: 4,
      packages: { "group/sub/repo": { commit: "old", directory, skills: { a: "", b: "" } } },
    });
    // 两个都得在盘上 —— 否则会被当成「用户自己删的」而跳过，测不到哈希那一档。
    await alreadyOnDisk(directory, "a");
    await alreadyOnDisk(directory, "b");
    const result = await updateSkills(
      deps(vi.fn().mockResolvedValue(archive("# a", "# b")), store),
    );
    expect(result).toMatchObject({ updated: ["a", "b"], unchanged: [] });
  });

  // ⚠ 哈希要把**路径**也算进去：只哈希内容的话，改个文件名看起来就没变。
  it("只改文件名也算变了", async () => {
    const store = memoryStateStore();
    await updateSkills(
      deps(
        vi.fn().mockResolvedValue(
          archiveResponse({ [`${ROOT}/a/SKILL.md`]: "# a", [`${ROOT}/a/one.md`]: "x" }),
        ),
        store,
      ),
    );
    // 内容一字未改，只把 one.md 改名成 two.md。
    const result = await updateSkills(
      deps(
        vi.fn().mockResolvedValue(
          archiveResponse(
            { [`${ROOT}/a/SKILL.md`]: "# a", [`${ROOT}/a/two.md`]: "x" },
            "2222222222222222222222222222222222222222",
          ),
        ),
        store,
      ),
    );
    expect(result).toMatchObject({ updated: ["a"] });
  });
});

// ═══ 落点搬家 ══════════════════════════════════════════════════════════════
//
// `--project` 之后「同一个包换个地方铺」成了常规操作（个人级 ⇄ 项目级）。搬完不清旧处的
// 后果不是报错，是**两份都在**：agent 照样读得到原处那份，而它从此再也不会更新 —— 一个
// 不会自己暴露的错误。
describe("落点变了 ⇒ 旧处那份清掉", () => {
  const archiveOf = () => archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" });

  it("canonical 与链接两处都清，新处照写", async () => {
    const oldDirectory = await mkdtemp(join(tmpdir(), "pep-old-"));
    const oldLink = await mkdtemp(join(tmpdir(), "pep-oldlink-"));
    // 旧处铺好的样子：canonical 一份 + 链接目录一份。
    for (const root of [oldDirectory, oldLink]) {
      await mkdir(join(root, "a"), { recursive: true });
      await writeFile(join(root, "a", "SKILL.md"), "旧的");
    }
    const store = memoryStateStore({
      version: 4,
      packages: {
        "group/sub/repo": {
          commit: COMMIT,
          directory: oldDirectory,
          linkedInto: oldLink,
          skills: { a: "h" },
        },
      },
    });

    // 搬到 `directory`（本用例的新落点），且这一次不接链接。
    const result = await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store));

    expect(result.status).toBe("written");
    expect(await readdir(oldDirectory)).toEqual([]);
    expect(await readdir(oldLink)).toEqual([]);
    expect(await readFile(join(directory, "a", "SKILL.md"), "utf8")).toBe("# a");
    // 账上记的落点跟着换 —— 不换的话下一次 update 又会去清新处。
    expect(store.current?.packages["group/sub/repo"]?.directory).toBe(directory);
    expect(store.current?.packages["group/sub/repo"]?.linkedInto).toBeUndefined();
  });

  // ⚠ commit 一样时有一条「不解包、不写盘」的快路。落点变了却走了那条快路，等于**什么都
  // 没做**却报成功：新处空着，旧处还在。
  it("提交没变但落点变了 ⇒ 照写，不能走「unchanged」那条快路", async () => {
    const oldDirectory = await mkdtemp(join(tmpdir(), "pep-old-"));
    const store = memoryStateStore({
      version: 4,
      packages: {
        "group/sub/repo": { commit: COMMIT, directory: oldDirectory, skills: { a: "h" } },
      },
    });

    const result = await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store));

    expect(result.status).toBe("written");
    expect(await readdir(directory)).toEqual(["a"]);
  });

  // ⚠ canonical 没变、只是要多接一条链接的那一档。漏判的话 canonical 是对的，
  // 但新的 agent 目录里一条链接都没有 —— 表现是「同步说成功了，Claude Code 看不见」。
  it("提交没变、canonical 也没变，只是链接目录变了 ⇒ 照样重铺", async () => {
    const link = await mkdtemp(join(tmpdir(), "pep-link-"));
    const store = memoryStateStore({
      version: 4,
      packages: { "group/sub/repo": { commit: COMMIT, directory, skills: { a: "h" } } },
    });

    const result = await updateSkills(
      deps(vi.fn().mockResolvedValue(archiveOf()), store, { linkInto: link }),
    );

    expect(result.status).toBe("written");
    expect(await readdir(link)).toEqual(["a"]);
  });

  it("落点完全没变、盘上那份也还在 ⇒ 仍然走「unchanged」，别把这条快路一起修没了", async () => {
    const store = memoryStateStore({
      version: 4,
      packages: { "group/sub/repo": { commit: COMMIT, directory, skills: { a: "h" } } },
    });
    await alreadyOnDisk(directory, "a");

    expect((await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store))).status).toBe(
      "unchanged",
    );
  });

  // ⚠ 一本账上两个包各在各处 —— 这正是 v4 把落点从顶层搬进包里要支持的情形。
  // 写 B 的时候把 A 的落点带歪，A 的下一次 update 就会搬家。
  it("写一个包不会动到另一个包记着的落点", async () => {
    const store = memoryStateStore({
      version: 4,
      packages: { "other/pkg": { directory: "/elsewhere", linkedInto: "/elselink", skills: {} } },
    });

    await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store));

    expect(store.current?.packages["other/pkg"]).toEqual({
      directory: "/elsewhere",
      linkedInto: "/elselink",
      skills: {},
    });
  });
});

// ═══ 盘上那份被手工删了之后 ═══════════════════════════════════════════════
//
// 「我把 ~/.agents/skills/xxx 删了，再 update 一下能回来吗」—— 这是个常见动作
// （清理、试错、手滑）。快路的前提是「盘上已经正好是这一版」，而账本答不了这件事。
// ⚠ **删掉就是删掉**（操作员 2026-09-15 定的口径）。`update` 的职责是「把还在的刷到最新」，
// 不是「把仓里有的都铺满」—— 后者是 `add` 的职责。两条命令走同一个 `updateSkills`，
// 分歧只在 `restoreMissing` 这一个开关上，所以这一组是它唯一的说明书。
describe("盘上那份被用户删了", () => {
  const archiveOf = (commit?: string) =>
    archiveResponse(
      { [`${ROOT}/skills/a/SKILL.md`]: "# a", [`${ROOT}/skills/b/SKILL.md`]: "# b" },
      commit ?? COMMIT,
    );

  /**
   * 真装一次，再手工把 `a` 删掉 —— 「用户删了一个 skill」之后的真实样子。
   * ⚠ 走真安装而不是手捏一本账：手捏的哈希对不上真内容，于是每个 skill 都算「变了」，
   * 那会把 updated / unchanged 的断言全部变成噪音。
   */
  const installedThenADeleted = async (linkInto?: string) => {
    const store = memoryStateStore();
    await updateSkills(
      deps(vi.fn().mockResolvedValue(archiveOf()), store, linkInto ? { linkInto } : {}),
    );
    await rm(join(directory, "a"), { recursive: true, force: true });
    return store;
  };

  it("commit 变了：update 刷新 b，但不把 a 加回来，并说得出是哪几个", async () => {
    const store = await installedThenADeleted();
    const next = archiveResponse(
      { [`${ROOT}/skills/a/SKILL.md`]: "# a", [`${ROOT}/skills/b/SKILL.md`]: "# b2" },
      "1111111111111111111111111111111111111111",
    );

    const result = await updateSkills(deps(vi.fn().mockResolvedValue(next), store));

    expect(result).toMatchObject({ status: "written", updated: ["b"], skipped: ["a"] });
    // a 一个文件都没写出来 —— 只过滤 skills 而不过滤文件循环的话，目录照样会被重建。
    expect(await readdir(directory)).toEqual(["b"]);
  });

  it("commit 没变：update 照走快路，同样不复活它", async () => {
    const store = await installedThenADeleted();
    expect((await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store))).status).toBe(
      "unchanged",
    );
    expect(await readdir(directory)).toEqual(["b"]);
  });

  it("add 把它补回来 —— 哪怕 commit 没变，也不许走快路", async () => {
    const store = await installedThenADeleted();

    const result = await updateSkills(
      deps(vi.fn().mockResolvedValue(archiveOf()), store, { restoreMissing: true }),
    );

    expect(await readFile(join(directory, "a", "SKILL.md"), "utf8")).toBe("# a");
    // ⚠ 补回来的算 **updated**，b 才是 unchanged —— a 盘上确实从「没有」变成了「有」。
    // 只比哈希会把 a 也报成 unchanged，而用户刚眼看着它回来，那句话是假的。
    expect(result).toMatchObject({ status: "written", updated: ["a"], unchanged: ["b"], skipped: [] });
  });

  // ⚠ 判据是「以前记过、现在没了」，不是「盘上没有」。上游**新增**的 skill 盘上本来就没有，
  // 那种一律要装 —— 那正是 update 存在的理由。写成后者的话 update 永远装不进新 skill。
  it("上游新增的 skill 照装不误（它盘上本来就没有）", async () => {
    const store = memoryStateStore();
    await updateSkills(
      deps(vi.fn().mockResolvedValue(archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" })), store),
    );

    const result = await updateSkills(
      deps(
        vi.fn().mockResolvedValue(archiveOf("2222222222222222222222222222222222222222")),
        store,
      ),
    );

    expect(result).toMatchObject({ skipped: [], updated: ["b"] });
    expect(await readFile(join(directory, "b", "SKILL.md"), "utf8")).toBe("# b");
  });

  it("跳过的那几个在账上原样留着 —— 将来 add 补得回来", async () => {
    const store = await installedThenADeleted();
    const before = store.current?.packages["group/sub/repo"]?.skills.a;
    const next = archiveResponse(
      { [`${ROOT}/skills/a/SKILL.md`]: "# a", [`${ROOT}/skills/b/SKILL.md`]: "# b2" },
      "1111111111111111111111111111111111111111",
    );

    await updateSkills(deps(vi.fn().mockResolvedValue(next), store));

    expect(store.current?.packages["group/sub/repo"]?.skills.a).toBe(before);
  });

  // 判据落在 canonical 上：链接是「已安装」的实现细节，用户要扔掉一个 skill 时扔的是实体那份。
  it("canonical 还在、只有链接那份没了 ⇒ 链接照样补", async () => {
    const link = await mkdtemp(join(tmpdir(), "pep-link-"));
    const store = memoryStateStore();
    await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store, { linkInto: link }));
    await rm(join(link, "a"), { recursive: true, force: true });

    await updateSkills(
      deps(
        vi.fn().mockResolvedValue(archiveOf("3333333333333333333333333333333333333333")),
        store,
        { linkInto: link },
      ),
    );

    expect((await readdir(link)).sort()).toEqual(["a", "b"]);
  });
});


// ═══ 两个仓给出同名 skill ═══════════════════════════════════════════════════
//
// skill 名就是落盘的目录名（`<canonical>/<skill 名>/`），所以同一个目录下两个包给出同名
// skill 时后写的会盖掉先写的 —— 与包内同名是同一件事，只是这次两个名字来自两个仓。
//
// ⚠ 实测过的最坏形态：双方 commit 都没变 ⇒ 两边都走「unchanged」快路 ⇒ 两边都报「已经是
// 最新了」，而盘上只有一份内容。**它永远不会自己暴露**，所以 conflicts 两条出口都要带。
describe("跨包同名", () => {
  const skillNamed = (body: string, commit: string) =>
    archiveResponse({ [`${ROOT}/semi-integration/SKILL.md`]: body }, commit);

  const installA = async (store: SkillsStateStore) =>
    updateSkills(
      deps(vi.fn().mockResolvedValue(skillNamed("我是 A", "a".repeat(40))), store, {}),
    );

  // ── add：抛 ────────────────────────────────────────────────────────────────
  // 显式的「我要装这个」。让它装进去等于替用户挑一个赢家，而挑错是静默的。
  it("add 撞上 ⇒ 抛，一个字节都不写", async () => {
    const store = memoryStateStore();
    await updateSkills({
      ...deps(vi.fn().mockResolvedValue(skillNamed("我是 A", "a".repeat(40))), store, {
        restoreMissing: true,
      }),
      source: "group/repo-a",
    });

    await expect(
      updateSkills({
        ...deps(vi.fn().mockResolvedValue(skillNamed("我是 B", "b".repeat(40))), store, {
          restoreMissing: true,
        }),
        source: "group/repo-b",
      }),
    ).rejects.toThrow(/group\/repo-a already installs a skill named "semi-integration"/);

    // 抛之前什么都没写：A 的内容原封不动。
    expect(await readFile(join(directory, "semi-integration", "SKILL.md"), "utf8")).toBe("我是 A");
    // 账上也不该留下 B 的痕迹。
    expect(store.current?.packages["group/repo-b"]).toBeUndefined();
  });

  it("报错里给得出出路（装到别处，或者先 remove）", async () => {
    const store = memoryStateStore();
    await updateSkills({ ...deps(vi.fn().mockResolvedValue(skillNamed("A", "a".repeat(40))), store, { restoreMissing: true }), source: "group/repo-a" });
    await expect(
      updateSkills({ ...deps(vi.fn().mockResolvedValue(skillNamed("B", "b".repeat(40))), store, { restoreMissing: true }), source: "group/repo-b" }),
    ).rejects.toThrow(/--dir <path>.*pep skills remove group\/repo-a/s);
  });

  // ── update：让开，绝不抛 ───────────────────────────────────────────────────
  // ⚠ 撞名可能是**上游后来才造成的**（B 仓新增了一个 A 仓已有的名字），用户什么都没做错。
  // 抛出去会让整条 `pep skills update` 当场中断，后面那些仓一个都刷不到。
  it("update 撞上 ⇒ 不抛、不覆盖，照常刷别的，并把它报上去", async () => {
    const store = memoryStateStore();
    await updateSkills({
      ...deps(vi.fn().mockResolvedValue(skillNamed("A 的", "a".repeat(40))), store),
      source: "repo-a",
    });
    await updateSkills({
      ...deps(
        vi.fn().mockResolvedValue(archiveResponse({ [`${ROOT}/only-b/SKILL.md`]: "B 的" }, "b".repeat(40))),
        store,
      ),
      source: "repo-b",
    });

    // B 的上游这时新增了一个也叫 semi-integration 的 skill。
    const later = archiveResponse(
      { [`${ROOT}/only-b/SKILL.md`]: "B 的 v2", [`${ROOT}/semi-integration/SKILL.md`]: "B 抢的" },
      "c".repeat(40),
    );
    const result = await updateSkills({
      ...deps(vi.fn().mockResolvedValue(later), store),
      source: "repo-b",
    });

    expect(result).toMatchObject({
      status: "written",
      updated: ["only-b"],
      conflicts: [{ skill: "semi-integration", owner: "repo-a" }],
    });
    // A 的那份原封不动 —— 让开的意思就是不碰。
    expect(await readFile(join(directory, "semi-integration", "SKILL.md"), "utf8")).toBe("A 的");
    // 而 B 自己的那个照常刷到了最新。
    expect(await readFile(join(directory, "only-b", "SKILL.md"), "utf8")).toBe("B 的 v2");
  });

  // ⚠ 落点不同就不算撞 —— 一个装个人级一个装项目级，本来互不相干。
  it("两个包装在不同目录 ⇒ 不算撞，照装", async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), "pep-other-"));
    const store = memoryStateStore();
    await updateSkills({ ...deps(vi.fn().mockResolvedValue(skillNamed("A", "a".repeat(40))), store, { restoreMissing: true }), source: "group/repo-a" });

    const b = await updateSkills({
      ...deps(vi.fn().mockResolvedValue(skillNamed("B", "b".repeat(40))), store, {
        directory: elsewhere,
        restoreMissing: true,
      }),
      source: "group/repo-b",
    });

    expect(b.status).toBe("written");
    expect(await readFile(join(elsewhere, "semi-integration", "SKILL.md"), "utf8")).toBe("B");
  });

  // ⚠ 存量的**只汇报不抛**：加这道检查时用户账上可能已经撞着了，直接抛等于给他一个
  // 解不开的错 —— update 从此跑不动，而唯一的出路 remove 是同一版才有的。
  it("存量撞名 ⇒ 不抛，但两条出口都要把它报出来", async () => {
    // 手捏一本「已经撞上了」的账 —— 正是升级上来的用户的样子。
    const store = memoryStateStore({
      version: 4,
      packages: {
        "group/repo-a": { commit: "a".repeat(40), directory, skills: { "semi-integration": "h1" } },
        "group/repo-b": { commit: "b".repeat(40), directory, skills: { "semi-integration": "h2" } },
      },
    });
    await alreadyOnDisk(directory, "semi-integration");

    // 出口一：commit 没变 ⇒ unchanged 快路。
    const fast = await updateSkills({
      ...deps(vi.fn().mockResolvedValue(skillNamed("B", "b".repeat(40))), store),
      source: "group/repo-b",
    });
    expect(fast).toMatchObject({
      status: "unchanged",
      conflicts: [{ skill: "semi-integration", owner: "group/repo-a" }],
    });

    // 出口二：commit 变了 ⇒ 真写。照写，但仍要报。
    const written = await updateSkills({
      ...deps(vi.fn().mockResolvedValue(skillNamed("B2", "c".repeat(40))), store),
      source: "group/repo-b",
    });
    expect(written).toMatchObject({
      status: "written",
      conflicts: [{ skill: "semi-integration", owner: "group/repo-a" }],
    });
  });
});

describe("removeSkills", () => {
  const archiveOf = () =>
    archiveResponse({
      [`${ROOT}/skills/a/SKILL.md`]: "# a",
      [`${ROOT}/skills/b/SKILL.md`]: "# b",
    });

  it("删掉它铺的那些，并从账上摘掉", async () => {
    const link = await mkdtemp(join(tmpdir(), "pep-link-"));
    const store = memoryStateStore();
    await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store, { linkInto: link }));

    const result = await removeSkills("group/sub/repo", store);

    expect(result).toMatchObject({ deleted: ["a", "b"], keptForOthers: [] });
    expect(await readdir(directory)).toEqual([]);
    // canonical 与链接两处都清 —— 只清一边会留下一条指向空处的死链。
    expect(await readdir(link)).toEqual([]);
    expect(store.current?.packages["group/sub/repo"]).toBeUndefined();
  });

  it("别的包的账与文件一概不碰", async () => {
    const store = memoryStateStore();
    await updateSkills(deps(vi.fn().mockResolvedValue(archiveOf()), store));
    // 用户自己放的东西。
    await alreadyOnDisk(directory, "mine-by-hand");

    await removeSkills("group/sub/repo", store);

    expect(await readdir(directory)).toEqual(["mine-by-hand"]);
  });

  it("没装过的 ⇒ 说清楚，并指向 list", async () => {
    await expect(removeSkills("group/never", memoryStateStore())).rejects.toThrow(
      /Not added: group\/never.*pep skills list/s,
    );
  });

  // ⚠ 撞名那一档**不删文件**：盘上那份归谁已经说不清（谁最后 update 谁赢），
  // 删了就可能是在删另一个包的内容。
  it("另一个包也占着这个名字 ⇒ 摘账、留文件、如实说", async () => {
    const store = memoryStateStore({
      version: 4,
      packages: {
        "group/repo-a": { directory, skills: { "semi-integration": "h1" } },
        "group/repo-b": { directory, skills: { "semi-integration": "h2" } },
      },
    });
    await alreadyOnDisk(directory, "semi-integration");

    const result = await removeSkills("group/repo-b", store);

    expect(result).toMatchObject({
      deleted: [],
      keptForOthers: [{ skill: "semi-integration", owner: "group/repo-a" }],
    });
    expect(await readdir(directory)).toEqual(["semi-integration"]);
    expect(store.current?.packages["group/repo-b"]).toBeUndefined();
    expect(store.current?.packages["group/repo-a"]).toBeDefined();
  });
});

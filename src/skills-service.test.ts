import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSkillFiles, updateSkills } from "./skills-service.js";
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

const deps = (fetchImpl: unknown, stateStore: SkillsStateStore) => ({
  issuer: "https://pep.example.com",
  accessToken: "tok",
  source: "group/sub/repo",
  directory,
  stateStore,
  fetch: fetchImpl as typeof globalThis.fetch,
});

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
    expect(store.current?.version).toBe(3);
    expect(pkg?.commit).toBe(COMMIT);
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
      version: 3,
      directory,
      packages: { "group/sub/repo": { commit: COMMIT, skills: { "a": "h" } } },
    });

    expect(await updateSkills(deps(fetchImpl, store))).toEqual({
      status: "unchanged",
      name: "group/sub/repo",
      commit: COMMIT,
    });
    expect(await readdir(directory)).toEqual([]);
  });

  it("提交没变但换了目录 ⇒ 照写（新目录里还什么都没有）", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );
    const store = memoryStateStore({
      version: 3,
      directory: "/somewhere/else",
      packages: { "group/sub/repo": { commit: COMMIT, skills: { "a": "h" } } },
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
          version: 3,
          directory,
          packages: { "group/sub/repo": { skills: { "a": "h" } } },
        }),
      ),
    );

    expect(await readdir(join(directory, "a"))).toEqual(["SKILL.md"]);
  });

  it("上一次写过、这次没有了的 skill 被移除", async () => {
    await mkdir(join(directory, "gone"), { recursive: true });
    await writeFile(join(directory, "gone", "SKILL.md"), "旧的");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );

    const result = await updateSkills(
      deps(
        fetchImpl,
        memoryStateStore({
          version: 3,
          directory,
          packages: { "group/sub/repo": { skills: { "a": "h", "gone": "h" } } },
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
    await symlink(physical, viaSymlink, process.platform === "win32" ? "junction" : "dir");

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
      version: 3,
      directory,
      packages: { "group/sub/repo": { commit: "old", skills: { a: "", b: "" } } },
    });
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

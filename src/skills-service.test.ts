import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { planSkillFiles, syncSkills } from "./skills-service.js";
import type { SkillsState, SkillsStateStore } from "./types.js";
import type { TarEntry } from "./tar.js";

const ROOT = "agent-skills-main-0123456789abcdef0123456789abcdef01234567";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const encoder = new TextEncoder();

const tarEntry = (path: string, body = ""): TarEntry => ({
  path,
  data: encoder.encode(body),
});

describe("planSkillFiles —— 剥两层前缀", () => {
  it("剥掉归档根与 skills/，剩下的第一段就是 skill 名", () => {
    expect(
      planSkillFiles([
        tarEntry(`${ROOT}/skills/coding/SKILL.md`, "# coding"),
        tarEntry(`${ROOT}/skills/coding/references/audit.md`, "# audit"),
      ]),
    ).toEqual([
      { skill: "coding", path: "SKILL.md", data: encoder.encode("# coding") },
      {
        skill: "coding",
        path: "references/audit.md",
        data: encoder.encode("# audit"),
      },
    ]);
  });

  // 判断「在不在」而不是硬剥第二层：上游哪天改了打包范围，这里不该把 skill 名字当成它。
  it("归档里没有 skills/ 这一层时，只剥归档根", () => {
    expect(planSkillFiles([tarEntry(`${ROOT}/coding/SKILL.md`)])).toEqual([
      { skill: "coding", path: "SKILL.md", data: encoder.encode("") },
    ]);
  });

  it("归档根下的散文件不属于任何 skill，跳过", () => {
    expect(
      planSkillFiles([
        tarEntry(`${ROOT}/README.md`),
        tarEntry(`${ROOT}/skills/README.md`),
        tarEntry(`${ROOT}/skills/a/SKILL.md`),
      ]).map((one) => one.skill),
    ).toEqual(["a"]);
  });

  it("多余的斜杠与 . 段忽略掉", () => {
    expect(planSkillFiles([tarEntry(`${ROOT}//skills/./a//SKILL.md`)])).toEqual(
      [{ skill: "a", path: "SKILL.md", data: encoder.encode("") }],
    );
  });

  // ⚠ tar-slip：一条 `../../.ssh/authorized_keys` 能让写盘跳出目标目录。归档来自我们自己的
  // PEP + 自己的 GitLab，所以出现它不是常规情况，是信号 —— 抛，不是跳过。
  it("想跳出目录的条目 ⇒ 抛，整次同步作废", () => {
    expect(() =>
      planSkillFiles([tarEntry(`${ROOT}/skills/../../.ssh/authorized_keys`)]),
    ).toThrow(/escapes its directory/);
  });
});

/** 内存里的账本，省得测试碰真配置目录。 */
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
  directory,
  stateStore,
  fetch: fetchImpl as typeof globalThis.fetch,
});

describe("syncSkills —— 失败的归因", () => {
  it.each([
    [401, /pep auth login/],
    // ⚠ 403 必须指向**客户端的 allowed_scopes**，不是 DEFAULT_SCOPES —— 后者是 CLI 曾经
    // 不申请这个 scope 时的说法，留着会把人指去改一个已经对了的地方。
    [403, /allowed_scopes in PEP/],
    // ⚠ 404 要有自己的一句：最常见的成因是端点还没部署，兜底的「answered 404」说不出这件事。
    [404, /does not serve skills/],
    [503, /could not reach the skills repository/],
    [500, /answered 500/],
  ])("%i ⇒ 说清楚下一步该做什么", async (status, expected) => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status }));
    await expect(
      syncSkills(deps(fetchImpl, memoryStateStore())),
    ).rejects.toThrow(expected);
  });
});

describe("syncSkills —— 落盘", () => {
  it("按 skill 铺开，目录自己建", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      archiveResponse({
        [`${ROOT}/skills/a/SKILL.md`]: "# a",
        [`${ROOT}/skills/a/references/x.md`]: "# x",
        [`${ROOT}/skills/b/SKILL.md`]: "# b",
      }),
    );
    const store = memoryStateStore();

    const result = await syncSkills(deps(fetchImpl, store));

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
    expect(store.current).toMatchObject({
      version: 1,
      commit: COMMIT,
      skills: ["a", "b"],
    });
  });

  it("带上 Bearer 打 /api/skills/archive", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(archiveResponse({}));
    await syncSkills(deps(fetchImpl, memoryStateStore()));
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://pep.example.com/api/skills/archive",
      {
        headers: { Authorization: "Bearer tok" },
      },
    );
  });

  it("同一个提交 ⇒ 不解包、不写盘", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );
    const store = memoryStateStore({
      version: 1,
      commit: COMMIT,
      skills: ["a"],
      directory,
    });

    expect(await syncSkills(deps(fetchImpl, store))).toEqual({
      status: "unchanged",
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
      version: 1,
      commit: COMMIT,
      skills: ["a"],
      directory: "/somewhere/else",
    });

    expect((await syncSkills(deps(fetchImpl, store))).status).toBe("written");
  });

  it("服务端没给提交号 ⇒ 照写，账上不记 commit", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }, null),
      );
    const store = memoryStateStore();

    const result = await syncSkills(deps(fetchImpl, store));
    expect(result).toMatchObject({ status: "written" });
    expect(result).not.toHaveProperty("commit");
    expect(store.current?.commit).toBeUndefined();
  });

  it("上游删掉的文件，本地跟着消失（先删后写）", async () => {
    await mkdir(join(directory, "a"), { recursive: true });
    await writeFile(join(directory, "a", "stale.md"), "老的");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        archiveResponse({ [`${ROOT}/skills/a/SKILL.md`]: "# a" }),
      );

    await syncSkills(
      deps(
        fetchImpl,
        memoryStateStore({ version: 1, skills: ["a"], directory }),
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

    const result = await syncSkills(
      deps(
        fetchImpl,
        memoryStateStore({ version: 1, skills: ["a", "gone"], directory }),
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

    await syncSkills(deps(fetchImpl, memoryStateStore()));

    expect((await readdir(directory)).sort()).toEqual(["a", "mine"]);
    expect(await readFile(join(directory, "mine", "SKILL.md"), "utf8")).toBe(
      "我自己写的",
    );
  });
});

import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileSkillsStateStore, LEGACY_PACKAGE, migrateSkillsState } from "./config.js";

async function stateFile(contents: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pep-state-"));
  const path = join(dir, "skills.json");
  await writeFile(path, JSON.stringify(contents), "utf8");
  return path;
}

// ⚠ 这些 skill 名记的是「哪些目录是我们铺的」，也就是「哪些允许被删」。迁移时丢了的话，
// 上游删掉一个 skill，本地那份会永远留着没人清 —— 所以每条断言都盯着「名字一个不丢」。
//
// ⚠ 哈希一律填**空串**而不是编一个：空串在 `update` 里当作「变了」。把「不知道」说成
// 「没变」会让迁移后的第一次 update 漏掉真正的更新。
describe("v1 → v4 迁移", () => {
  it("扁的那一层归到兼容包名下，名字一个不丢，哈希留空", () => {
    expect(
      migrateSkillsState({
        version: 1,
        commit: "abc",
        skills: ["a", "b"],
        directory: "/d",
        linkedInto: "/c",
      }),
    ).toEqual({
      version: 4,
      packages: {
        [LEGACY_PACKAGE]: {
          commit: "abc",
          directory: "/d",
          linkedInto: "/c",
          skills: { a: "", b: "" },
        },
      },
    });
  });

  it("没有 commit / linkedInto 的老账也迁得动（0.1.1 之前写的没这两个键）", () => {
    expect(migrateSkillsState({ version: 1, skills: [], directory: "/d" })).toEqual({
      version: 4,
      packages: { [LEGACY_PACKAGE]: { directory: "/d", skills: {} } },
    });
  });

  it("store 读到 v1 的盘文件时自动迁移", async () => {
    const path = await stateFile({ version: 1, commit: "abc", skills: ["a"], directory: "/d" });
    expect(await fileSkillsStateStore(path).read()).toEqual({
      version: 4,
      packages: { [LEGACY_PACKAGE]: { commit: "abc", directory: "/d", skills: { a: "" } } },
    });
  });
});

describe("v2 → v4 迁移", () => {
  it("每个包的名字数组变成「名字 → 空哈希」，包名与 commit 原样", () => {
    expect(
      migrateSkillsState({
        version: 2,
        directory: "/d",
        packages: {
          "group/one": { commit: "c1", skills: ["a", "b"] },
          "group/two": { skills: ["c"] },
        },
      }),
    ).toEqual({
      version: 4,
      packages: {
        "group/one": { commit: "c1", directory: "/d", skills: { a: "", b: "" } },
        "group/two": { directory: "/d", skills: { c: "" } },
      },
    });
  });

  it("store 读到 v2 的盘文件时自动迁移", async () => {
    const path = await stateFile({
      version: 2,
      directory: "/d",
      packages: { "g/r": { commit: "c", skills: ["x"] } },
    });
    expect(await fileSkillsStateStore(path).read()).toEqual({
      version: 4,
      packages: { "g/r": { commit: "c", directory: "/d", skills: { x: "" } } },
    });
  });
});

// ⚠ 这一组与 v1 / v2 那两组有一处**关键的不同**：v3 的哈希是**真哈希**，迁移时必须原样
// 保留。跟着 v1/v2 一起清成空串的话，每个存量用户的下一次 update 会把所有 skill 都报成
// 「更新了」—— 那正是 v3 当初引入哈希要消掉的噪音。
describe("v3 → v4 迁移", () => {
  it("顶层那一份落点抄进每个包，哈希原样保留（不清成空串）", () => {
    expect(
      migrateSkillsState({
        version: 3,
        directory: "/d",
        linkedInto: "/c",
        packages: {
          "group/one": { commit: "c1", skills: { a: "h1", b: "h2" } },
          "group/two": { skills: { c: "h3" } },
        },
      }),
    ).toEqual({
      version: 4,
      packages: {
        "group/one": { commit: "c1", directory: "/d", linkedInto: "/c", skills: { a: "h1", b: "h2" } },
        "group/two": { directory: "/d", linkedInto: "/c", skills: { c: "h3" } },
      },
    });
  });

  it("没有 linkedInto（上次用了 --dir）时不凭空造一个", () => {
    const migrated = migrateSkillsState({
      version: 3,
      directory: "/only-here",
      packages: { x: { skills: { a: "h1" } } },
    });
    expect(migrated.packages.x).toEqual({ directory: "/only-here", skills: { a: "h1" } });
    expect("linkedInto" in (migrated.packages.x as object)).toBe(false);
  });

  it("store 读到 v3 的盘文件时自动迁移", async () => {
    const path = await stateFile({
      version: 3,
      directory: "/d",
      packages: { "g/r": { commit: "c", skills: { x: "h" } } },
    });
    expect(await fileSkillsStateStore(path).read()).toEqual({
      version: 4,
      packages: { "g/r": { commit: "c", directory: "/d", skills: { x: "h" } } },
    });
  });
});

describe("v4 与坏账", () => {
  it("v4 原样读出", async () => {
    const v4 = {
      version: 4,
      packages: {
        x: { directory: "/d", linkedInto: "/c", skills: { a: "h1" } },
        // ⚠ 两个包各记各的落点 —— 这就是 v4 存在的理由，读回来时不能被归并成一个。
        y: { directory: "/elsewhere", skills: { b: "h2" } },
      },
    };
    expect(await fileSkillsStateStore(await stateFile(v4)).read()).toEqual(v4);
  });

  // 账坏了不该让更新停摆 —— 当成「没装过」重来一遍即可，代价只是多写一次盘。
  // 这跟 config 不同：那个坏了就登不上，必须让人看见。
  it.each([
    ["认不出的版本", { version: 99, packages: {} }],
    // ⚠ 数组在 JS 里也是 object，漏了 Array.isArray 的话这条会被当成合法账收下，
    // 之后 `state.packages[source]` 拿到的是下标而不是地址。
    ["packages 是数组", { version: 4, packages: [] }],
    ["包是数组", { version: 4, packages: { x: [] } }],
    ["skills 还是数组", { version: 4, packages: { x: { directory: "/d", skills: ["a"] } } }],
    ["哈希不是字符串", { version: 4, packages: { x: { directory: "/d", skills: { a: 1 } } } }],
    // ⚠ v4 起落点在包里，缺了就是坏账 —— 收下它的后果是拿 undefined 去 join 路径。
    ["包里缺 directory", { version: 4, packages: { x: { skills: { a: "h" } } } }],
    ["包里的 directory 不是字符串", { version: 4, packages: { x: { directory: 1, skills: {} } } }],
    [
      "包里的 linkedInto 不是字符串",
      { version: 4, packages: { x: { directory: "/d", linkedInto: 1, skills: {} } } },
    ],
    // 顶层落点是 v3 的形状；带着 version: 4 出现说明这账是手改坏的。
    ["v3 的形状却标着 version 4", { version: 4, directory: "/d", packages: { x: { skills: {} } } }],
  ])("%s ⇒ 当作没装过（null），不抛", async (_label, bad) => {
    expect(await fileSkillsStateStore(await stateFile(bad)).read()).toBeNull();
  });

  it.each([1, 2, 3])("迁移后写回盘上的是 v4（从 v%i 来）", async (from) => {
    const old =
      from === 1
        ? { version: 1, skills: ["a"], directory: "/d" }
        : from === 2
          ? { version: 2, directory: "/d", packages: { p: { skills: ["a"] } } }
          : { version: 3, directory: "/d", packages: { p: { skills: { a: "h" } } } };
    const path = await stateFile(old);
    const store = fileSkillsStateStore(path);
    await store.write((await store.read()) as never);
    const written = JSON.parse(await readFile(path, "utf8"));
    expect(written.version).toBe(4);
    // 落点搬进包里之后，顶层那一份必须**消失** —— 留着会让下一个读的人以为它还有效。
    expect(written.directory).toBeUndefined();
    expect(Object.values(written.packages).every((one: any) => one.directory === "/d")).toBe(true);
  });
});

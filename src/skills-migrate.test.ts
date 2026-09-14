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
describe("v1 → v3 迁移", () => {
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
      version: 3,
      directory: "/d",
      linkedInto: "/c",
      packages: { [LEGACY_PACKAGE]: { commit: "abc", skills: { a: "", b: "" } } },
    });
  });

  it("没有 commit / linkedInto 的老账也迁得动（0.1.1 之前写的没这两个键）", () => {
    expect(migrateSkillsState({ version: 1, skills: [], directory: "/d" })).toEqual({
      version: 3,
      directory: "/d",
      packages: { [LEGACY_PACKAGE]: { skills: {} } },
    });
  });

  it("store 读到 v1 的盘文件时自动迁移", async () => {
    const path = await stateFile({ version: 1, commit: "abc", skills: ["a"], directory: "/d" });
    expect(await fileSkillsStateStore(path).read()).toEqual({
      version: 3,
      directory: "/d",
      packages: { [LEGACY_PACKAGE]: { commit: "abc", skills: { a: "" } } },
    });
  });
});

describe("v2 → v3 迁移", () => {
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
      version: 3,
      directory: "/d",
      packages: {
        "group/one": { commit: "c1", skills: { a: "", b: "" } },
        "group/two": { skills: { c: "" } },
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
      version: 3,
      directory: "/d",
      packages: { "g/r": { commit: "c", skills: { x: "" } } },
    });
  });
});

describe("v3 与坏账", () => {
  it("v3 原样读出", async () => {
    const v3 = { version: 3, directory: "/d", packages: { x: { skills: { a: "h1" } } } };
    expect(await fileSkillsStateStore(await stateFile(v3)).read()).toEqual(v3);
  });

  // 账坏了不该让更新停摆 —— 当成「没装过」重来一遍即可，代价只是多写一次盘。
  // 这跟 config 不同：那个坏了就登不上，必须让人看见。
  it.each([
    ["认不出的版本", { version: 99, directory: "/d" }],
    // ⚠ 数组在 JS 里也是 object，漏了 Array.isArray 的话这条会被当成合法账收下，
    // 之后 `state.packages[source]` 拿到的是下标而不是地址。
    ["packages 是数组", { version: 3, directory: "/d", packages: [] }],
    ["包是数组", { version: 3, directory: "/d", packages: { x: [] } }],
    [
      "skills 还是数组（v3 要 map）",
      { version: 3, directory: "/d", packages: { x: { skills: ["a"] } } },
    ],
    ["哈希不是字符串", { version: 3, directory: "/d", packages: { x: { skills: { a: 1 } } } }],
    ["缺 directory", { version: 3, packages: {} }],
  ])("%s ⇒ 当作没装过（null），不抛", async (_label, bad) => {
    expect(await fileSkillsStateStore(await stateFile(bad)).read()).toBeNull();
  });

  it("迁移后写回盘上的是 v3", async () => {
    const path = await stateFile({ version: 1, skills: ["a"], directory: "/d" });
    const store = fileSkillsStateStore(path);
    await store.write((await store.read()) as never);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
  });
});

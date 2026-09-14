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

describe("v1 → v2 迁移", () => {
  // ⚠ 那一串 skill 名记的是「哪些目录是我们铺的」，也就是「哪些允许被删」。丢了的话，
  // 上游删掉一个 skill，本地那份会永远留着没人清。
  it("skill 名归到兼容包名下，一个不丢", () => {
    expect(
      migrateSkillsState({
        version: 1,
        commit: "abc",
        skills: ["a", "b"],
        directory: "/d",
        linkedInto: "/c",
      }),
    ).toEqual({
      version: 2,
      directory: "/d",
      linkedInto: "/c",
      packages: { [LEGACY_PACKAGE]: { commit: "abc", skills: ["a", "b"] } },
    });
  });

  it("没有 commit / linkedInto 的老账也迁得动（0.1.1 之前写的没这两个键）", () => {
    expect(migrateSkillsState({ version: 1, skills: [], directory: "/d" })).toEqual({
      version: 2,
      directory: "/d",
      packages: { [LEGACY_PACKAGE]: { skills: [] } },
    });
  });

  it("store 读到 v1 的盘文件时自动迁移", async () => {
    const path = await stateFile({ version: 1, commit: "abc", skills: ["a"], directory: "/d" });
    const state = await fileSkillsStateStore(path).read();
    expect(state).toEqual({
      version: 2,
      directory: "/d",
      packages: { [LEGACY_PACKAGE]: { commit: "abc", skills: ["a"] } },
    });
  });

  it("v2 原样读出", async () => {
    const v2 = { version: 2, directory: "/d", packages: { x: { skills: ["a"] } } };
    expect(await fileSkillsStateStore(await stateFile(v2)).read()).toEqual(v2);
  });

  // 账坏了不该让同步停摆 —— 当成「没同步过」重来一遍即可，代价只是多写一次盘。
  it.each([
    ["认不出的版本", { version: 99, directory: "/d" }],
    ["packages 不是对象", { version: 2, directory: "/d", packages: [] }],
    ["包里 skills 不是字符串数组", { version: 2, directory: "/d", packages: { x: { skills: [1] } } }],
    ["缺 directory", { version: 2, packages: {} }],
  ])("%s ⇒ 当作没同步过（null），不抛", async (_label, bad) => {
    expect(await fileSkillsStateStore(await stateFile(bad)).read()).toBeNull();
  });

  it("迁移后写回盘上的是 v2", async () => {
    const path = await stateFile({ version: 1, skills: ["a"], directory: "/d" });
    const store = fileSkillsStateStore(path);
    await store.write((await store.read()) as never);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  });
});

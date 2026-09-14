import { describe, expect, it } from "vitest";
import { planSkillFiles } from "./skills-service.js";

const ROOT = "semi-integration-skill-feature-online-5998f9ab-";
const bytes = (s: string) => new TextEncoder().encode(s);
const at = (path: string, body = "x") => ({ path: `${ROOT}/${path}`, data: bytes(body) });

/** 摊平成 `skill → 路径列表`，断言好读。 */
function grouped(entries: { path: string; data: Uint8Array }[]) {
  const out = new Map<string, string[]>();
  for (const f of planSkillFiles(entries)) {
    if (!out.has(f.skill)) out.set(f.skill, []);
    out.get(f.skill)!.push(f.path);
  }
  return Object.fromEntries([...out].map(([k, v]) => [k, v.sort()]));
}

describe("靠 SKILL.md 定位", () => {
  // 这就是真实那个仓的形状：skill 在仓根下，旁边还有 evals/ 和 README.md。
  it("含 SKILL.md 的目录成为 skill，兄弟目录不受影响", () => {
    expect(
      grouped([
        at("semi-integration-skill/SKILL.md"),
        at("semi-integration-skill/docs/Overview.md"),
        at("semi-integration-skill/assets/wizard.html"),
        at("evals/case.yaml"),
        at("README.md"),
      ]),
    ).toEqual({
      "semi-integration-skill": ["SKILL.md", "assets/wizard.html", "docs/Overview.md"],
    });
  });

  // 旧布局（`skills/<名字>/SKILL.md`）必须照样得能用 —— 那是官方约定，不能因为改了定位方式就废掉。
  it("`skills/<名字>/` 那种老布局照样认，且 `skills` 不会被当成 skill 名", () => {
    expect(
      grouped([
        at("skills/alpha/SKILL.md"),
        at("skills/alpha/ref.md"),
        at("skills/beta/SKILL.md"),
      ]),
    ).toEqual({ alpha: ["SKILL.md", "ref.md"], beta: ["SKILL.md"] });
  });

  it("一个仓里多个 skill 各算各的", () => {
    const g = grouped([at("a/SKILL.md"), at("b/SKILL.md"), at("b/x.md")]);
    expect(Object.keys(g).sort()).toEqual(["a", "b"]);
  });

  // ⚠ 没有 SKILL.md 的目录一个文件都不该带下来 —— 老实现按层级猜，会把 evals/ 当成 skill。
  it("没有 SKILL.md 的目录整个落不进来", () => {
    expect(grouped([at("evals/a/b.yaml"), at("scripts/run.sh"), at("README.md")])).toEqual({});
  });

  it("嵌套时归最深的那个，不被外层吞掉", () => {
    expect(
      grouped([at("a/SKILL.md"), at("a/note.md"), at("a/b/SKILL.md"), at("a/b/deep.md")]),
    ).toEqual({ a: ["SKILL.md", "note.md"], b: ["SKILL.md", "deep.md"] });
  });

  // 归档根自己带 SKILL.md 时没有名字可用 —— 归档根是 `<项目>-<ref>-<sha>`，每次同步都不一样，
  // 拿它当 skill 名会让每同步一次就多一个目录。
  it("归档根直接放 SKILL.md ⇒ 跳过，不拿带 sha 的根目录名当 skill 名", () => {
    expect(grouped([at("SKILL.md"), at("x.md")])).toEqual({});
  });

  it("点开头的目录照常带下来（插件清单就在 .claude-plugin/ 里）", () => {
    expect(grouped([at("a/SKILL.md"), at("a/.claude-plugin/plugin.json")])).toEqual({
      a: [".claude-plugin/plugin.json", "SKILL.md"],
    });
  });

  // tar-slip：归档来自我们自己的 PEP + 自己的 GitLab，所以这不是常规情况，是信号。
  it("条目想跳出目标目录 ⇒ 抛，不是跳过", () => {
    expect(() => planSkillFiles([at("a/../../.ssh/authorized_keys")])).toThrow(/escapes/);
  });
});

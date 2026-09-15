import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loginConfig, parseSkillsArgs, targetForSource } from "./cli.js";
import {
  claudeSkillsDirectory,
  defaultSkillsDirectory,
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  DEFAULT_RESOURCES,
} from "./config.js";
import type { CliConfig, ConfigStore } from "./types.js";

/** 只读桩：loginConfig 只调 read()，写是 auth-service 登录成功之后的事。 */
function storeWith(saved: CliConfig | null): ConfigStore {
  return {
    read: async () => saved,
    write: async () => {
      throw new Error("loginConfig 不该写配置");
    },
    delete: async () => {
      throw new Error("loginConfig 不该删配置");
    },
  };
}

const STALE: CliConfig = {
  version: 1,
  issuer: "https://pep-webapp-view.onrender.com",
  clientId: "1b916aae96f69a535d7a1a30c8f2e1dc", // 早期版本烘进去的随机串
  redirectUri: "http://localhost:53682/callback",
  resources: ["urn:newland:pep:probe"],
  docsUrl: "https://docs.example.com",
};

// ⚠ 这一组钉的是「存量配置不得影响新登录」。2026-09-10 真的发生过：用户本地留着早期版本
// 存下的随机 client_id，装了新包之后每次登录都回 2D002 invalid_client —— 而那句文案
// （"This application is not authorized to sign you in"）完全指不到本地配置。
describe("loginConfig 不继承上次登录的环境三项", () => {
  it("存量 clientId 压不过包里的默认值", async () => {
    const config = await loginConfig([], storeWith(STALE));
    expect(config.clientId).toBe(DEFAULT_CLIENT_ID);
  });

  it("存量 issuer 压不过包里的默认值", async () => {
    const config = await loginConfig([], storeWith(STALE));
    expect(config.issuer).toBe(DEFAULT_ISSUER);
  });

  it("存量 resources 压不过包里的默认值", async () => {
    const config = await loginConfig([], storeWith(STALE));
    expect(config.resources).toEqual([...DEFAULT_RESOURCES]);
  });

  it("显式参数仍然优先", async () => {
    const config = await loginConfig(
      ["--issuer", "https://explicit.example.com", "--client-id", "custom"],
      storeWith(STALE),
    );
    expect(config.issuer).toBe("https://explicit.example.com");
    expect(config.clientId).toBe("custom");
  });
});

// docsUrl 是例外：它每次 docs 命令都要用、不参与环境绑定。login 会整体覆写 config.json，
// 所以必须显式结转 —— 不结转的话，重新登录一次就把用户设过的文档地址抹掉了。
describe("loginConfig 结转 docsUrl", () => {
  it("已有的 docsUrl 被带过来", async () => {
    const config = await loginConfig([], storeWith(STALE));
    expect(config.docsUrl).toBe("https://docs.example.com");
  });

  it("没有配置文件时不无中生有", async () => {
    const config = await loginConfig([], storeWith(null));
    expect(config.docsUrl).toBeUndefined();
    expect(config.clientId).toBe(DEFAULT_CLIENT_ID);
  });
});

describe("parseSkillsArgs —— 选项先摘，位置参数后取", () => {
  // ⚠ 这一组钉的是一个**真出过的 bug**：2026-09-15 之前，`update` 那侧先按「不以 `--`
  // 开头」捞位置参数，而 `--dir <path>` 的值恰好不以 `--` 开头，于是它被当成仓库名吃掉，
  // `option()` 再去找就只剩一个光杆 `--dir`。表现是 `pep skills update --dir <path>`
  // **无论怎么写都报「--dir requires a value.」**，这条路径整个用不了。
  it.each([
    ["不带包名", [] as string[]],
    ["带一个包名", ["group/repo"]],
    ["带两个包名", ["group/one", "group/two"]],
  ])("update %s + --dir 不再把路径吃成包名", (_label, packages) => {
    const parsed = parseSkillsArgs("update", [...packages, "--dir", "/tmp/here"]);
    expect(parsed.chosenTarget).toEqual({ directory: "/tmp/here" });
    expect(parsed.named).toEqual(packages);
  });

  it("--dir 写在包名前面也一样", () => {
    const parsed = parseSkillsArgs("update", ["--dir", "/tmp/here", "group/repo"]);
    expect(parsed.chosenTarget).toEqual({ directory: "/tmp/here" });
    expect(parsed.named).toEqual(["group/repo"]);
  });

  it("add 取恰好一个位置参数", () => {
    const parsed = parseSkillsArgs("add", ["group/repo", "--dir", "/tmp/here"]);
    expect(parsed.requested).toBe("group/repo");
    expect(parsed.named).toEqual([]);
  });

  it("add 多给一个位置参数 ⇒ 说出来，而不是默默忽略", () => {
    expect(() => parseSkillsArgs("add", ["group/one", "group/two"])).toThrow(/Unexpected argument/);
  });

  it("add 不给仓库 ⇒ 说清楚该给什么", () => {
    expect(() => parseSkillsArgs("add", [])).toThrow(/needs a repository/);
  });

  it("不认识的选项照旧报出来", () => {
    expect(() => parseSkillsArgs("update", ["--wat"])).toThrow(/Unknown option: --wat/);
  });

  // `--dir` 真的缺值时仍要报 —— 修的是「值被吃掉」，不是把这条校验也一起拿掉。
  it("--dir 后面确实没值 ⇒ 照报", () => {
    expect(() => parseSkillsArgs("update", ["--dir"])).toThrow(/--dir requires a value/);
  });
});

describe("parseSkillsArgs —— --project", () => {
  it("落到当前项目的 .agents/skills，并接进 .claude/skills", () => {
    const parsed = parseSkillsArgs("add", ["group/repo", "--project"], "/work/app");
    expect(parsed.chosenTarget).toEqual({
      directory: join("/work/app", ".agents", "skills"),
      linkInto: join("/work/app", ".claude", "skills"),
    });
  });

  it("--project 不会被当成位置参数", () => {
    expect(parseSkillsArgs("update", ["--project", "group/repo"], "/w").named).toEqual([
      "group/repo",
    ]);
  });

  // ⚠ 两个都给 = 两个互相矛盾的落点。挑一个去执行等于替用户猜，而猜错是**静默**铺错地方。
  it("--project 与 --dir 同时给 ⇒ 拒，不猜", () => {
    expect(() => parseSkillsArgs("add", ["g/r", "--project", "--dir", "/tmp/x"])).toThrow(
      /cannot be used together/,
    );
  });

  it("list 不收落点选项（它不写盘）", () => {
    expect(() => parseSkillsArgs("list", ["--project"])).toThrow(/Unknown option/);
    expect(() => parseSkillsArgs("list", ["--dir", "/tmp/x"])).toThrow(/Unknown option/);
  });

  it("什么都不给 ⇒ 不指定落点（留给账上那一份去答）", () => {
    expect(parseSkillsArgs("update", []).chosenTarget).toBeUndefined();
  });
});

describe("targetForSource —— 显式 > 账上 > 个人级", () => {
  const recorded = { directory: "/proj/.agents/skills", linkedInto: "/proj/.claude/skills" };

  // ⚠ 这条是 v4 存在的理由：v3 没有「账上记的」这一档，于是 `update` 不带参数会把用
  // `--project` / `--dir` 装的包**搬回** `~/.agents/skills`，而原处那份没人清。
  it("没显式给 ⇒ 回到账上记的那个地方", () => {
    expect(targetForSource(undefined, recorded)).toEqual({
      directory: "/proj/.agents/skills",
      linkInto: "/proj/.claude/skills",
    });
  });

  it("显式给了 ⇒ 显式的赢（这就是「搬家」）", () => {
    expect(targetForSource({ directory: "/tmp/x" }, recorded)).toEqual({ directory: "/tmp/x" });
  });

  it("账上没有这个包 ⇒ 个人级默认，且带链接", () => {
    const target = targetForSource(undefined, undefined);
    expect(target.directory).toBe(defaultSkillsDirectory());
    expect(target.linkInto).toBe(claudeSkillsDirectory());
  });

  // 账上记着「上次用了 --dir」（没有 linkedInto）时不能凭空接一条链接出来 ——
  // 那会往用户明确说过「别碰」的地方写。
  it("账上没有 linkedInto ⇒ 不凭空造一条链接", () => {
    expect(targetForSource(undefined, { directory: "/only-here" })).toEqual({
      directory: "/only-here",
    });
  });
});

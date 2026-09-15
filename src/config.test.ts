import { mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as configModule from "./config.js";
import {
  configuredIssuer,
  DEFAULT_CLIENT_ID,
  DEFAULT_DOCS_URL,
  DEFAULT_ISSUER,
  fileConfigStore,
  issuerForEnvironment,
  normalizeDocsUrl,
  normalizeIssuer,
  projectSkillsTarget,
  userSkillsTarget,
} from "./config.js";

// ⚠ 这一组钉的是「client_id 不再有『环境』这个维度」。
//
// 2026-09-08 差点发出去一版「view 的地址 + dev 的客户端」——`/authorize` 回 400 且不带任何
// 解释，看着像 CLI 坏了。根因是当时 client_id 是平台登记时生成的随机串、每个部署各一枚，
// 于是它必须与 issuer 成对出现 —— 而凡是要成对的东西就能配错。2026-09-09 改成自选的固定
// 名字后，那个维度整个没了。这里钉的就是「它真的没了」：谁再把 client_id 做成按环境分的，
// 本组立刻红。
describe("client_id 不随构建环境变", () => {
  it("就是一个固定名字", () => {
    expect(DEFAULT_CLIENT_ID).toBe("pep-cli");
  });

  // 直接钉「那个函数不存在」。比断言某个返回值更贴近意图：要防的不是某个错值，
  // 而是「按环境分」这个形状被重新引进来。
  it("没有 clientIdForEnvironment 这种东西", () => {
    expect("clientIdForEnvironment" in configModule).toBe(false);
  });

  it("烘进来的 issuer 必是三档之一", () => {
    expect([
      "https://pep-webapp-dev.onrender.com",
      "https://pep-webapp-view.onrender.com",
      "https://pep.newlandnpt.us",
    ]).toContain(DEFAULT_ISSUER);
  });
});

describe("configuredIssuer", () => {
  it("uses the issuer built into the executable", () => {
    expect(configuredIssuer(undefined)).toBe("https://pep-webapp-dev.onrender.com");
  });

  it("allows --issuer to override the built-in issuer", () => {
    expect(configuredIssuer("https://explicit.example.com")).toBe(
      "https://explicit.example.com",
    );
  });

  // ⚠ 钉住「只有两档」。2026-09-09 曾加过「上次登录记住的」中间一档，次日撤回 ——
  // 它把 issuer 拉进了 clientId/resources 那套「继承上一次」语义，而那套当天就现了原形
  // （存量配置里的旧 client_id 压过新包默认值，登录一律 2D002）。谁再加回来，这里红。
  it("只有两档：显式 > 内置，没有「记住的」那一档", () => {
    expect(configuredIssuer.length).toBe(1);
  });
});

describe("issuerForEnvironment", () => {
  it("maps build environments to their fixed issuers", () => {
    expect(issuerForEnvironment("development")).toBe(
      "https://pep-webapp-dev.onrender.com",
    );
    expect(issuerForEnvironment("view")).toBe("https://pep-webapp-view.onrender.com");
    expect(issuerForEnvironment("production")).toBe("https://pep.newlandnpt.us");
  });
});

describe("normalizeIssuer", () => {
  it("removes trailing slash, query, and fragment", () => {
    expect(normalizeIssuer("https://pep.example.com/?ignored=1#fragment")).toBe(
      "https://pep.example.com",
    );
  });

  it("allows HTTP only for a local development issuer", () => {
    expect(normalizeIssuer("http://localhost:3000/")).toBe("http://localhost:3000");
    expect(() => normalizeIssuer("http://pep.example.com")).toThrow(/HTTPS/);
  });
});

describe("fileConfigStore", () => {
  it("delete 对不存在的文件是无操作，不抛", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pep-cli-config-"));
    const store = fileConfigStore(join(directory, "config.json"));

    await expect(store.delete()).resolves.toBeUndefined();
    expect(await store.read()).toBeNull();
  });

  it("写了再 delete ⇒ 读回 null", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pep-cli-config-"));
    const store = fileConfigStore(join(directory, "config.json"));
    await store.write({
      version: 1,
      issuer: "https://pep.example.com",
      clientId: "c",
      redirectUri: "http://localhost:53682/callback",
      resources: ["urn:newland:pep:probe"],
    });
    expect(await store.read()).not.toBeNull();

    await store.delete();

    expect(await store.read()).toBeNull();
  });
});

// 文档平台地址：单个常量、所有构建通用。钉住「它有一个可用的内置默认」——发布的包走
// production 构建，若这里退回 undefined，用户装完 `pep docs list` 又要手填 --docs-url。
describe("DEFAULT_DOCS_URL", () => {
  it("是一个烘进来的绝对 https 地址", () => {
    expect(DEFAULT_DOCS_URL).toBe("https://pep-developer-docs.onrender.com");
    expect(new URL(DEFAULT_DOCS_URL).protocol).toBe("https:");
  });

  // 与 issuer 刻意不同：issuer 按环境三档，文档地址不分档。谁把它做成按环境分的，这里红。
  it("没有 docsUrlForEnvironment 这种东西", () => {
    expect("docsUrlForEnvironment" in configModule).toBe(false);
  });

  // normalizeDocsUrl 是 docs 分支对 --docs-url 的归一化入口；内置默认必须已经是归一形态，
  // 否则「带参数」和「用默认」两条路会得到不同的 base，拼出来的路径也就不同。
  it("本身已是归一形态", () => {
    expect(normalizeDocsUrl(DEFAULT_DOCS_URL)).toBe(DEFAULT_DOCS_URL);
  });
});

describe("落点：个人级 vs 项目级", () => {
  // ⚠ 这两个路径不是我们定的，是 `npx skills` 那张 agent 表里的落点，照抄。对不上的后果是
  // 铺进一个没有 agent 会去读的目录，而同步照样报成功 —— 一个不会自己暴露的错误。
  it("个人级：~/.agents/skills 铺实体，~/.claude/skills 接链接", () => {
    const target = userSkillsTarget();
    expect(target.directory).toBe(join(homedir(), ".agents", "skills"));
    expect(target.linkInto).toBe(join(homedir(), ".claude", "skills"));
  });

  it("项目级：同样的两个名字，只是根换成当前项目", () => {
    expect(projectSkillsTarget("/work/app")).toEqual({
      directory: join("/work/app", ".agents", "skills"),
      linkInto: join("/work/app", ".claude", "skills"),
    });
  });

  // 形状对称是有意的：个人级与项目级都是「一份实体 + 一条链接」，只有根不同。
  // 哪天有人只给项目级加了一档特殊处理，这条会红。
  it("两级形状一致 —— 都带链接，且尾段相同", () => {
    const user = userSkillsTarget();
    const project = projectSkillsTarget("/work/app");
    const tail = (path: string) => path.split(/[/\\]/).slice(-2).join("/");
    expect(tail(project.directory)).toBe(tail(user.directory));
    expect(tail(project.linkInto as string)).toBe(tail(user.linkInto as string));
  });

  it("不给 cwd 时用当前工作目录", () => {
    expect(projectSkillsTarget().directory).toBe(join(process.cwd(), ".agents", "skills"));
  });
});

// ⚠ 版本号只有一个真源：package.json，由 `scripts/build-js.mjs` 在构建期注入。
// 源码里手抄一份漂过一次（package.json 0.3.1 / cli.ts 0.3.0），表现是 `pep --version`
// 报上一版 —— 排查线上问题的第一个问题就是「你装的是哪版」，那一步给了假话。
describe("版本号不手抄", () => {
  it("cli.ts 里没有写死的版本字面量", async () => {
    const source = await readFile(new URL("./cli.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/const VERSION = "\d+\.\d+\.\d+"/);
    expect(source).toContain("__PEP_VERSION__");
  });

  it("构建脚本确实从 package.json 注入", async () => {
    const script = await readFile(new URL("../scripts/build-js.mjs", import.meta.url), "utf8");
    expect(script).toContain("__PEP_VERSION__");
    expect(script).toContain("package.json");
  });
});

import { describe, expect, it } from "vitest";
import { loginConfig } from "./cli.js";
import { DEFAULT_CLIENT_ID, DEFAULT_ISSUER, DEFAULT_RESOURCES } from "./config.js";
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

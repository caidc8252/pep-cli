import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as configModule from "./config.js";
import {
  configuredIssuer,
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  fileConfigStore,
  issuerForEnvironment,
  normalizeIssuer,
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

  // 生产上授权服务器还没部署，演示得靠 --issuer 指到 view。不记住的话，用户此后每一条
  // login 都要重复带；忘一次就静默打回生产、在 discovery 那步失败。
  it("记住上次登录用过的 issuer", () => {
    expect(configuredIssuer(undefined, "https://pep-webapp-view.onrender.com")).toBe(
      "https://pep-webapp-view.onrender.com",
    );
  });

  it("显式 --issuer 压过记住的", () => {
    expect(configuredIssuer("https://explicit.example.com", "https://saved.example.com")).toBe(
      "https://explicit.example.com",
    );
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

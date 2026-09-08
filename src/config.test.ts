import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BuildEnvironment,
  clientIdForEnvironment,
  configuredIssuer,
  DEFAULT_CLIENT_ID,
  DEFAULT_ISSUER,
  fileConfigStore,
  issuerForEnvironment,
  normalizeIssuer,
} from "./config.js";

// ⚠ 这一组钉的是「client_id 必须跟 issuer 同环境」。2026-09-08 差点发出去一版
// 「view 的地址 + dev 的客户端」—— `/authorize` 回 400 且不带任何解释，看着像 CLI 坏了。
// `client_id` 是登记时生成的随机串、每个部署各一枚，所以它和 issuer 必须成对出现。
describe("issuer 与 client_id 必须同环境", () => {
  // 每一档写出**完整的一对**。少写一半就是这次要防的那个 bug。
  const EXPECTED: Record<BuildEnvironment, { issuer: string; clientId: string }> = {
    development: {
      issuer: "https://pep-webapp-dev.onrender.com",
      clientId: "1b916aae96f69a535d7a1a30c8f2e1dc",
    },
    view: {
      issuer: "https://pep-webapp-view.onrender.com",
      clientId: "47fa555671db11b6ef0930e476c98353",
    },
    production: {
      issuer: "https://pep.newlandnpt.us",
      clientId: "1b916aae96f69a535d7a1a30c8f2e1dc",
    },
  };

  it.each(Object.keys(EXPECTED) as BuildEnvironment[])("%s 那一对对得上", (env) => {
    expect(issuerForEnvironment(env)).toBe(EXPECTED[env].issuer);
    expect(clientIdForEnvironment(env)).toBe(EXPECTED[env].clientId);
  });

  it("构建期固化出来的那一对也是同一档", () => {
    const pair = Object.values(EXPECTED).find((one) => one.issuer === DEFAULT_ISSUER);
    expect(pair, `DEFAULT_ISSUER=${DEFAULT_ISSUER} 不属于任何一档`).toBeDefined();
    expect(DEFAULT_CLIENT_ID).toBe(pair?.clientId);
  });
});

it("uses the registered PEP CLI client ID by default", () => {
  expect(DEFAULT_CLIENT_ID).toBe("1b916aae96f69a535d7a1a30c8f2e1dc");
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

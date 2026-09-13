import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchNexusCredential, setupNexusCredential } from "./nexus-service.js";

const OK = { code: "OK", message: "success", data: { username: "pep-party-42", password: "p4ss" } };

function respond(body: unknown, status = 200): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

describe("fetchNexusCredential", () => {
  it("从信封的 data 里取 username / password", async () => {
    const credential = await fetchNexusCredential({
      issuer: "https://pep.example",
      accessToken: "t",
      fetch: respond(OK),
    });
    expect(credential).toEqual({ username: "pep-party-42", password: "p4ss" });
  });

  it("POST 到 /api/nexus/credential，带 Bearer，issuer 尾斜杠不会拼出双斜杠", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify(OK), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof globalThis.fetch;
    await fetchNexusCredential({ issuer: "https://pep.example/", accessToken: "tok", fetch: spy });
    expect(seen.url).toBe("https://pep.example/api/nexus/credential");
    expect(seen.init?.method).toBe("POST");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("403 分两种：契约不足指向商务，scope 不足指向运维", async () => {
    // 契约（32003）—— 重新登录改变不了，措辞必须说清这一点。
    await expect(
      fetchNexusCredential({
        issuer: "https://pep.example",
        accessToken: "t",
        fetch: respond({ code: "32003", message: "no" }, 403),
      }),
    ).rejects.toThrow(/contract|re-logging in will not change/i);

    // scope（32002）—— 要找运维改 allowed_scopes，不是改这个 CLI。
    const scopeFailure = fetchNexusCredential({
      issuer: "https://pep.example",
      accessToken: "t",
      fetch: respond({ code: "32002", message: "no" }, 403),
    });
    await expect(scopeFailure).rejects.toThrow(/allowed_scopes/);
    await expect(scopeFailure).rejects.toThrow(/nexus-credentials:write/);
  });

  it("409 不能读成「已经配好了」—— 密码拿不回来，必须说出来", async () => {
    await expect(
      fetchNexusCredential({
        issuer: "https://pep.example",
        accessToken: "t",
        fetch: respond({ code: "32004" }, 409),
      }),
    ).rejects.toThrow(/does not store the password|cannot be shown again/i);
  });

  it("503 是平台侧的问题，明说重试无用", async () => {
    await expect(
      fetchNexusCredential({
        issuer: "https://pep.example",
        accessToken: "t",
        fetch: respond({ code: "A0500" }, 503),
      }),
    ).rejects.toThrow(/retrying will not help/i);
  });

  it("错误体不是 JSON 也不能把 CLI 顶崩", async () => {
    const notJson = (async () => new Response("<html>502</html>", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(
      fetchNexusCredential({ issuer: "https://pep.example", accessToken: "t", fetch: notJson }),
    ).rejects.toThrow(/502/);
  });

  it("200 但少了字段 → 明确报错，不写一份半截凭据出去", async () => {
    await expect(
      fetchNexusCredential({
        issuer: "https://pep.example",
        accessToken: "t",
        fetch: respond({ code: "OK", data: { username: "u" } }),
      }),
    ).rejects.toThrow(/without a username or password/);
  });
});

describe("setupNexusCredential", () => {
  const base = {
    issuer: "https://pep.example",
    accessToken: "t",
    fetch: respond(OK),
    os: "darwin",
    now: () => new Date("2026-09-13T09:15:30.123Z"),
  };

  async function profilePath(contents?: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "pep-nexus-"));
    const path = join(dir, ".zshrc");
    if (contents !== undefined) await writeFile(path, contents, "utf8");
    return path;
  }

  it("写进 profile，并把两行交给调用方", async () => {
    const path = await profilePath();
    const result = await setupNexusCredential({ ...base, target: { kind: "profile", path } });

    expect(result.username).toBe("pep-party-42");
    expect(result.lines).toContain("export NEWLAND_MAVEN_USERNAME='pep-party-42'");
    expect(result.lines).toContain("export NEWLAND_MAVEN_PASSWORD='p4ss'");
    expect(result.persisted.status).toBe("profile-appended");
    expect(await readFile(path, "utf8")).toContain("NEWLAND_MAVEN_PASSWORD");
  });

  it("Windows 那一档给的是 cmd 语法", async () => {
    // 不真跑 setx，只钉行的形状 —— target 显式给 profile，避开子进程。
    const path = await profilePath();
    const result = await setupNexusCredential({
      ...base,
      os: "win32",
      target: { kind: "profile", path },
    });
    expect(result.lines).toBe(
      "set NEWLAND_MAVEN_USERNAME=pep-party-42\nset NEWLAND_MAVEN_PASSWORD=p4ss",
    );
  });

  // ⚠ 凭据已经从 PEP 那里换走了，而 PEP 不存密码 —— 此时抛异常等于把它扔掉，
  // 用户只能去找运维重置。所以落盘失败也必须把 `lines` 交出去。
  it("落盘失败不抛，两行照样返回", async () => {
    const path = await profilePath("# >>> pep-cli: Newland Maven credentials >>>\nexport X=1\n");
    const result = await setupNexusCredential({ ...base, target: { kind: "profile", path } });

    expect(result.persisted.status).toBe("manual");
    expect(result.lines).toContain("export NEWLAND_MAVEN_PASSWORD='p4ss'");
  });

  it("PEP 拒了就不碰文件系统 —— 失败不该留下半截产物", async () => {
    const path = await profilePath();
    await expect(
      setupNexusCredential({
        ...base,
        target: { kind: "profile", path },
        fetch: respond({ code: "32003" }, 403),
      }),
    ).rejects.toThrow();
    // 没建过那个文件，所以正确的断言是「目录仍是空的」——
    // 读一个本来就不存在的文件只会 ENOENT，证不了任何事。
    expect(await readdir(join(path, ".."))).toHaveLength(0);
  });
});

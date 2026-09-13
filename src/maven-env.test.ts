import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  exportLines,
  PASSWORD_VAR,
  persistMavenEnv,
  planProfile,
  resolveTarget,
  USERNAME_VAR,
} from "./maven-env.js";

const CRED = { username: "pep-party-42", password: "Xk9_qZ2mTb-4" };
const NOW = () => new Date("2026-09-13T09:15:30.123Z");

async function tempFile(contents?: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pep-env-"));
  const path = join(dir, ".zshrc");
  if (contents !== undefined) await writeFile(path, contents, "utf8");
  return path;
}

describe("变量名", () => {
  // ⚠ 这两个名字的唯一真源是 SDK 文档里那段 Gradle（`System.getenv("NEWLAND_MAVEN_USERNAME")`）。
  // 改这条断言之前先去核对那一段 —— 名字对不上的后果是 Gradle 拿到 null，构建时才报认证失败。
  it("与 SDK 文档里 Gradle 读的那两个一字不差", () => {
    expect(USERNAME_VAR).toBe("NEWLAND_MAVEN_USERNAME");
    expect(PASSWORD_VAR).toBe("NEWLAND_MAVEN_PASSWORD");
  });
});

describe("resolveTarget", () => {
  it("Windows 走用户级环境变量", () => {
    expect(resolveTarget("win32", undefined)).toEqual({ kind: "windows" });
  });

  it("macOS + zsh ⇒ ~/.zshrc", () => {
    const target = resolveTarget("darwin", "/bin/zsh");
    expect(target.kind).toBe("profile");
    if (target.kind !== "profile") throw new Error("unreachable");
    expect(target.path.endsWith("/.zshrc")).toBe(true);
  });

  // 登录 shell 读的是 .bash_profile 而不是 .bashrc —— 写错文件的表现是「配了但新开的终端没有」。
  it("macOS + bash ⇒ ~/.bash_profile", () => {
    const target = resolveTarget("darwin", "/bin/bash");
    if (target.kind !== "profile") throw new Error("unreachable");
    expect(target.path.endsWith("/.bash_profile")).toBe(true);
  });

  it("不是 bash 的一律按 zsh 走（macOS 自 Catalina 起的默认）", () => {
    for (const shell of ["/usr/local/bin/fish", "/bin/sh", ""]) {
      const target = resolveTarget("darwin", shell);
      if (target.kind !== "profile") throw new Error("unreachable");
      expect(target.path.endsWith("/.zshrc")).toBe(true);
    }
  });

  // ⚠ 真实环境里 `$SHELL` 没设时，走的是默认参数那一支。注意**不能**靠显式传
  // `undefined` 来模拟它 —— 那样反而会触发默认值、读到当前进程真正的 `$SHELL`，
  // 于是这条断言在 bash 机器上会红、在 zsh 机器上会绿。只能改环境变量本身。
  it("$SHELL 没设时也是 zsh", () => {
    vi.stubEnv("SHELL", "");
    try {
      const target = resolveTarget("darwin");
      if (target.kind !== "profile") throw new Error("unreachable");
      expect(target.path.endsWith("/.zshrc")).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("exportLines", () => {
  it("POSIX：export + 单引号包值，可直接 eval", () => {
    expect(exportLines(CRED, "darwin")).toBe(
      `export NEWLAND_MAVEN_USERNAME='pep-party-42'\nexport NEWLAND_MAVEN_PASSWORD='Xk9_qZ2mTb-4'`,
    );
  });

  // ⚠ 密码里出现单引号时不能就这么塞进单引号串 —— 那会提前闭合，后面的内容被 shell 当成命令。
  it("值里有单引号也不会把引号串提前闭合", () => {
    const line = exportLines({ username: "u", password: "a'b" }, "darwin");
    expect(line).toContain(`'a'\\''b'`);
  });

  // cmd.exe 的 set 不接受引号包值——引号会成为值的一部分，于是密码里凭空多两个字符。
  it("Windows：用 set，且不给值加引号", () => {
    expect(exportLines(CRED, "win32")).toBe(
      `set NEWLAND_MAVEN_USERNAME=pep-party-42\nset NEWLAND_MAVEN_PASSWORD=Xk9_qZ2mTb-4`,
    );
  });
});

describe("planProfile", () => {
  it("文件不存在 ⇒ 造一段", () => {
    const plan = planProfile(null, CRED);
    expect(plan.action).toBe("append");
    if (plan.action !== "append") throw new Error("unreachable");
    expect(plan.content).toContain("export NEWLAND_MAVEN_USERNAME='pep-party-42'");
  });

  it("已有内容但没有我们的围栏 ⇒ 追加，原文一个字节不动", () => {
    const existing = 'export PATH="$HOME/bin:$PATH"\nalias ll="ls -la"\n';
    const plan = planProfile(existing, CRED);
    if (plan.action !== "append") throw new Error("unreachable");
    expect(plan.content.startsWith(existing)).toBe(true);
    expect(plan.content).toContain(PASSWORD_VAR);
  });

  it("末尾没换行也不会跟最后一行粘住", () => {
    const plan = planProfile('alias ll="ls -la"', CRED);
    if (plan.action !== "append") throw new Error("unreachable");
    expect(plan.content).toContain('alias ll="ls -la"\n');
    expect(plan.content).not.toContain('ls -la"# >>>');
  });

  it("已有我们那一段 ⇒ 整体替换，跑几次都只有一段", () => {
    let content = 'export PATH="$HOME/bin:$PATH"\n';
    for (let i = 0; i < 3; i += 1) {
      const plan = planProfile(content, { ...CRED, password: `p${i}` });
      if (plan.action === "manual") throw new Error("unreachable");
      content = plan.content;
    }
    expect(content.match(/# >>> pep-cli/g)).toHaveLength(1);
    expect(content).toContain("'p2'");
    expect(content).not.toContain("'p0'");
    // 别人的内容还在。
    expect(content).toContain('export PATH="$HOME/bin:$PATH"');
  });

  it("替换时只动围栏之间，前后原样保留", () => {
    const first = planProfile("BEFORE\n", CRED);
    if (first.action !== "append") throw new Error("unreachable");
    const withTail = `${first.content}AFTER\n`;
    const second = planProfile(withTail, { ...CRED, password: "new" });
    if (second.action !== "replace") throw new Error("unreachable");
    expect(second.content.startsWith("BEFORE\n")).toBe(true);
    expect(second.content.endsWith("AFTER\n")).toBe(true);
    expect(second.content).toContain("'new'");
  });

  // ⚠ 半条围栏 = 边界未知。猜一个去替换，等于拿用户 profile 里别的内容去赌。
  it.each([
    ["只有开头", "# >>> pep-cli: Newland Maven credentials >>>\nexport X=1\n"],
    ["只有结尾", "export X=1\n# <<< pep-cli: Newland Maven credentials <<<\n"],
    [
      "顺序颠倒",
      "# <<< pep-cli: Newland Maven credentials <<<\n# >>> pep-cli: Newland Maven credentials >>>\n",
    ],
  ])("围栏残缺（%s）⇒ manual，不写", (_label, existing) => {
    const plan = planProfile(existing, CRED);
    expect(plan.action).toBe("manual");
  });

  it("有两段围栏 ⇒ manual，不猜该换哪一段", () => {
    const once = planProfile(null, CRED);
    if (once.action !== "append") throw new Error("unreachable");
    expect(planProfile(once.content + once.content, CRED).action).toBe("manual");
  });
});

describe("persistMavenEnv（profile 那一档）", () => {
  it("文件不存在 ⇒ 直接写，没有备份可言", async () => {
    const path = await tempFile();
    const result = await persistMavenEnv(CRED, { kind: "profile", path }, NOW);
    expect(result.status).toBe("profile-appended");
    if (result.status !== "profile-appended") throw new Error("unreachable");
    expect(result.backupPath).toBeUndefined();
    expect(await readFile(path, "utf8")).toContain(USERNAME_VAR);
  });

  it("文件已存在 ⇒ 先备份再改，备份是原文逐字节的副本", async () => {
    const original = 'export PATH="$HOME/bin:$PATH"\n';
    const path = await tempFile(original);
    const result = await persistMavenEnv(CRED, { kind: "profile", path }, NOW);
    if (result.status !== "profile-appended") throw new Error("unreachable");
    expect(result.backupPath).toBeDefined();
    expect(await readFile(result.backupPath as string, "utf8")).toBe(original);
    // 时间戳里不能有冒号 —— Windows 上那是非法文件名。
    expect((result.backupPath as string).split(/[/\\]/).pop()).not.toContain(":");
  });

  it("同一秒跑两次不会把上一次的备份盖掉，且没备份成就不动原文", async () => {
    const path = await tempFile('export PATH="$HOME/bin:$PATH"\n');
    const first = await persistMavenEnv(CRED, { kind: "profile", path }, NOW);
    expect(first.status).toBe("profile-appended");
    const afterFirst = await readFile(path, "utf8");

    // now 被钉死 ⇒ 备份名相同 ⇒ `wx` 撞上 ⇒ 必须回 manual 而不是覆盖备份。
    const second = await persistMavenEnv(CRED, { kind: "profile", path }, NOW);
    expect(second.status).toBe("manual");
    // ⚠ 关键断言：没备份成，原文就必须一个字节都没动。
    expect(await readFile(path, "utf8")).toBe(afterFirst);

    const dir = join(path, "..");
    expect((await readdir(dir)).filter((name) => name.includes(".bak-"))).toHaveLength(1);
  });

  it("围栏残缺 ⇒ 不写盘，也不留备份", async () => {
    const original = "# >>> pep-cli: Newland Maven credentials >>>\nexport X=1\n";
    const path = await tempFile(original);
    const result = await persistMavenEnv(CRED, { kind: "profile", path }, NOW);
    expect(result.status).toBe("manual");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(
      (await readdir(join(path, ".."))).filter((name) => name.includes(".bak-")),
    ).toHaveLength(0);
  });
});

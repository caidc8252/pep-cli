/**
 * 把一份 Nexus 凭据落成**两个环境变量**：`NEWLAND_MAVEN_USERNAME` / `NEWLAND_MAVEN_PASSWORD`。
 *
 * ── 为什么是环境变量，不是 `~/.m2/settings.xml`（2026-09-13 改）──────────────────
 * 因为 SDK 文档里写的就是这两个名字。`Add-SDK-Dependency` 的 Android 段：
 *
 *     maven {
 *         url 'https://maven.newlandnpt.com/repository/maven-public/'
 *         credentials {
 *             username = System.getenv("NEWLAND_MAVEN_USERNAME")
 *             password = System.getenv("NEWLAND_MAVEN_PASSWORD")
 *         }
 *     }
 *
 * 初版写的是 `settings.xml`，那是**照 `mvn` 的习惯猜的** —— 而这套 SDK 走 Gradle，根本不读
 * 那个文件。写进去的凭据不会报错，只会不生效。⚠ 这也是为什么当时怎么都找不到 `<server><id>`
 * 该填什么：Gradle 这条路压根没有 server id。现在名字有唯一真源（上面那段文档），不再需要猜，
 * 那个 `--server-id` 开关也随之整个取消。
 *
 * ⚠ 只有 **Android** 需要这一步。Windows 与 iOS 的 SDK 都是 `git clone` 取的
 * （C# 走本地 NuGet 源，iOS 直接引 framework），跟 Maven 无关。
 *
 * ── 「写入环境变量」在两个平台上不是一回事 ────────────────────────────────────
 * 子进程改不了父 shell 的环境，所以「持久化」只能落到操作系统或 shell 的配置里：
 *   · **Windows** —— `setx`，写进用户级注册表环境。**对已经开着的窗口无效**，要开新窗口。
 *   · **macOS**  —— 没有等价物，只能往 shell 的 profile 里写一段（`~/.zshrc` /
 *     `~/.bash_profile`）。那是**用户自己的文件**，所以照搬改 XML 那一套纪律：先备份、
 *     只动我们自己那一段、认不出就不写。
 *
 * 凭据只写入本地配置，不输出到终端。配置完成后需要打开新终端。
 */
import { readFile, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Gradle 读的那两个名字。**唯一真源是 SDK 文档**，不是这里 —— 改之前先去核对那一段。 */
export const USERNAME_VAR = "NEWLAND_MAVEN_USERNAME";
export const PASSWORD_VAR = "NEWLAND_MAVEN_PASSWORD";

/** profile 里我们那一段的围栏。认段落靠它，所以**改了就等于换了一段**，别动。 */
const BEGIN = "# >>> pep-cli: Newland Maven credentials >>>";
const END = "# <<< pep-cli: Newland Maven credentials <<<";

export type MavenCredential = { username: string; password: string };

export type MavenEnvTarget =
  /** Windows：写用户级环境变量。 */
  | { kind: "windows" }
  /** macOS：往这个 profile 文件里写一段。 */
  | { kind: "profile"; path: string };

/**
 * 这台机器该往哪儿写。
 *
 * macOS 上按 `$SHELL` 选文件：zsh 是 Catalina 起的默认，bash 用 `~/.bash_profile`
 * （登录 shell 读的是它，不是 `~/.bashrc`）。认不出就按 zsh 走 —— 猜错的后果只是
 * 「写进了一个这台机器不读的文件」，而命令会把路径打出来，用户一眼能看出不对。
 */
export function resolveTarget(
  os: string = platform(),
  shell: string | undefined = process.env.SHELL,
): MavenEnvTarget {
  if (os === "win32") return { kind: "windows" };
  const file = shell?.endsWith("/bash") ? ".bash_profile" : ".zshrc";
  return { kind: "profile", path: join(homedir(), file) };
}

/** POSIX shell 的单引号转义：把值整个包进单引号，内部的单引号用 `'\''` 断开再接上。 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** profile 里我们那一段的完整文本（含围栏）。 */
function profileBlock(credential: MavenCredential): string {
  return [
    BEGIN,
    "# 由 `pep nexus setup` 写入。这一段会被下一次运行整体替换，手改无效。",
    `export ${USERNAME_VAR}=${shellQuote(credential.username)}`,
    `export ${PASSWORD_VAR}=${shellQuote(credential.password)}`,
    END,
  ].join("\n");
}

export type ProfilePlan =
  | { action: "append"; content: string }
  | { action: "replace"; content: string }
  /** 围栏残缺（只有一半）—— 不猜边界在哪，交给人。 */
  | { action: "manual"; reason: string };

/**
 * 纯函数：给定 profile 现有内容（`null` = 文件不存在），算出要写什么。
 *
 * ⚠ 只有**两条围栏都在、且顺序正确**才替换。见到半条就回 `manual`：那说明有人手改过、
 * 或上一次写到一半断了，而此时「我们那一段」的边界是未知的 —— 猜一个边界去替换，等于
 * 拿用户 profile 里的别的内容去赌。
 */
export function planProfile(existing: string | null, credential: MavenCredential): ProfilePlan {
  const block = profileBlock(credential);
  if (existing === null || existing.trim() === "") {
    return { action: "append", content: `${block}\n` };
  }

  const begin = existing.indexOf(BEGIN);
  const end = existing.indexOf(END);
  if (begin === -1 && end === -1) {
    // 末尾没有换行的话先补一个，否则新段会跟最后一行粘在一起。
    const separator = existing.endsWith("\n") ? "" : "\n";
    return { action: "append", content: `${existing}${separator}\n${block}\n` };
  }
  if (begin === -1 || end === -1 || end < begin) {
    return {
      action: "manual",
      reason: "profile 里 pep-cli 的围栏只剩半条（被手改过，或上次写了一半），不猜边界",
    };
  }
  if (existing.indexOf(BEGIN, begin + 1) !== -1) {
    return { action: "manual", reason: "profile 里有不止一段 pep-cli 围栏，不猜该换哪一段" };
  }
  return {
    action: "replace",
    content: existing.slice(0, begin) + block + existing.slice(end + END.length),
  };
}

export type MavenEnvResult =
  | { status: "windows"; }
  | { status: "profile-appended"; path: string; backupPath?: string }
  | { status: "profile-replaced"; path: string; backupPath: string }
  | { status: "manual"; reason: string; path?: string };

/** 备份文件名里的时间戳：`2026-09-13T091530`，冒号在 Windows 上不能做文件名。 */
function stamp(at: Date): string {
  return at.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "");
}

/**
 * 把凭据持久化到这台机器。
 *
 * ⚠ Windows 那一档用 `execFile` 而不是 `exec`：参数不经 shell，密码里就算有 `&` `^` `|`
 * 这类 cmd 元字符也不会被解释。走 `exec` 的话一个特殊字符就能把命令截断成两条。
 */
export async function persistMavenEnv(
  credential: MavenCredential,
  target: MavenEnvTarget = resolveTarget(),
  now: () => Date = () => new Date(),
): Promise<MavenEnvResult> {
  if (target.kind === "windows") {
    await run("setx", [USERNAME_VAR, credential.username]);
    await run("setx", [PASSWORD_VAR, credential.password]);
    return { status: "windows" };
  }

  const existing = await readFile(target.path, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });

  const plan = planProfile(existing, credential);
  if (plan.action === "manual") {
    return { status: "manual", reason: plan.reason, path: target.path };
  }

  // 文件本来就不存在时没有什么可备份的；存在就必须先备份成功再改。
  let backupPath: string | undefined;
  if (existing !== null) {
    backupPath = `${target.path}.bak-${stamp(now())}`;
    try {
      // `wx` = 存在就失败。同一秒跑两次不会把上一次的备份盖掉 —— 备份被覆盖等于没有备份。
      await writeFile(backupPath, existing, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      return {
        status: "manual",
        reason: `备份写不成（${backupPath}：${(error as Error).message}），因此没有改动 profile`,
        path: target.path,
      };
    }
  }

  await writeFile(target.path, plan.content, "utf8");
  return plan.action === "replace"
    ? { status: "profile-replaced", path: target.path, backupPath: backupPath as string }
    : { status: "profile-appended", path: target.path, ...(backupPath ? { backupPath } : {}) };
}

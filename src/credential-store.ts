import { spawn } from "node:child_process";
import type { CredentialStore, StoredAuthorization } from "./types.js";

const CREDENTIAL_TARGET = "PEP CLI OAuth Tokens";

const WINDOWS_CREDENTIAL_NATIVE = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class PepCredential {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public Int64 LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("Advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
  [DllImport("Advapi32.dll", SetLastError = false)]
  private static extern void CredFree(IntPtr credential);

  public static void Write(string target, string userName, byte[] secret) {
    IntPtr blob = Marshal.AllocCoTaskMem(secret.Length);
    try {
      Marshal.Copy(secret, 0, blob, secret.Length);
      var credential = new CREDENTIAL {
        Type = 1, TargetName = target, UserName = userName, CredentialBlob = blob,
        CredentialBlobSize = (UInt32)secret.Length, Persist = 2
      };
      if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < secret.Length; i++) Marshal.WriteByte(blob, i, 0);
      Marshal.FreeCoTaskMem(blob);
    }
  }

  public static byte[] Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, 1, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      if (error == 1168) return null;
      throw new Win32Exception(error);
    }
    try {
      var credential = Marshal.PtrToStructure<CREDENTIAL>(pointer);
      var secret = new byte[credential.CredentialBlobSize];
      Marshal.Copy(credential.CredentialBlob, secret, 0, secret.Length);
      return secret;
    } finally { CredFree(pointer); }
  }

  public static void Delete(string target) {
    if (!CredDelete(target, 1, 0)) {
      int error = Marshal.GetLastWin32Error();
      if (error != 1168) throw new Win32Exception(error);
    }
  }
}`;

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

async function runPowerShell(script: string, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(script),
      ],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) =>
      reject(new Error(`Windows Credential Manager failed: ${error.message}`)),
    );
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `Windows Credential Manager failed: ${stderr.trim() || `exit ${code}`}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

function parseStoredAuthorization(raw: string): StoredAuthorization {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null)
    throw new Error("Stored PEP authorization is malformed.");
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.issuer !== "string" ||
    typeof candidate.clientId !== "string" ||
    typeof candidate.accessToken !== "string" ||
    typeof candidate.refreshToken !== "string" ||
    candidate.tokenType !== "Bearer" ||
    typeof candidate.expiresAt !== "number" ||
    !Array.isArray(candidate.scopes) ||
    !candidate.scopes.every((scope) => typeof scope === "string")
  ) {
    throw new Error("Stored PEP authorization is malformed.");
  }
  return candidate as StoredAuthorization;
}

export function windowsCredentialStore(
  target = CREDENTIAL_TARGET,
): CredentialStore {
  const preamble = `Add-Type -TypeDefinition @'\n${WINDOWS_CREDENTIAL_NATIVE}\n'@`;
  return {
    async read() {
      const script = `${preamble}\n$bytes = [PepCredential]::Read('${target}')\nif ($null -ne $bytes) { [Convert]::ToBase64String($bytes) }`;
      const encoded = await runPowerShell(script);
      if (!encoded) return null;
      return parseStoredAuthorization(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
    },
    async write(authorization) {
      const script = `${preamble}\n$raw = [Console]::In.ReadToEnd()\n[PepCredential]::Write('${target}', 'oauth', [Text.Encoding]::UTF8.GetBytes($raw))`;
      await runPowerShell(script, JSON.stringify(authorization));
    },
    async delete() {
      await runPowerShell(`${preamble}\n[PepCredential]::Delete('${target}')`);
    },
  };
}

/** macOS Keychain 的「条目不存在」退出码（`errSecItemNotFound`）。 */
const SECURITY_NOT_FOUND = 44;

type SecurityResult = { code: number; stdout: string; stderr: string };

/**
 * 调 macOS 内置的 `security`。
 *
 * **不因非零退出码 reject** —— 44（条目不存在）是预期结局而不是故障，由调用方分流。
 * 参数走数组、不经 shell，所以密钥里的引号、`$`、空格都不需要转义。
 */
async function runSecurity(args: readonly string[]): Promise<SecurityResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/security", [...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) =>
      reject(new Error(`macOS Keychain failed: ${error.message}`)),
    );
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * macOS Keychain（login keychain）里的一条 generic password。
 *
 * 与 Windows 那侧同一个路子：不引任何原生依赖，shell 出去调系统自带的工具。`security` 是
 * macOS 的一部分，不需要安装。
 *
 * ⚠ **一处与 Windows 不对等，如实记下**：密钥经 `-w <值>` 走**命令行参数**，因此在写入的那
 * 一瞬间同用户的其他进程用 `ps` 看得见。Windows 那侧走的是 stdin，没有这个窗口。`security`
 * 没有从 stdin 读密钥的选项（不带 `-w` 会去 tty 交互提示，管道喂不进去），所以这是这条路
 * 的固有限制，不是疏漏。同用户进程本来就能解锁同一个 keychain，所以这个暴露没有扩大信任
 * 边界 —— 但它确实缩短了时间窗口以外的防线，值得在换实现时优先解决。
 *
 * 不加 `-A`（允许任何程序免提示读取）：那会把条目对本机所有程序敞开。由 `security` 建、
 * 也由 `security` 读，ACL 本来就对得上，正常不会弹窗。
 */
export function macosCredentialStore(
  target = CREDENTIAL_TARGET,
): CredentialStore {
  const selector = ["-s", target, "-a", "oauth"];
  return {
    async read() {
      const { code, stdout, stderr } = await runSecurity([
        "find-generic-password",
        ...selector,
        "-w",
      ]);
      if (code === SECURITY_NOT_FOUND) return null;
      if (code !== 0)
        throw new Error(
          `macOS Keychain failed: ${stderr.trim() || `exit ${code}`}`,
        );
      const raw = stdout.trim();
      if (!raw) return null;
      return parseStoredAuthorization(raw);
    },
    async write(authorization) {
      // `-U` = 已存在就更新。缺了它，第二次登录会因为条目重复而失败。
      const { code, stderr } = await runSecurity([
        "add-generic-password",
        ...selector,
        "-U",
        "-w",
        JSON.stringify(authorization),
      ]);
      if (code !== 0)
        throw new Error(
          `macOS Keychain failed: ${stderr.trim() || `exit ${code}`}`,
        );
    },
    async delete() {
      const { code, stderr } = await runSecurity([
        "delete-generic-password",
        ...selector,
      ]);
      // 本来就没有 = 已经是想要的状态，不是错误（同 fileConfigStore.delete 的口径）。
      if (code !== 0 && code !== SECURITY_NOT_FOUND) {
        throw new Error(
          `macOS Keychain failed: ${stderr.trim() || `exit ${code}`}`,
        );
      }
    },
  };
}

export function systemCredentialStore(): CredentialStore {
  if (process.platform === "win32") return windowsCredentialStore();
  if (process.platform === "darwin") return macosCredentialStore();
  // Linux 还没有实现。措辞点名**已支持的是哪些**，而不是只说「不支持你这个」——
  // 后者会让人怀疑是不是装错了版本。
  throw new Error(
    `PEP CLI stores credentials in the OS keychain and currently supports Windows and macOS only (this is ${process.platform}).`,
  );
}

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
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedPowerShell(script)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 10_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) =>
      reject(new Error(`Windows Credential Manager failed: ${error.message}`)),
    );
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else
        reject(new Error(`Windows Credential Manager failed: ${stderr.trim() || `exit ${code}`}`));
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

export function windowsCredentialStore(target = CREDENTIAL_TARGET): CredentialStore {
  const preamble = `Add-Type -TypeDefinition @'\n${WINDOWS_CREDENTIAL_NATIVE}\n'@`;
  return {
    async read() {
      const script = `${preamble}\n$bytes = [PepCredential]::Read('${target}')\nif ($null -ne $bytes) { [Convert]::ToBase64String($bytes) }`;
      const encoded = await runPowerShell(script);
      if (!encoded) return null;
      return parseStoredAuthorization(Buffer.from(encoded, "base64").toString("utf8"));
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

export function systemCredentialStore(): CredentialStore {
  if (process.platform !== "win32") {
    throw new Error("This PEP CLI build currently supports Windows Credential Manager only.");
  }
  return windowsCredentialStore();
}

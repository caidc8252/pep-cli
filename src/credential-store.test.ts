import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  macosCredentialStore,
  windowsCredentialStore,
} from "./credential-store.js";
import type { StoredAuthorization } from "./types.js";

describe("Windows Credential Manager", () => {
  it.runIf(process.platform === "win32")(
    "round-trips OAuth tokens in an isolated generic credential",
    async () => {
      const store = windowsCredentialStore(`PEP CLI Test ${randomUUID()}`);
      const authorization: StoredAuthorization = {
        version: 1,
        issuer: "https://pep.example.com",
        clientId: "pep-cli",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        expiresAt: 1_800_000_000_000,
        scopes: ["openid", "profile"],
      };
      try {
        await store.write(authorization);
        await expect(store.read()).resolves.toEqual(authorization);
      } finally {
        await store.delete();
      }
      await expect(store.read()).resolves.toBeNull();
    },
  );
});

// 与上面那条同一个形状、同一个理由：真凭据库不可打桩，所以按平台守卫，只在 macOS 上跑。
// 在别的平台它是 skipped —— 那不是「过了」，是「没跑」。
describe("macOS Keychain", () => {
  it.runIf(process.platform === "darwin")(
    "round-trips OAuth tokens in an isolated generic password",
    async () => {
      const store = macosCredentialStore(`PEP CLI Test ${randomUUID()}`);
      const authorization: StoredAuthorization = {
        version: 1,
        issuer: "https://pep.example.com",
        clientId: "pep-cli",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        tokenType: "Bearer",
        expiresAt: 1_800_000_000_000,
        scopes: ["openid", "profile"],
      };
      try {
        await store.write(authorization);
        await expect(store.read()).resolves.toEqual(authorization);
        // 第二次写必须成功（`-U`）——缺了它第二次 `auth login` 会因条目重复而失败。
        await store.write({ ...authorization, accessToken: "rotated" });
        await expect(store.read()).resolves.toMatchObject({
          accessToken: "rotated",
        });
      } finally {
        await store.delete();
      }
      await expect(store.read()).resolves.toBeNull();
      // 删一个本来就没有的，不该抛。
      await expect(store.delete()).resolves.toBeUndefined();
    },
  );
});

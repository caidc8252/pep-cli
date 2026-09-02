import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { windowsCredentialStore } from "./credential-store.js";
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
        scopes: ["openid", "docs:read"],
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

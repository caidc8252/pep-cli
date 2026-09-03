import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CliConfig, ConfigStore } from "./types.js";

export const DEFAULT_CLIENT_ID = "pep-cli";
export const DEFAULT_REDIRECT_URI = "http://localhost:53682/callback";
export const DEFAULT_SCOPES = ["openid", "profile", "email", "docs:read"] as const;

export type BuildEnvironment = "development" | "production";

declare const __PEP_BUILD_ENVIRONMENT__: BuildEnvironment | undefined;

export function issuerForEnvironment(environment: BuildEnvironment): string {
  return environment === "production"
    ? "https://pep.newlandnpt.us"
    : "https://pep-webapp-dev.onrender.com";
}

const BUILD_ENVIRONMENT: BuildEnvironment =
  typeof __PEP_BUILD_ENVIRONMENT__ === "undefined"
    ? "development"
    : __PEP_BUILD_ENVIRONMENT__;

export const DEFAULT_ISSUER = issuerForEnvironment(BUILD_ENVIRONMENT);

export function configuredIssuer(explicitIssuer: string | undefined): string {
  return explicitIssuer ?? DEFAULT_ISSUER;
}

function configDirectory(): string {
  if (process.platform === "win32") return join(homedir(), "AppData", "Roaming", "PEP");
  return join(homedir(), ".config", "pep");
}

export function configPath(): string {
  return join(configDirectory(), "config.json");
}

export function lockPath(): string {
  return join(configDirectory(), "credentials.lock");
}

function isCliConfig(value: unknown): value is CliConfig {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.version === 1 &&
    typeof candidate.issuer === "string" &&
    typeof candidate.clientId === "string" &&
    typeof candidate.redirectUri === "string"
  );
}

export function fileConfigStore(path = configPath()): ConfigStore {
  return {
    async read() {
      try {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!isCliConfig(parsed)) throw new Error(`PEP CLI config is malformed: ${path}`);
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(config) {
      await mkdir(dirname(path), { recursive: true });
      const temporary = `${path}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    },
  };
}

export function normalizeIssuer(raw: string): string {
  const url = new URL(raw);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("Issuer must use HTTPS (HTTP is allowed only for a local PEP server).");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

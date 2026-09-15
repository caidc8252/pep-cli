import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { main } from "./cli.js";
import { createAuthService } from "./auth-service.js";
import { systemCredentialStore } from "./credential-store.js";
import { DEFAULT_CLIENT_ID, DEFAULT_DOCS_URL, DEFAULT_ISSUER, DEFAULT_RESOURCES, fileConfigStore } from "./config.js";

vi.mock("./auth-service.js", () => ({ createAuthService: vi.fn(() => { throw new Error("Unexpected auth initialization"); }) }));
vi.mock("./credential-store.js", () => ({ systemCredentialStore: vi.fn(() => { throw new Error("Unexpected keychain access"); }) }));
vi.mock("./config.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("./config.js")>(),
  fileConfigStore: vi.fn(() => { throw new Error("Unexpected config access"); }),
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
});

afterEach(() => {
  expect(createAuthService).not.toHaveBeenCalled();
  expect(systemCredentialStore).not.toHaveBeenCalled();
  expect(fileConfigStore).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function help(args: string[]): Promise<string> {
  vi.spyOn(process, "argv", "get").mockReturnValue(["node", "pep", ...args]);
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  await main();
  expect(err).not.toHaveBeenCalled();
  expect(out).toHaveBeenCalledTimes(1);
  return out.mock.calls[0][0] as string;
}

describe("command help", () => {
  it.each([[], ["--help"], ["-h"], ["help"]])("root help: %j", async (...args) => {
    const text = await help(args);
    expect(text).toContain("pep <command> <subcommand> [flags]");
    for (const name of ["auth", "docs", "skills", "nexus"]) expect(text).toContain(name);
    expect(text).toContain("--version");
  });

  describe.each(["--help", "-h"])("%s", (flag) => {
    it.each(["auth", "docs", "skills", "nexus"])("group %s lists its commands", async (group) => {
      const text = await help([group, flag]);
      expect(text).toContain(`pep ${group} <command> [flags]`);
      expect(text).toContain("COMMANDS\n");
      expect(text).not.toContain("pep <command>");
    });

    it.each([
      ["auth", "login", "--issuer"],
      ["auth", "status", "account"],
      ["auth", "token", "stdout"],
      ["auth", "logout", "revoke"],
      ["docs", "list", "--docs-url"],
      ["docs", "get", "<path>"],
      ["skills", "list", "repositories"],
      ["skills", "add", "<repo>"],
      ["skills", "update", "--dir"],
      ["nexus", "setup", "never prints the username or password"],
    ])("%s %s gets its own description", async (group, command, detail) => {
      const text = await help([group, command, flag]);
      expect(text).toContain(`USAGE\n  pep ${group} ${command}`);
      expect(text).toContain(detail);
      expect(text).toContain("EXAMPLES\n");
      expect(text).not.toContain("COMMANDS\n");
    });
  });

  it.each(["auth", "docs", "skills", "nexus"])("bare %s displays group help", async (group) => {
    expect(await help([group])).toContain(`pep ${group} <command>`);
  });

  it("supports the help command with a subcommand path", async () => {
    expect(await help(["help", "auth", "login"])).toContain("USAGE\n  pep auth login");
  });

  it("help takes precedence over missing option values", async () => {
    const text = await help(["auth", "login", "--issuer", "--help"]);
    for (const value of [DEFAULT_ISSUER, DEFAULT_CLIENT_ID, ...DEFAULT_RESOURCES]) {
      expect(text).toContain(value);
    }
  });

  it("resolves docs help with document paths and options present", async () => {
    const text = await help(["docs", "get", "guide.md", "--docs-url", "https://docs.example", "--help"]);
    expect(text).toContain("USAGE\n  pep docs get <path>");
    expect(text).toContain(DEFAULT_DOCS_URL);
    expect(text).toContain("saved for later use");
  });

  it.each([
    ["unknown", "--help"],
    ["auth", "unknown", "--help"],
    ["help", "docs", "unknown"],
    ["help", "docs", "get", "extra"],
  ])("unknown help target fails: %j", async (...args) => {
    await expect(help(args)).rejects.toThrow(/Unknown .*command/);
  });

  it("preserves version output", async () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(await help(["--version"])).toBe(pkg.version);
  });
});

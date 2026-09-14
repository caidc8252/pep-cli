import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";
import { setupNexusCredential } from "./nexus-service.js";

vi.mock("./auth-service.js", () => ({
  createAuthService: () => ({
    currentAuthorization: async () => ({ issuer: "https://pep.example", accessToken: "test-token" }),
  }),
}));
vi.mock("./credential-store.js", () => ({ systemCredentialStore: () => ({}) }));
vi.mock("./nexus-service.js", () => ({ setupNexusCredential: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pep nexus setup terminal output", () => {
  function terminal() {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "pep", "nexus", "setup"]);
    return {
      stdout: vi.spyOn(console, "log").mockImplementation(() => {}),
      stderr: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
  }

  it.each(["windows", "profile-appended", "profile-replaced"] as const)(
    "%s prints only a success message, with no credential values",
    async (status) => {
      const { stdout, stderr } = terminal();
      vi.mocked(setupNexusCredential).mockResolvedValue({
        persisted: status === "windows"
          ? { status }
          : { status, path: "/test/.zshrc", backupPath: "/test/.zshrc.bak" },
      });

      await main();

      expect(stdout.mock.calls).toEqual([
        ["Maven credentials saved successfully. Open a new terminal to use them."],
      ]);
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it("does not print a password-bearing persistence error or report success", async () => {
    const { stdout, stderr } = terminal();
    vi.mocked(setupNexusCredential).mockResolvedValue({
      persisted: { status: "manual", reason: "Command failed: setx NEWLAND_MAVEN_PASSWORD secret-value" },
    });

    const error = await main().catch((value: unknown) => value);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("could not be fully saved");
    expect((error as Error).message).not.toContain("secret-value");
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();
  });
});

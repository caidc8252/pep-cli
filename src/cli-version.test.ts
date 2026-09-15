import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

vi.mock("../package.json", () => ({ default: { version: "9.8.7-test" } }));

afterEach(() => vi.restoreAllMocks());

describe("CLI package version", () => {
  it.each(["-v", "--version"])("%s follows the package version", async (flag) => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "pep", flag]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    expect(output).toHaveBeenCalledExactlyOnceWith("9.8.7-test");
  });

  it("shows the package version in root help", async () => {
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "pep", "--help"]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    await main();
    expect(output).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("PEP CLI 9.8.7-test\n"));
  });
});

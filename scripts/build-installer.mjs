import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("build:installer must run on Windows.");

const environment = process.argv[2] ?? "production";
if (environment !== "development" && environment !== "production") {
  throw new Error(`Unknown build environment: ${environment}`);
}

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
const versionQuad = `${packageJson.version.split("-")[0]}.0`;
const sourceExe = environment === "development" ? "pep-dev.exe" : "pep.exe";
const installerOutput = environment === "development" ? "pep-dev-setup.exe" : "pep-setup.exe";

execFileSync(process.execPath, [join(packageRoot, "scripts", "build-exe.mjs"), environment], {
  stdio: "inherit",
});

const candidates = [
  process.env.MAKENSIS_PATH,
  join(packageRoot, ".tools", "nsis", "makensis.exe"),
  join(process.env.ProgramFiles ?? "", "NSIS", "makensis.exe"),
  join(process.env["ProgramFiles(x86)"] ?? "", "NSIS", "makensis.exe"),
].filter(Boolean);
const compiler = candidates.find((candidate) => existsSync(candidate));

if (!compiler) {
  throw new Error(
    "NSIS was not found. Install NSIS 3 or set MAKENSIS_PATH to the full path of makensis.exe.",
  );
}

execFileSync(
  compiler,
  [
    "/WX",
    `/DAPP_VERSION=${packageJson.version}`,
    `/DAPP_VERSION_QUAD=${versionQuad}`,
    `/DBUILD_ENVIRONMENT=${environment}`,
    `/DSOURCE_EXE=${sourceExe}`,
    `/DINSTALLER_OUTPUT=${installerOutput}`,
    join(packageRoot, "installer", "pep.nsi"),
  ],
  { stdio: "inherit" },
);

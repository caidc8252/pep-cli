import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("build:exe must run on Windows.");
const environment = process.argv[2] ?? "production";
if (environment !== "development" && environment !== "production") {
  throw new Error(`Unknown build environment: ${environment}`);
}
const require = createRequire(import.meta.url);
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(packageRoot, "dist");
mkdirSync(dist, { recursive: true });

execFileSync(process.execPath, [join(packageRoot, "scripts", "build-js.mjs"), environment], {
  stdio: "inherit",
});
const seaConfig = join(dist, "sea-config.json");
const blob = join(dist, "pep.blob");
const executable = join(dist, environment === "development" ? "pep-dev.exe" : "pep.exe");
writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: join(dist, "pep.cjs"),
      output: blob,
      disableExperimentalSEAWarning: true,
      useCodeCache: true,
    },
    null,
    2,
  ),
);
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });
copyFileSync(process.execPath, executable);

const postjectPackage = require.resolve("postject/package.json");
const postjectCli = join(dirname(postjectPackage), "dist", "cli.js");
execFileSync(
  process.execPath,
  [
    postjectCli,
    executable,
    "NODE_SEA_BLOB",
    blob,
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);
console.log(`Built ${executable}`);

import { mkdir, readFile } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const environment = process.argv[2] ?? "development";
if (environment !== "development" && environment !== "view" && environment !== "production") {
  throw new Error(`Unknown build environment: ${environment}`);
}

// ⚠ 版本号从 package.json 注入，**不在源码里再写一遍**。手抄那份漂过一次：package.json
// 是 0.3.1 而 cli.ts 里钉着 0.3.0，于是 `pep --version` 与 `--help` 报的都是上一版 ——
// 排查线上问题时第一步就问「你装的是哪版」，而那一步给的是假话。
const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/pep.cjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  minify: false,
  define: {
    __PEP_BUILD_ENVIRONMENT__: JSON.stringify(environment),
    __PEP_VERSION__: JSON.stringify(version),
  },
});
console.log(`Built JavaScript ${version} for ${environment}.`);

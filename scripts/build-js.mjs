import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const environment = process.argv[2] ?? "development";
if (environment !== "development" && environment !== "view" && environment !== "production") {
  throw new Error(`Unknown build environment: ${environment}`);
}

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
  outfile: fileURLToPath(new URL("../dist/pep.cjs", import.meta.url)),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: false,
  minify: false,
  define: {
    __PEP_BUILD_ENVIRONMENT__: JSON.stringify(environment),
  },
});
console.log(`Built JavaScript for ${environment}.`);

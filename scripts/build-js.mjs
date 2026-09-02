import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

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
});

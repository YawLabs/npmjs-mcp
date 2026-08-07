/**
 * Bundles the MCP server into a single self-contained file.
 *
 * Why: `npx` has to install all runtime dependencies on every cold start.
 * By bundling everything into one file and declaring zero runtime
 * dependencies, npx downloads only the tarball and runs immediately.
 */

import { build } from "esbuild";
import { readFileSync } from "node:fs";

let pkg;
try {
  pkg = JSON.parse(readFileSync("package.json", "utf-8"));
} catch {
  console.error("Could not read package.json -- run build.mjs from the repo root");
  process.exit(1);
}

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  // Match package.json `engines: ">=20"`. Lower targets force esbuild to
  // down-level syntax we don't ship to.
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  define: {
    __VERSION__: JSON.stringify(pkg.version),
  },
  // Node built-ins are provided by the runtime, not bundled
  external: ["node:*"],
  // "external" writes dist/index.js.map but does NOT append a
  // //# sourceMappingURL comment to the bundle. With plain `true` the published
  // file referenced a map that package.json `files` did not ship; adding the map
  // to `files` fixes the dangling reference but takes the packed tarball from
  // 225 kB to 583 kB, which fights the whole reason this is bundled (npx cold
  // start downloads the tarball on every run). External keeps the map on disk
  // for local debugging and out of the published artifact.
  sourcemap: "external",
  // Keep readable for debugging MCP issues
  minify: false,
});

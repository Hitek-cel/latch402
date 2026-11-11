// Compile src/ to dist/ as plain ESM plus type declarations.
//
// The source imports its siblings as "./x.ts" so Node can run it directly.
// tsc rewrites those to "./x.js" in the emitted JavaScript but leaves
// declaration files alone, so the same rewrite is applied to them here.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], {
  stdio: "inherit",
});

let rewritten = 0;
for (const entry of readdirSync(dist, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
  const file = join(entry.parentPath, entry.name);
  const before = readFileSync(file, "utf8");
  const after = before.replace(/(from\s+|import\(\s*)(["'])(\.{1,2}\/[^"']+)\.ts\2/g, "$1$2$3.js$2");
  if (after !== before) {
    writeFileSync(file, after);
    rewritten++;
  }
}
console.log(`built dist/ (${rewritten} declaration files rewritten)`);

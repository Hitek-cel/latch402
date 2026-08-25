/**
 * Bundles the real library plus the console driver into one self-contained
 * HTML file. No CDN, no external scripts — what ships is what the tests run.
 */
import { build } from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  entryPoints: [join(root, "web/app.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  write: false,
  legalComments: "none",
});

const js = result.outputFiles[0].text;
const template = await readFile(join(root, "web/template.html"), "utf8");

if (!template.includes("/*BUNDLE*/")) throw new Error("template lost its bundle marker");
const html = template.replace("/*BUNDLE*/", () => js);

const out = join(root, "web/latch-console.html");
await writeFile(out, html, "utf8");

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`built web/latch-console.html  (${kb} KB, self-contained)`);

// Build: the reader page (one HTML file, JS and CSS inline) and the server (one ESM file with the page and icon inside).
import { build } from "esbuild";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
const root = new URL("..", import.meta.url).pathname;
fs.mkdirSync(root + "dist", { recursive: true });

// One version number: package.json's. The plugin manifest must say the same, and the server gets it at build time.
const version = JSON.parse(fs.readFileSync(root + "package.json", "utf8")).version;
const manifest = JSON.parse(fs.readFileSync(root + ".codex-plugin/plugin.json", "utf8")).version;
if (manifest !== version) {
  console.error(`Version mismatch: package.json says ${version}, .codex-plugin/plugin.json says ${manifest}. Make them the same.`);
  process.exit(1);
}

const ui = await build({ entryPoints: [root + "src/ui/app.ts"], bundle: true, minify: true, format: "iife", target: "es2022", write: false,
  alias: { BRIDGE: root + "src/ui/bridge.ts" } });
const js = ui.outputFiles[0].text.replace(/<\/script/g, "<\\/script");
const html = fs.readFileSync(root + "src/ui/index.html", "utf8").replace("/*APP*/", () => js);
fs.writeFileSync(root + "dist/ui.html", html);

await build({ entryPoints: [root + "src/server/index.ts"], bundle: true, platform: "node", format: "esm", target: "node22",
  outfile: root + "dist/server.mjs", loader: { ".html": "text", ".png": "dataurl" }, legalComments: "none", minify: true,
  define: { READBACK_VERSION: JSON.stringify(version) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });

const kb = n => (n / 1024).toFixed(1) + " KB";
console.log(`Readback ${version}: reader page ${kb(html.length)} (${kb(gzipSync(html).length)} gzipped), server ${kb(fs.statSync(root + "dist/server.mjs").size)}`);

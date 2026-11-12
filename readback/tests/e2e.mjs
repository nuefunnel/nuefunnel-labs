// End-to-end check of the built server over stdio, like the ChatGPT app runs it.
// Usage: node tests/e2e.mjs <opml path>   (uses a fresh temporary data folder; fetches real feeds)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs"; import os from "node:os";
const data = fs.mkdtempSync(os.tmpdir() + "/readback-e2e-");
const c = new Client({ name: "e2e", version: "0" });
let t = performance.now();
await c.connect(new StdioClientTransport({ command: "node", args: ["--no-warnings", "./launch.mjs"], cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, READBACK_DATA: data } }));
const ms = () => Math.round(performance.now() - t);
const v = c.getServerVersion(); console.log(`connected in ${ms()} ms: ${v.title} ${v.version}, icon ${v.icons?.length ? "yes" : "no"}`);
const { tools } = await c.listTools(); console.log("tools:", tools.map(x => x.name).join(", "));
const call = async (name, args = {}) => (await c.callTool({ name, arguments: args })).structuredContent;
let s = await call("open_reader"); console.log(`empty open: ${s.feeds.length} feeds, NetNewsWire lists found: ${s.sources.map(x => `${x.feeds} feeds`).join(", ") || "none"}`);
t = performance.now(); s = await call("reader_import", { path: process.argv[2] }); console.log(`import: ${s.added} feeds added, folders ${JSON.stringify(s.folders)} (${ms()} ms)`);
t = performance.now(); let st;
do { await new Promise(r => setTimeout(r, 3000)); st = await call("reader_status"); } while (st.refreshing && ms() < 240000);
const withIcon = st.feeds.filter(f => f.icon).length, errs = st.feeds.filter(f => f.last_error);
console.log(`refresh done in ${(ms() / 1000).toFixed(0)} s: ${st.smart.unread} unread, ${withIcon}/${st.feeds.length} icons, ${errs.length} feeds with errors`);
errs.slice(0, 6).forEach(f => console.log(`   ${f.title}: ${f.last_error}`));
t = performance.now(); s = await call("open_reader"); console.log(`open_reader: ${ms()} ms, list ${s.list.length}, first "${s.list[0]?.title}" (${s.list[0]?.feed})`);
const db = (await import("node:sqlite")).DatabaseSync; const d = new db(data + "/readback.sqlite");
console.log("articles:", JSON.stringify(d.prepare("select count(*) total, sum(read=0) unread, sum(read=1) startedRead, sum(content_html like '%data-img=%') withImages, sum(content_html like '%<script%' or content_html like '% onerror=%') unsafe from articles").get()));
const a = d.prepare("select id, title, content_html from articles where content_html like '%data-img=%' and read=0 limit 1").get();
if (a) { const urls = [...a.content_html.matchAll(/data-img="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, "&")).slice(0, 6);
  t = performance.now(); const im = await call("reader_images", { urls }); console.log(`images for "${a.title.slice(0, 40)}": ${Object.values(im.images).filter(Boolean).length}/${urls.length} in ${ms()} ms`); }
await c.close();
console.log("data folder:", data, "| events.log lines:", fs.readFileSync(data + "/events.log", "utf8").trim().split("\n").length);

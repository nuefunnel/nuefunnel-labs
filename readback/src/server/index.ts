// Readback: an MCP server the ChatGPT desktop app starts on this Mac (stdio). It serves the reader view,
// answers the reader's calls, and keeps feeds fresh while the app is open.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
// Bundled in by esbuild (scripts/build.mjs): the reader page as text, the icon as a data: URI.
// @ts-ignore
import UI_HTML from "../../dist/ui.html";
// @ts-ignore
import ICON_PNG from "../../assets/icon.png";
import { openDb, sidebar, listArticles, getArticles, mark, holdLease, markScopeRead, feedHealth, unsubscribe, getPrefs, setPrefs } from "./db.ts";
import { refreshDue, refreshFeed, discoverFeed } from "./feeds.ts";
import { imageCache, refreshIcons } from "./images.ts";
import { parseSubscriptions, importFeeds, findNetNewsWire, exportOpml } from "./opml.ts";
import { strip } from "./sanitize.ts";
import { maintain, maintenanceDue } from "./maintenance.ts";
import { VERSION } from "./version.ts";

const DATA = process.env.READBACK_DATA || `${os.homedir()}/Library/Application Support/Readback`;
const db = openDb(DATA);
const imageData = imageCache(DATA);

const LOG = `${DATA}/events.log`;
try { if (fs.statSync(LOG).size > 1_000_000) fs.renameSync(LOG, LOG + ".1"); } catch {}
const log = (msg: string, extra?: unknown) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} [${process.pid}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}\n`); } catch {} };

// The app caches the reader page by URI, so the URI carries a hash of the page.
const UI_URI = `ui://readback/reader-${crypto.createHash("sha1").update(UI_HTML).digest("hex").slice(0, 8)}.html`;
log("started", { version: VERSION, ui: UI_URI, ppid: process.ppid });

const json = (o: any) => ({ content: [{ type: "text" as const, text: JSON.stringify(o) }], structuredContent: o });
const brief = (text: string, o: any) => ({ content: [{ type: "text" as const, text }], structuredContent: o });
const timed = <A,>(name: string, fn: (a: A) => any) => async (a: A) => {
  const t = performance.now(); try { return await fn(a); }
  finally { log(`tool ${name}`, { ms: +(performance.now() - t).toFixed(1) }); }
};

const server = new McpServer({ name: "readback", title: "Readback", version: VERSION, icons: [{ src: ICON_PNG, mimeType: "image/png", sizes: ["256x256"] }] } as any);
server.server.oninitialized = () => log("host connected", { client: server.server.getClientVersion()?.name, ui: !!(server.server.getClientCapabilities() as any)?.extensions?.["io.modelcontextprotocol/ui"] });

registerAppResource(server, "Readback", UI_URI, {}, async () => ({
  contents: [{ uri: UI_URI, mimeType: RESOURCE_MIME_TYPE, text: UI_HTML,
    _meta: { ui: { csp: { resourceDomains: [], connectDomains: [] }, prefersBorder: false },
             "openai/ui": { preferredDisplayMode: "fullscreen", availableDisplayModes: ["fullscreen", "inline"] } } }],
}));

function firstScreen() {
  const sb = sidebar(db); const list = listArticles(db, "unread");
  return { ...sb, prefs: getPrefs(db), scope: "unread", list, articles: list[0] ? getArticles(db, [list[0].id]) : [], sources: sb.feeds.length ? [] : findNetNewsWire() };
}

registerAppTool(server, "open_reader", {
  title: "Readback", description: "Open Readback, the user's RSS reader, showing unread articles.",
  _meta: { ui: { resourceUri: UI_URI, visibility: ["model", "app"] }, "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } },
}, timed("open_reader", () => json(firstScreen())));

// ---- tools only the reader view can call ----
const app = { ui: { visibility: ["app"] } } as any;
server.registerTool("reader_list", { description: "List article headers for a scope", inputSchema: { scope: z.string(), before: z.number().optional() }, _meta: app },
  timed("reader_list", ({ scope, before }: any) => json({ scope, list: listArticles(db, scope, before) })));
server.registerTool("reader_articles", { description: "Article bodies", inputSchema: { ids: z.array(z.number()).max(20) }, _meta: app },
  timed("reader_articles", ({ ids }: any) => json({ articles: getArticles(db, ids) })));
server.registerTool("reader_mark", { description: "Mark read or starred", inputSchema: { ids: z.array(z.number()), read: z.boolean().optional(), starred: z.boolean().optional() }, _meta: app },
  timed("reader_mark", ({ ids, read, starred }: any) => { mark(db, ids, read, starred); return json({ ok: true }); }));
server.registerTool("reader_images", { description: "Article images as data URIs", inputSchema: { urls: z.array(z.string()).max(12) }, _meta: app },
  timed("reader_images", async ({ urls }: any) => { const images: Record<string, string | null> = {};
    await Promise.all(urls.map(async (u: string) => { images[u] = await imageData(u); }));
    return brief(`${urls.length} images`, { images }); }));
server.registerTool("reader_refresh", { description: "Refresh feeds now", _meta: app },
  timed("reader_refresh", async () => { await refreshAll(true); return json(firstScreen()); }));
server.registerTool("reader_import", { description: "Import subscriptions from OPML text or a file path", inputSchema: { opml: z.string().optional(), path: z.string().optional() }, _meta: app },
  timed("reader_import", async ({ opml, path }: any) => {
    const text = opml ?? fs.readFileSync(path.replace(/^~(?=\/)/, os.homedir()), "utf8");
    const result = importFeeds(db, parseSubscriptions(text)); log("imported", result);
    refreshAll(true); // fetch in the background; the reader polls with reader_status
    return json({ ...result, ...firstScreen() });
  }));
server.registerTool("reader_status", { description: "Sidebar counts and refresh progress", _meta: app },
  timed("reader_status", () => json({ ...sidebar(db), refreshing })));

server.registerTool("reader_mark_scope", { description: "Mark everything in a scope as read", inputSchema: { scope: z.string() }, _meta: app },
  timed("reader_mark_scope", ({ scope }: any) => json({ ids: markScopeRead(db, scope), ...sidebar(db) })));
server.registerTool("reader_prefs", { description: "Save reader preferences such as pane widths", inputSchema: { set: z.record(z.string(), z.any()) }, _meta: app },
  timed("reader_prefs", ({ set }: any) => { setPrefs(db, set); return json({ prefs: getPrefs(db) }); }));
server.registerTool("reader_feeds", { description: "All subscriptions with their health", _meta: app },
  timed("reader_feeds", () => json({ feeds: feedHealth(db), sources: findNetNewsWire() })));
server.registerTool("reader_unsubscribe", { description: "Remove feeds and their articles", inputSchema: { ids: z.array(z.number()) }, _meta: app },
  timed("reader_unsubscribe", ({ ids }: any) => json({ removed: unsubscribe(db, ids), ...sidebar(db), health: feedHealth(db) })));
server.registerTool("reader_add_feed", { description: "Subscribe to a feed by feed or site address", inputSchema: { url: z.string(), folder: z.string().optional() }, _meta: app },
  timed("reader_add_feed", async ({ url, folder }: any) => addFeed(url, folder)));
server.registerTool("reader_export", { description: "Write subscriptions as OPML to ~/Downloads", _meta: app },
  timed("reader_export", () => json({ path: writeExport() })));

async function addFeed(url: string, folder?: string) {
  try {
    const found = await discoverFeed(url);
    importFeeds(db, [{ ...found, folder: folder || null }]);
    const f = db.prepare("SELECT * FROM feeds WHERE url=?").get(found.url) as any;
    const r = await refreshFeed(db, f);
    return json({ ok: true, feed: { id: f.id, title: f.title || found.title, added: r.added }, ...sidebar(db) });
  } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }); }
}
function writeExport() {
  const p = `${os.homedir()}/Downloads/Readback subscriptions.opml`; fs.writeFileSync(p, exportOpml(db)); return p;
}

// ---- tools the model can use in chat ----
server.registerTool("get_article", { description: "Get the full text of a Readback article by id, to summarise it or answer questions about it.", inputSchema: { id: z.number() }, annotations: { readOnlyHint: true } },
  timed("get_article", ({ id }: any) => { const [a] = getArticles(db, [id]);
    return { content: [{ type: "text" as const, text: a ? `# ${a.title}\n${a.feed} · ${new Date(a.published_at).toDateString()}\n${a.url}\n\n${strip(a.content_html)}` : "No article with that id." }] }; }));
server.registerTool("list_unread", { description: "List unread Readback article titles, optionally for one feed (matched by name).", inputSchema: { feed: z.string().optional() }, annotations: { readOnlyHint: true } },
  timed("list_unread", ({ feed }: any) => json({ articles: db.prepare(`SELECT a.id, f.title feed, a.title, a.published_at FROM articles a JOIN feeds f ON f.id=a.feed_id
    WHERE a.read=0 ${feed ? "AND f.title LIKE ?" : ""} ORDER BY a.published_at DESC LIMIT 40`).all(...(feed ? [`%${feed}%`] : [])) })));
server.registerTool("import_opml", { description: "Import RSS subscriptions into Readback from an OPML file on this Mac (for example one exported from NetNewsWire). Folders are kept; feeds already present are skipped.", inputSchema: { path: z.string().describe("Absolute path or ~/ path to the .opml file") } },
  timed("import_opml", ({ path }: any) => { const result = importFeeds(db, parseSubscriptions(fs.readFileSync(path.replace(/^~(?=\/)/, os.homedir()), "utf8")));
    refreshAll(true); return json(result); }));
server.registerTool("export_opml", { description: "Export Readback's subscriptions as an OPML file in ~/Downloads and return its path.", annotations: { readOnlyHint: false } },
  timed("export_opml", () => ({ content: [{ type: "text" as const, text: writeExport() }] })));
server.registerTool("add_feed", { description: "Subscribe Readback to a feed, given the feed's address or the website's address.", inputSchema: { url: z.string(), folder: z.string().optional() } },
  timed("add_feed", async ({ url, folder }: any) => addFeed(url, folder)));

// ---- background refresh: one process at a time holds the lease ----
const ME = `${os.hostname()}:${process.pid}`;
let refreshing = false;
async function refreshAll(force = false) {
  if (refreshing || !(force || holdLease(db, "refresh", ME, 3 * 60e3))) return;
  refreshing = true; const t = Date.now();
  try {
    const r = await refreshDue(db);
    const icons = await refreshIcons(db, os.tmpdir());
    if (maintenanceDue(db)) log("cleaned up", maintain(db, DATA));
    if (r.length || icons.checked) log("refreshed", { feeds: r.length, added: r.reduce((a, x) => a + (x.added || 0), 0), errors: r.filter(x => x.status === "error").length, icons, ms: Date.now() - t });
  } catch (e: any) { log("refresh failed", { error: String(e?.message || e) }); }
  finally { refreshing = false; }
}
setTimeout(() => refreshAll(), 2000);
setInterval(() => refreshAll(), 60e3).unref();

await server.connect(new StdioServerTransport());
process.stdin.on("close", () => { log("host disconnected"); process.exit(0); });

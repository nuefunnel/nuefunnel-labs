// Readback reader view. Plain DOM, no framework. The first screen arrives with the open_reader tool result;
// after that the view talks to the local server through UI-only tools (reader_*) over the host bridge.
import { createBridge } from "BRIDGE";
const T0 = performance.now();
const B = createBridge();
const $ = (s: string) => document.querySelector(s) as HTMLElement;
const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
type Head = { id: number; feed_id: number; feed: string; title: string; summary: string; published_at: number; read: number; starred: number };
type Feed = { id: number; title: string; folder: string | null; site_url: string | null; icon: string | null; last_error: string | null; unread: number; error_count?: number };
const S = {
  feeds: [] as Feed[], smart: {} as any, scope: "unread", list: [] as Head[], sel: -1, end: false, loadingMore: false,
  bodies: new Map<number, any>(), open: new Set<string>(), lastRefresh: 0, refreshing: false, view: "read" as "read" | "subs",
  health: null as any[] | null, sources: [] as any[],
};
const metrics: Record<string, number> = {};
const report = () => window.parent.postMessage({ readbackMetrics: { ...metrics } }, "*");

// ---------- formatting ----------
const DAY = 86400e3;
const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
function dayGroup(t: number): string {
  if (!t) return "Undated";
  const today = startOfDay(Date.now()), d = startOfDay(t);
  if (d >= today) return "Today";
  if (d >= today - DAY) return "Yesterday";
  if (d > today - 6 * DAY) return new Date(t).toLocaleDateString(undefined, { weekday: "long" });
  return new Date(t).toLocaleDateString(undefined, new Date(t).getFullYear() === new Date().getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
}
function shortTime(t: number): string {
  if (!t) return "";
  const today = startOfDay(Date.now());
  if (t >= today) return new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  if (t > today - 6 * DAY) return new Date(t).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short", ...(new Date(t).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}
const longDate = (t: number) => !t ? "Undated" : new Date(t).toLocaleString(undefined, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
const plain = (h: string) => (h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const minutes = (h: string) => Math.max(1, Math.round(plain(h).split(" ").length / 230));
const host = (u?: string | null) => { try { return new URL(u || "").hostname.replace(/^www\./, ""); } catch { return ""; } };
const feedOf = (id: number) => S.feeds.find(f => f.id === id);
function icon(name: string, src?: string | null, cls = "") {
  if (src) return `<img class="ic ${cls}" src="${src}" alt="">`;
  let h = 0; for (const c of name || "?") h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="ic tile ${cls}" style="--h:${h}" aria-hidden="true">${esc((name || "?").trim()[0]?.toUpperCase())}</span>`;
}
const SVG: Record<string, string> = {
  today: `<svg class="i" viewBox="0 0 24 24" style="color:var(--amber)"><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/></svg>`,
  unread: `<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.6" fill="var(--amber)" stroke="none"/></svg>`,
  starred: `<svg class="i" viewBox="0 0 24 24"><path d="M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" fill="var(--amber)" stroke="var(--amber)"/></svg>`,
  folder: `<svg class="i" viewBox="0 0 24 24" style="color:var(--muted)"><path d="M3.5 7.2c0-.9.7-1.7 1.7-1.7h4.1l1.9 2h7.6c.9 0 1.7.8 1.7 1.7v7.9c0 .9-.8 1.7-1.7 1.7H5.2c-1 0-1.7-.8-1.7-1.7z"/></svg>`,
  attn: `<svg class="i" viewBox="0 0 24 24"><path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4M12 16.8v.2"/></svg>`,
  chev: `<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2l3 3-3 3"/></svg>`,
  logo: `<svg class="logo" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="#17304d"/><path d="M14 15h36a6 6 0 0 1 6 6v19a6 6 0 0 1-6 6H30l-10 8v-8h-6a6 6 0 0 1-6-6V21a6 6 0 0 1 6-6z" fill="#fff"/><circle cx="22" cy="37" r="3.4" fill="#f2a33a"/><path d="M22 28a9 9 0 0 1 9 9M22 21a16 16 0 0 1 16 16" fill="none" stroke="#f2a33a" stroke-width="4.4" stroke-linecap="round"/></svg>`,
};

// Plain-language reasons for feeds that stopped working.
function problem(f: any): { key: string; title: string; why: string } | null {
  const e = String(f.last_error || ""); if (!e) return null;
  const transient = (f.error_count ?? 3) < 3;
  if (/HTTP 404|HTTP 410/.test(e)) return { key: "gone", title: "The feed is gone", why: "The site says this feed no longer exists. It may have moved or closed." };
  if (/Unrecognized feed format/i.test(e)) return { key: "html", title: "The address shows a web page, not a feed", why: "Usually a closed blog, a parked domain or a private site." };
  if (/HTTP 40[123]/.test(e)) return { key: "denied", title: "The site refuses access", why: "It asks for a login or blocks feed readers." };
  if (transient) return null; // network hiccups and rate limits get a few tries before they count
  if (/fetch failed|ENOTFOUND|ECONN/i.test(e)) return { key: "unreach", title: "Can't reach the site", why: "The domain hasn't answered several times in a row." };
  return { key: "other", title: "Other problems", why: "Server errors or timeouts several times in a row." };
}
const attention = () => (S.health || S.feeds).filter(f => problem(f));

// ---------- render: sources ----------
function renderSide() {
  const sm = S.smart || {};
  const row = (scope: string, ic: string, name: string, n: number, cls = "") =>
    `<button class="src ${cls} ${S.scope === scope && S.view === "read" ? "on" : ""}" data-scope="${esc(scope)}">${ic}<span class="nm">${esc(name)}</span><span class="ct">${n ? n.toLocaleString() : ""}</span></button>`;
  const groups = new Map<string, Feed[]>();
  for (const f of S.feeds) { const k = f.folder || ""; (groups.get(k) ?? groups.set(k, []).get(k)!).push(f); }
  let h = `<div class="sec">Smart Feeds</div>` + row("today", SVG.today, "Today", sm.today) + row("unread", SVG.unread, "All Unread", sm.unread) + row("starred", SVG.starred, "Starred", sm.starred);
  if (S.feeds.length) h += `<div class="sec">On My Mac</div>`;
  const feedRow = (f: Feed, cls = "") => row(`feed:${f.id}`, icon(f.title, f.icon), f.title || host(f.site_url) || "Untitled", f.unread, `${cls}${f.unread ? "" : " dim"}${problem(f) ? " bad" : ""}`);
  for (const [name, fs] of groups) {
    if (!name) continue;
    const open = S.open.has(name), total = fs.reduce((a, f) => a + f.unread, 0);
    h += `<div class="fold"><button class="tw" data-fold="${esc(name)}" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${esc(name)}">${SVG.chev}</button>${row(`folder:${name}`, SVG.folder, name, total)}</div>`;
    if (open) for (const f of fs) h += feedRow(f, "child");
  }
  for (const f of groups.get("") || []) h += feedRow(f);
  const bad = attention().length;
  if (bad) h += `<div class="sec">Needs attention</div><button class="src attn ${S.view === "subs" ? "on" : ""}" data-subs="attn">${SVG.attn}<span class="nm">Feeds not updating</span><span class="ct">${bad}</span></button>`;
  $("#srcs").innerHTML = h;
  $("#status").textContent = S.refreshing ? "Checking feeds…" : S.lastRefresh ? `Updated ${new Date(S.lastRefresh).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "";
  $("#t-refresh").classList.toggle("spin", S.refreshing);
}

// ---------- render: timeline ----------
function scopeName() {
  if (S.scope === "today") return "Today"; if (S.scope === "unread") return "All Unread"; if (S.scope === "starred") return "Starred";
  if (S.scope.startsWith("folder:")) return S.scope.slice(7);
  return feedOf(+S.scope.slice(5))?.title || "";
}
function scopeUnread() {
  const sc = S.scope;
  if (sc === "unread") return S.smart.unread || 0;
  if (sc.startsWith("folder:")) return S.feeds.filter(f => f.folder === sc.slice(7)).reduce((a, f) => a + f.unread, 0);
  if (sc.startsWith("feed:")) return feedOf(+sc.slice(5))?.unread || 0;
  return S.list.filter(a => !a.read).length;
}
function renderList() {
  $("#lt").textContent = scopeName();
  const n = scopeUnread();
  $("#lc").textContent = S.list.length || n ? (n ? `${n.toLocaleString()} unread` : "All read") : "";
  const multi = !S.scope.startsWith("feed:");
  let h = "", last = "";
  S.list.forEach((a, i) => {
    const g = dayGroup(a.published_at); if (g !== last) { h += `<div class="day">${esc(g)}</div>`; last = g; }
    const f = feedOf(a.feed_id);
    h += `<button class="art ${a.read ? "read" : "unread"} ${a.starred ? "star" : ""} ${i === S.sel ? "on" : ""}" data-i="${i}" role="option" aria-selected="${i === S.sel}">
      <b>${esc(a.title)}</b>${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
      <div class="meta">${multi ? `${icon(a.feed, f?.icon)}<span>${esc(a.feed)}</span>` : "<span></span>"}<time>${shortTime(a.published_at)}</time></div></button>`;
  });
  if (!S.list.length) h = `<div class="empty">${!S.feeds.length ? "" : S.scope === "unread" ? "You're all caught up." : S.scope === "starred" ? "Press S on an article to star it. Starred articles stay here." : S.scope === "today" ? "Nothing new today yet." : "No articles yet."}</div>`;
  else if (!S.end) h += `<div class="more">Loading more…</div>`;
  $("#list").innerHTML = h;
}

// ---------- render: article ----------
function renderArticle() {
  $("#pop").hidden = true;
  if (S.view === "subs") return renderSubs();
  const el = $("#article"), h = S.list[S.sel];
  updateToolbar();
  if (!S.feeds.length) { renderWelcome(); return; }
  if (!h) { el.innerHTML = `<div class="nosel">${S.list.length ? "Select an article" : ""}</div>`; return; }
  const a = S.bodies.get(h.id), f = feedOf(h.feed_id);
  const site = a?.site_url || f?.site_url;
  el.innerHTML = `<div class="src-line">${icon(h.feed, f?.icon)}${site ? `<a href="${esc(site)}" data-ext>${esc(h.feed)}</a>` : esc(h.feed)}</div>
    <h1 class="title">${a?.url ? `<a href="${esc(a.url)}" data-ext>${esc(h.title)}</a>` : esc(h.title)}</h1>
    <div class="byline">${a?.author ? `<span>${esc(a.author)}</span>` : ""}<span>${longDate(h.published_at)}</span>${a?.content_html ? `<span>${minutes(a.content_html)} min read</span>` : ""}</div>
    <div class="body" id="body">${a ? a.content_html || `<p>${esc(h.summary)}</p>` : `<p class="ld">${esc(h.summary)}</p>`}</div>
    ${a?.url ? `<p class="web"><a href="${esc(a.url)}" data-ext>Read on ${esc(host(a.url))}</a></p>` : ""}`;
  el.scrollTop = 0;
  hydrateImages(el);
}
function updateToolbar() {
  const h = S.list[S.sel], show = S.view === "read" && !!h;
  for (const id of ["#t-read", "#t-star", "#t-web"]) $(id).style.visibility = show ? "" : "hidden";
  if (!h) return;
  $("#t-read").setAttribute("aria-pressed", String(!h.read));
  $("#t-read").title = h.read ? "Mark as unread (M)" : "Mark as read (M)";
  $("#t-star").setAttribute("aria-pressed", String(!!h.starred));
  const p = $("#t-star").querySelector("path") as SVGElement;
  p.setAttribute("fill", h.starred ? "var(--amber)" : "none"); p.setAttribute("stroke", h.starred ? "var(--amber)" : "currentColor");
}

// ---------- welcome and subscriptions ----------
function importBlock() {
  const nnw = S.sources?.[0];
  return `<div class="row">${nnw ? `<button class="btn primary" data-act="nnw" data-path="${esc(nnw.path)}">Import ${nnw.feeds} feeds from NetNewsWire</button>` : ""}
      <label class="btn ${nnw ? "" : "primary"}">Choose an OPML file…<input type="file" id="opml-file" accept=".opml,.xml,text/xml,application/xml" hidden></label></div>
    <div class="msg" id="imp-msg">Or ask in the chat: “Import my OPML from ~/Downloads/Subscriptions.opml”.</div>`;
}
function renderWelcome() {
  $("#article").innerHTML = `<div class="welcome page">${SVG.logo}<h1 class="title">Welcome to Readback</h1>
    <p class="lede">Your RSS feeds in ChatGPT. Read here, and select any passage to ask about it in the chat beside you.</p>
    <div class="blk"><h2>Bring in your subscriptions</h2><p>Readback keeps your folders. Feeds are checked every half hour while ChatGPT is open, and everything stays on this Mac.</p>${importBlock()}</div></div>`;
}
function renderSubs() {
  $("#pop").hidden = true; updateToolbar();
  const feeds = S.health || [];
  const folders = new Set(S.feeds.map(f => f.folder).filter(Boolean)).size;
  const groups = new Map<string, { title: string; why: string; feeds: any[] }>();
  for (const f of feeds) { const p = problem(f); if (!p) continue; (groups.get(p.key) ?? groups.set(p.key, { title: p.title, why: p.why, feeds: [] }).get(p.key)!).feeds.push(f); }
  const lastPost = (t: number) => t ? `last post ${new Date(t).toLocaleDateString(undefined, { month: "short", year: "numeric" })}` : "no posts fetched";
  const attn = [...groups.values()];
  const nAttn = attn.reduce((a, g) => a + g.feeds.length, 0);
  $("#article").innerHTML = `<div class="page"><h1 class="title">Subscriptions</h1>
    <p class="lede">${S.feeds.length.toLocaleString()} feeds${folders ? ` in ${folders} folder${folders > 1 ? "s" : ""}` : ""}.</p>
    <div class="blk"><h2>Add a feed</h2><p>Paste a website or a feed address. Readback finds the feed.</p>
      <form class="row" id="add-form"><input class="url" id="add-url" placeholder="example.com/blog" autocomplete="off" spellcheck="false" aria-label="Website or feed address"><button class="btn primary" type="submit">Add feed</button></form>
      <div class="msg" id="add-msg" hidden></div></div>
    <div class="blk"><h2>Import</h2><p>Feeds you already follow are skipped, and folders follow the file.</p>${importBlock()}</div>
    <div class="blk"><h2>Export</h2><p>Save every subscription, with folders, as an OPML file in Downloads.</p><div class="row"><button class="btn" data-act="export">Save OPML to Downloads</button></div><div class="msg" id="exp-msg" hidden></div></div>
    <div class="blk" id="attn"><h2>Feeds not updating</h2>${nAttn ? `<p>${nAttn} feeds haven't worked recently. Their articles stay readable until you unsubscribe.</p>
      ${attn.map(g => `<div class="grp"><div class="row" style="justify-content:space-between"><h3>${esc(g.title)} (${g.feeds.length})</h3>${g.feeds.length > 1 ? `<button class="btn danger" data-unsub="${g.feeds.map(f => f.id).join(",")}">Unsubscribe from all ${g.feeds.length}</button>` : ""}</div><p>${esc(g.why)}</p>
        ${g.feeds.map(f => `<div class="feedrow">${icon(f.title || host(f.url), f.icon)}<div class="nm">${esc(f.title || host(f.url))}<span>${esc(host(f.url))}, ${lastPost(f.newest)}</span></div><button class="lnk" data-unsub="${f.id}">Unsubscribe</button></div>`).join("")}</div>`).join("")}`
      : `<p>Every feed checked in fine.</p>`}</div>
    <div class="blk"><h2>Keyboard</h2><div class="keys"><span><kbd>j</kbd> <kbd>k</kbd></span><span>Next and previous article</span><span><kbd>space</kbd></span><span>Scroll, then the next unread article</span>
      <span><kbd>n</kbd></span><span>Next unread article</span><span><kbd>m</kbd></span><span>Mark read or unread</span><span><kbd>s</kbd></span><span>Star</span><span><kbd>b</kbd></span><span>Open in browser</span><span><kbd>r</kbd></span><span>Refresh feeds</span></div></div></div>`;
}
async function openSubs(focus?: string) {
  S.view = "subs"; S.sel = -1; renderSide(); renderList(); renderSubs(); go("article");
  const r = await B.call("reader_feeds"); S.health = r.feeds; S.sources = r.sources; renderSide(); renderSubs();
  if (focus === "attn") $("#attn")?.scrollIntoView({ block: "start" });
}

// ---------- images (fetched through the server, cached in memory) ----------
const imgs = new Map<string, string | null>(); const pendingImg = new Set<string>();
const imgUrls = (html: string) => [...String(html || "").matchAll(/data-img="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
async function fetchImages(urls: string[]) {
  const need = [...new Set(urls)].filter(u => !imgs.has(u) && !pendingImg.has(u));
  for (let i = 0; i < need.length; i += 12) {
    const chunk = need.slice(i, i + 12); chunk.forEach(u => pendingImg.add(u));
    try { const { images } = await B.call("reader_images", { urls: chunk }); for (const u of chunk) imgs.set(u, images[u] ?? null); }
    finally { chunk.forEach(u => pendingImg.delete(u)); }
  }
}
async function hydrateImages(root: HTMLElement) {
  const els = [...root.querySelectorAll<HTMLImageElement>("img[data-img]")]; if (!els.length) return;
  const put = () => els.forEach(im => { const u = im.dataset.img!; if (!imgs.has(u)) return; const d = imgs.get(u);
    if (d) { im.src = d; im.removeAttribute("data-img"); } else im.classList.add("noimg"); });
  put(); await fetchImages(els.map(im => im.dataset.img!)).catch(() => {}); if (root.isConnected) put();
}

// ---------- data flow ----------
async function loadBodies(ids: number[]) {
  const need = ids.filter(id => !S.bodies.has(id)); if (!need.length) return;
  const { articles } = await B.call("reader_articles", { ids: need.slice(0, 20) });
  for (const a of articles) S.bodies.set(a.id, a);
}
let markQ = new Map<number, boolean>(), markT: any;
function queueRead(id: number, read: boolean) {
  markQ.set(id, read); clearTimeout(markT);
  markT = setTimeout(() => { const yes = [...markQ].filter(([, r]) => r).map(([i]) => i), no = [...markQ].filter(([, r]) => !r).map(([i]) => i); markQ = new Map();
    if (yes.length) B.call("reader_mark", { ids: yes, read: true }); if (no.length) B.call("reader_mark", { ids: no, read: false }); }, 400);
}
function bump(h: Head, delta: number) {
  const f = feedOf(h.feed_id); if (f) f.unread = Math.max(0, f.unread + delta);
  S.smart.unread = Math.max(0, (S.smart.unread || 0) + delta);
  if (Date.now() - h.published_at < DAY) S.smart.today = Math.max(0, (S.smart.today || 0) + delta);
}
async function select(i: number) {
  if (i < 0 || i >= S.list.length) return;
  const t = performance.now(); S.view = "read"; S.sel = i; const h = S.list[i];
  if (!h.read) { h.read = 1; bump(h, -1); queueRead(h.id, true); }
  renderSide(); renderList(); $(`.art[data-i="${i}"]`)?.scrollIntoView({ block: "nearest" });
  const cached = S.bodies.has(h.id);
  renderArticle(); go("article");
  if (!cached) { await loadBodies([h.id]); if (S.sel === i) renderArticle(); }
  metrics[cached ? "selectCachedMs" : "selectFetchMs"] = Math.round(performance.now() - t);
  report();
  if (i > S.list.length - 8) loadMore();
  loadBodies(S.list.slice(i + 1, i + 11).map(a => a.id)).then(() => { // prefetch the next 10, and the next article's images
    const n = S.list[i + 1] && S.bodies.get(S.list[i + 1].id); if (n) fetchImages(imgUrls(n.content_html)).catch(() => {});
  }).catch(() => {});
}
async function setScope(scope: string) {
  const t = performance.now(); S.scope = scope; S.view = "read"; S.sel = -1; S.end = false; $("#app").dataset.side = "";
  renderSide();
  const r = await B.call("reader_list", { scope }); if (S.scope !== scope) return;
  S.list = r.list; S.end = r.list.length < 60; renderList(); renderArticle(); $("#list").scrollTop = 0; go("list");
  metrics.scopeMs = Math.round(performance.now() - t); report();
  loadBodies(S.list.slice(0, 10).map(a => a.id)).catch(() => {});
}
async function loadMore() {
  if (S.end || S.loadingMore || !S.list.length) return;
  S.loadingMore = true; const scope = S.scope;
  try { const before = S.list[S.list.length - 1].published_at;
    const r = await B.call("reader_list", { scope, before }); if (S.scope !== scope) return;
    const seen = new Set(S.list.map(a => a.id)); const add = r.list.filter((a: Head) => !seen.has(a.id));
    S.list.push(...add); S.end = r.list.length < 60 || !add.length;
    const top = $("#list").scrollTop; renderList(); $("#list").scrollTop = top;
  } finally { S.loadingMore = false; }
}
// Nothing about what you read goes to ChatGPT until you ask. When you use Ask, Explain or Fact-check,
// the open article (a visible title chip plus its text, hidden) and your selection go with the question.
function shareContext(selection: string) {
  const h = S.list[S.sel], a = h && S.bodies.get(h.id); if (!h) return Promise.resolve();
  const text = plain(a?.content_html || "").slice(0, 40000);
  return B.context([
    { type: "text", text: `Article: ${h.title}`, _meta: { "openai/title": h.title, "openai/group": { title: "From Readback" } } },
    { type: "text", text: `Full text of "${h.title}" (${h.feed}, ${a?.url || ""}, Readback article id ${h.id}):\n${text}`, annotations: { audience: ["assistant"] } },
    { type: "text", text: selection, _meta: { "openai/title": "Selection", "openai/group": { title: "From Readback" } } },
  ], { articleId: h.id }).catch(() => {});
}
let toastT: any;
function toast(text: string, action?: [string, () => void]) {
  const el = $("#toast"); $("#toast-t").textContent = text; const b = $("#toast-b") as HTMLButtonElement;
  b.hidden = !action; if (action) { b.textContent = action[0]; b.onclick = () => { el.hidden = true; action[1](); }; }
  el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 6000);
}
const go = (pane: "list" | "article") => { $("#app").dataset.pane = pane; };

// ---------- refresh and import ----------
async function poll() {
  for (let i = 0; i < 90; i++) {
    const s = await B.call("reader_status"); S.feeds = s.feeds; S.smart = s.smart; S.lastRefresh = s.lastRefresh; S.refreshing = s.refreshing; renderSide();
    if (!s.refreshing) {
      if (S.view === "read") { const r = await B.call("reader_list", { scope: S.scope }); const keep = S.list[S.sel]?.id;
        S.list = r.list; S.end = r.list.length < 60; S.sel = keep ? S.list.findIndex(a => a.id === keep) : -1; renderList();
        if (S.sel < 0 && S.list.length && !keep) select(0); else renderArticle(); }
      else openSubs();
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}
function refresh() {
  if (S.refreshing) return; S.refreshing = true; renderSide();
  B.call("reader_refresh").catch(() => {}); setTimeout(poll, 800);
}
async function runImport(args: any) {
  const m = $("#imp-msg"); if (m) { m.className = "msg"; m.textContent = "Importing…"; }
  try { const r = await B.call("reader_import", args); S.feeds = r.feeds; S.smart = r.smart; S.refreshing = true;
    const firstFolder = (r.folders || [])[0]; if (firstFolder && !S.open.size) S.open.add(firstFolder);
    renderSide(); renderList();
    if (m) m.textContent = r.added ? `Added ${r.added} feeds. Fetching their articles now; this takes about a minute.` : "Those feeds are already here.";
    setTimeout(poll, 1500);
  } catch (e: any) { if (m) { m.className = "msg err"; m.textContent = `That file couldn't be read as OPML. ${e?.message || ""}`; } }
}

// ---------- selection → ask ----------
const pop = $("#pop");
document.addEventListener("selectionchange", () => {
  const s = getSelection(); const body = $("#body");
  if (!s || s.isCollapsed || !body || !body.contains(s.anchorNode)) { pop.hidden = true; return; }
  const r = s.getRangeAt(0).getBoundingClientRect(), box = $("#rc").getBoundingClientRect();
  pop.hidden = false;
  pop.style.top = `${Math.max(48, r.top - box.top - pop.offsetHeight - 10)}px`;
  pop.style.left = `${Math.max(8, Math.min(r.left - box.left, box.width - pop.offsetWidth - 8))}px`;
});
pop.addEventListener("mousedown", e => e.preventDefault()); // keep the selection
pop.addEventListener("click", async e => {
  const k = (e.target as HTMLElement).closest("button")?.dataset.k; if (!k) return;
  const sel = (getSelection()?.toString() || "").trim().slice(0, 4000); pop.hidden = true;
  const h = S.list[S.sel];
  await shareContext(sel);
  if (k === "ask") await B.message("", { quote: sel, send: false }).catch(() => {});
  else await B.message(k === "explain" ? `Explain this passage from "${h.title}".` : `Fact-check this claim from "${h.title}".`, { quote: sel, send: true }).catch(() => {});
});

// ---------- events ----------
document.addEventListener("click", async e => {
  const t = e.target as HTMLElement;
  const ext = t.closest("a[href]") as HTMLAnchorElement | null;
  if (ext && ext.closest("#article")) { e.preventDefault(); B.openLink(ext.href); return; }
  const b = t.closest("button") as HTMLElement | null; if (!b) return;
  if (b.dataset.fold) { const f = b.dataset.fold; S.open.has(f) ? S.open.delete(f) : S.open.add(f); renderSide(); }
  else if (b.dataset.scope) setScope(b.dataset.scope);
  else if (b.dataset.i) select(+b.dataset.i);
  else if (b.dataset.subs) { $("#app").dataset.side = ""; openSubs(b.dataset.subs); }
  else if (b.dataset.act === "nnw") runImport({ path: b.dataset.path });
  else if (b.dataset.act === "export") { const r = await B.call("reader_export"); const m = $("#exp-msg"); m.hidden = false; m.textContent = `Saved to ${r.path.replace(/^\/Users\/[^/]+/, "~")}`; }
  else if (b.dataset.unsub) {
    const ids = b.dataset.unsub.split(",").map(Number);
    if (ids.length > 1 && b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = `Remove ${ids.length} feeds and their articles`; return; }
    const r = await B.call("reader_unsubscribe", { ids }); S.health = r.health; S.feeds = r.feeds; S.smart = r.smart;
    renderSide(); renderSubs(); toast(`Unsubscribed from ${r.removed} feed${r.removed === 1 ? "" : "s"}`);
  }
  else if (b.id === "t-side") $("#app").dataset.side = $("#app").dataset.side === "open" ? "" : "open";
  else if (b.id === "t-back") go("list");
  else if (b.id === "t-subs") { $("#app").dataset.side = ""; openSubs(); }
  else if (b.id === "t-refresh") refresh();
  else if (b.id === "t-read") { const h = S.list[S.sel]; if (h) { h.read = h.read ? 0 : 1; bump(h, h.read ? -1 : 1); queueRead(h.id, !!h.read); renderList(); renderSide(); updateToolbar(); } }
  else if (b.id === "t-star") { const h = S.list[S.sel]; if (h) { h.starred = h.starred ? 0 : 1; S.smart.starred += h.starred ? 1 : -1; B.call("reader_mark", { ids: [h.id], starred: !!h.starred }); renderList(); renderSide(); updateToolbar(); } }
  else if (b.id === "t-all") {
    if (!scopeUnread()) return; const scope = S.scope;
    const r = await B.call("reader_mark_scope", { scope }); S.feeds = r.feeds; S.smart = r.smart; S.list.forEach(a => a.read = 1); renderSide(); renderList();
    toast(`Marked ${r.ids.length.toLocaleString()} as read`, ["Undo", async () => {
      await B.call("reader_mark", { ids: r.ids, read: false }); const s = await B.call("reader_status"); S.feeds = s.feeds; S.smart = s.smart;
      if (S.scope === scope) setScope(scope); else renderSide(); }]);
  }
  else if (b.id === "t-web") { const h = S.list[S.sel], a = h && S.bodies.get(h.id); if (a?.url) B.openLink(a.url); }
});
document.addEventListener("submit", async e => {
  if ((e.target as HTMLElement).id !== "add-form") return; e.preventDefault();
  const input = $("#add-url") as HTMLInputElement, m = $("#add-msg"); const url = input.value.trim(); if (!url) return;
  m.hidden = false; m.className = "msg"; m.textContent = "Looking for the feed…";
  const r = await B.call("reader_add_feed", { url });
  if (!r.ok) { m.className = "msg err"; m.textContent = r.error; return; }
  S.feeds = r.feeds; S.smart = r.smart; input.value = ""; renderSide();
  m.textContent = `Subscribed to ${r.feed.title || url}${r.feed.added ? `, with ${r.feed.added} articles` : ""}.`;
});
document.addEventListener("change", async e => {
  const t = e.target as HTMLInputElement; if (t.id !== "opml-file" || !t.files?.[0]) return;
  runImport({ opml: await t.files[0].text() });
});
$("#list").addEventListener("scroll", () => { const l = $("#list"); if (l.scrollTop + l.clientHeight > l.scrollHeight - 400) loadMore(); }, { passive: true });
document.addEventListener("keydown", e => {
  if ((e.target as HTMLElement).closest("input,textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const nextUnread = () => S.list.findIndex((a, i) => i > S.sel && !a.read);
  if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); select(S.sel + 1); }
  else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); select(S.sel - 1); }
  else if (e.key === "n") { const n = nextUnread(); if (n >= 0) select(n); }
  else if (e.key === " ") { const el = $("#article"); if (el.scrollTop + el.clientHeight >= el.scrollHeight - 4) { e.preventDefault(); const n = nextUnread(); if (n >= 0) select(n); } }
  else if (e.key === "m") $("#t-read").click(); else if (e.key === "s") $("#t-star").click(); else if (e.key === "b") $("#t-web").click();
  else if (e.key === "r") refresh();
  else if (e.key === "Escape") { pop.hidden = true; $("#app").dataset.side = ""; }
});

// ---------- resizable panes (widths saved on the server, so they survive restarts) ----------
const LIMITS: Record<string, [number, number]> = { "1": [170, 420], "2": [240, 560] };
function applyWidths(p: any) {
  const app = $("#app");
  for (const k of ["1", "2"]) if (p?.[`w${k}`]) { app.style.setProperty(`--w${k}`, `${p[`w${k}`]}px`); app.dataset.sized = "1"; }
}
let saveW: any;
function saveWidths() {
  clearTimeout(saveW);
  saveW = setTimeout(() => { const cs = getComputedStyle($("#app"));
    B.call("reader_prefs", { set: { w1: parseInt(cs.getPropertyValue("--w1")) || 236, w2: parseInt(cs.getPropertyValue("--w2")) || 330 } }).catch(() => {}); }, 300);
}
function setWidth(col: string, px: number) {
  const [lo, hi] = LIMITS[col]; const app = $("#app");
  const other = col === "1" ? ($("#tl").offsetWidth) : ($("#side").offsetWidth);
  const max = Math.min(hi, app.offsetWidth - other - 380); // the article keeps at least 380px
  app.style.setProperty(`--w${col}`, `${Math.round(Math.max(lo, Math.min(max, px)))}px`); app.dataset.sized = "1";
}
document.addEventListener("pointerdown", e => {
  const g = (e.target as HTMLElement).closest(".grip") as HTMLElement | null; if (!g) return;
  e.preventDefault(); const col = g.dataset.col!; const pane = col === "1" ? $("#side") : $("#tl");
  const startX = e.clientX, startW = pane.offsetWidth;
  try { g.setPointerCapture(e.pointerId); } catch {}
  g.classList.add("drag"); document.body.classList.add("resizing");
  const move = (ev: PointerEvent) => setWidth(col, startW + ev.clientX - startX);
  const up = () => { g.classList.remove("drag"); document.body.classList.remove("resizing");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); window.removeEventListener("pointercancel", up); saveWidths(); };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", up); window.addEventListener("pointercancel", up);
});
document.addEventListener("dblclick", e => { // double-click a divider to reset both widths
  if (!(e.target as HTMLElement).closest(".grip")) return;
  const app = $("#app"); app.style.removeProperty("--w1"); app.style.removeProperty("--w2"); delete app.dataset.sized;
  B.call("reader_prefs", { set: { w1: null, w2: null } }).catch(() => {});
});
document.addEventListener("keydown", e => { // arrow keys on a focused divider
  const g = (e.target as HTMLElement).closest?.(".grip") as HTMLElement | null; if (!g || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault(); e.stopPropagation(); const pane = g.dataset.col === "1" ? $("#side") : $("#tl");
  setWidth(g.dataset.col!, pane.offsetWidth + (e.key === "ArrowRight" ? 16 : -16)); saveWidths();
}, true);

function apply(r: any) {
  applyWidths(r.prefs);
  S.feeds = r.feeds || []; S.smart = r.smart || {}; S.lastRefresh = r.lastRefresh; S.scope = r.scope || S.scope; S.sources = r.sources || [];
  S.list = r.list || []; S.end = S.list.length < 60; S.sel = S.list.length ? 0 : -1;
  for (const a of r.articles || []) S.bodies.set(a.id, a);
  if (!S.open.size) { const first = S.feeds.find(f => f.folder)?.folder; if (first) S.open.add(first); }
  if (S.sel === 0) { const h = S.list[0]; if (!h.read) { h.read = 1; bump(h, -1); queueRead(h.id, true); } }
  renderSide(); renderList(); renderArticle();
}
B.onHostContext(c => { if (c?.theme) document.documentElement.dataset.theme = c.theme; });
B.onToolResult(r => {
  const data = r.structuredContent ?? JSON.parse(r.content?.[0]?.text || "{}");
  apply(data); metrics.firstPaintMs = Math.round(performance.now() - T0); report();
  loadBodies(S.list.slice(1, 11).map(a => a.id)).catch(() => {});
});

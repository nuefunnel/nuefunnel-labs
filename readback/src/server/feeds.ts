// Fetching feeds politely: conditional GET, Retry-After, exponential backoff, and only new items get cleaned.
import { parseFeed } from "feedsmith";
import type { DB } from "./db.ts";
import { sanitize, strip } from "./sanitize.ts";
import { KEEP_DAYS } from "./maintenance.ts";
import { VERSION } from "./version.ts";

export const UA = `Readback/${VERSION} (personal RSS reader; +https://github.com/nuefunnel/nuefunnel-labs/tree/main/readback)`;
const MIN = 60e3, DAY = 86400e3;
const EVERY = 30 * MIN;          // normal check interval per feed
const UNREAD_WINDOW = 7 * DAY;   // when a feed is first added, only the last week starts out unread

const val = (s: any): string => (s && typeof s === "object" ? (s.value ?? s.href ?? "") : (s ?? "")) + "";

export function normItems(format: string, feed: any) {
  const list = format === "atom" ? feed.entries : feed.items;
  return (list || []).map((i: any) => {
    const link = format === "atom" ? (i.links?.find((l: any) => !l.rel || l.rel === "alternate")?.href) : (i.link || i.url);
    const html = format === "json" ? (i.content_html || i.content_text || i.summary || "")
      : format === "atom" ? val(i.content) || val(i.summary) : (i.content?.encoded || i.description || "");
    const pub = Date.parse(i.published || i.updated || i.pubDate || i.date_published || i.dc?.date || "") || 0; // undated items sort last
    return { guid: val(i.id || i.guid) || link || val(i.title), url: link as string | undefined, title: strip(val(i.title)) || "(untitled)",
      author: val(i.author?.name || i.authors?.[0]?.name || i.dc?.creator || ""), html: val(html), pub };
  });
}

export function siteOf(format: string, feed: any): string | null {
  if (format === "atom") return feed.links?.find((l: any) => l.rel === "alternate" || !l.rel)?.href || null;
  return feed.link || feed.home_page_url || null;
}

export async function refreshFeed(db: DB, f: any) {
  const h: Record<string, string> = { "user-agent": UA, accept: "application/rss+xml, application/atom+xml, application/feed+json, application/xml;q=0.9, */*;q=0.8" };
  if (f.etag) h["if-none-match"] = f.etag;
  if (f.last_modified) h["if-modified-since"] = f.last_modified;
  const now = Date.now();
  try {
    const r = await fetch(f.url, { headers: h, signal: AbortSignal.timeout(20000) });
    if (r.status === 304) {
      db.prepare("UPDATE feeds SET last_fetch_at=?, next_fetch_at=?, error_count=0, last_error=NULL WHERE id=?").run(now, now + EVERY, f.id);
      return { id: f.id, status: 304, added: 0 };
    }
    if (r.status === 429 || r.status === 503) {
      const wait = (+(r.headers.get("retry-after") || 0) || 3600) * 1000;
      db.prepare("UPDATE feeds SET next_fetch_at=?, last_error=? WHERE id=?").run(now + wait, `HTTP ${r.status}, retrying later`, f.id);
      return { id: f.id, status: r.status, added: 0 };
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { format, feed } = parseFeed(await r.text()) as any;
    const items = normItems(format, feed).slice(0, 50);
    const known = new Set((db.prepare("SELECT guid FROM articles WHERE feed_id=?").all(f.id) as any[]).map(x => x.guid));
    const first = !f.last_fetch_at;
    const ins = db.prepare(`INSERT INTO articles (feed_id,guid,url,title,author,published_at,summary,content_html,read,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(feed_id,guid) DO NOTHING`);
    let added = 0;
    db.exec("BEGIN");
    try {
      for (const it of items) {
        if (known.has(it.guid)) continue;
        if (it.pub && it.pub < now - KEEP_DAYS * DAY) continue; // older than what we keep; storing it would bring deleted articles back
        const startRead = first && (!it.pub || it.pub < now - UNREAD_WINDOW) ? 1 : 0;
        ins.run(f.id, it.guid, it.url ?? null, it.title, it.author || null, it.pub, strip(it.html).slice(0, 240), sanitize(it.html, it.url || f.url), startRead, now);
        added++;
      }
      db.prepare("UPDATE feeds SET title=COALESCE(?, title), site_url=COALESCE(site_url, ?), etag=?, last_modified=?, last_fetch_at=?, next_fetch_at=?, error_count=0, last_error=NULL WHERE id=?")
        .run(strip(val(feed.title)) || null, siteOf(format, feed), r.headers.get("etag"), r.headers.get("last-modified"), now, now + EVERY, f.id);
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    return { id: f.id, status: r.status, added };
  } catch (e: any) {
    const backoff = Math.min(DAY, EVERY * 2 ** (f.error_count || 0));
    db.prepare("UPDATE feeds SET error_count=error_count+1, last_error=?, next_fetch_at=? WHERE id=?").run(String(e.message || e).slice(0, 200), now + backoff, f.id);
    return { id: f.id, status: "error", error: String(e.message || e).slice(0, 80) };
  }
}

export async function refreshDue(db: DB, opts: { limit?: number; all?: boolean } = {}) {
  const rows = db.prepare(`SELECT * FROM feeds ${opts.all ? "" : "WHERE next_fetch_at <= ?"} ORDER BY next_fetch_at LIMIT ?`)
    .all(...(opts.all ? [] : [Date.now()]), opts.limit ?? 200) as any[];
  const out: any[] = []; let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => { while (i < rows.length) out.push(await refreshFeed(db, rows[i++])); }));
  return out;
}

// Add one feed from a feed address or a site address (finds the site's advertised feed).
export async function discoverFeed(input: string): Promise<{ url: string; title: string | null; site_url: string | null }> {
  let url = input.trim(); if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const r = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`The address answered HTTP ${r.status}.`);
  const text = await r.text();
  try { const { format, feed } = parseFeed(text) as any; return { url: r.url, title: strip(val(feed.title)) || null, site_url: siteOf(format, feed) }; } catch {}
  const m = [...text.matchAll(/<link\b[^>]*>/gi)].map(x => x[0]).find(t => /rel=["']?alternate/i.test(t) && /(rss|atom|feed)\+?(xml|json)/i.test(t));
  const href = m?.match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) throw new Error("No feed found at that address. Try the feed's own address.");
  const feedUrl = new URL(href.replace(/&amp;/g, "&"), r.url).href;
  const fr = await fetch(feedUrl, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15000) });
  const { format, feed } = parseFeed(await fr.text()) as any;
  return { url: feedUrl, title: strip(val(feed.title)) || null, site_url: siteOf(format, feed) || r.url };
}

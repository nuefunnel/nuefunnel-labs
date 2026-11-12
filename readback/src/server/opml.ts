// Subscriptions in and out: OPML import (folders kept), and finding NetNewsWire's own list on this Mac.
import { parseOpml } from "feedsmith";
import fs from "node:fs";
import os from "node:os";
import type { DB } from "./db.ts";

export type FeedRow = { url: string; title: string | null; folder: string | null; site_url: string | null };

export function parseSubscriptions(text: string): FeedRow[] {
  const opml = parseOpml(text) as any;
  const out: FeedRow[] = [];
  const walk = (outlines: any[] | undefined, folder: string | null) => {
    for (const o of outlines || []) {
      if (o.xmlUrl) out.push({ url: o.xmlUrl, title: o.title || o.text || null, folder, site_url: o.htmlUrl || null });
      else walk(o.outlines, o.title || o.text || folder);
    }
  };
  walk(opml.body?.outlines, null);
  return out;
}

export function importFeeds(db: DB, rows: FeedRow[]) {
  const ins = db.prepare("INSERT INTO feeds (url, title, folder, site_url, added_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET folder=excluded.folder");
  const before = (db.prepare("SELECT COUNT(*) n FROM feeds").get() as any).n;
  db.exec("BEGIN");
  for (const r of rows) ins.run(r.url, r.title, r.folder, r.site_url, Date.now());
  db.exec("COMMIT");
  const after = (db.prepare("SELECT COUNT(*) n FROM feeds").get() as any).n;
  return { inFile: rows.length, added: after - before, folders: [...new Set(rows.map(r => r.folder).filter(Boolean))] };
}

export function exportOpml(db: DB): string {
  const esc = (s: any) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
  const feeds = db.prepare("SELECT url, title, folder, site_url FROM feeds ORDER BY folder, lower(title)").all() as FeedRow[];
  const line = (f: FeedRow, pad: string) => `${pad}<outline type="rss" text="${esc(f.title)}" title="${esc(f.title)}" xmlUrl="${esc(f.url)}"${f.site_url ? ` htmlUrl="${esc(f.site_url)}"` : ""}/>`;
  const groups = new Map<string, FeedRow[]>();
  for (const f of feeds) (groups.get(f.folder || "") ?? groups.set(f.folder || "", []).get(f.folder || "")!).push(f);
  const body = [...groups].map(([folder, fs]) => folder
    ? `    <outline text="${esc(folder)}" title="${esc(folder)}">\n${fs.map(f => line(f, "      ")).join("\n")}\n    </outline>`
    : fs.map(f => line(f, "    ")).join("\n")).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.1">\n  <head><title>Readback subscriptions</title></head>\n  <body>\n${body}\n  </body>\n</opml>\n`;
}

// NetNewsWire (Mac App Store and direct builds) keeps each account's subscriptions as OPML.
export function findNetNewsWire(): { path: string; feeds: number; modified: number }[] {
  const roots = [
    `${os.homedir()}/Library/Containers/com.ranchero.NetNewsWire-Evergreen/Data/Library/Application Support/NetNewsWire/Accounts`,
    `${os.homedir()}/Library/Application Support/NetNewsWire/Accounts`,
  ];
  const out: { path: string; feeds: number; modified: number }[] = [];
  for (const root of roots) {
    let accounts: string[] = [];
    try { accounts = fs.readdirSync(root); } catch { continue; }
    for (const a of accounts) {
      const p = `${root}/${a}/Subscriptions.opml`;
      try { const text = fs.readFileSync(p, "utf8"); out.push({ path: p, feeds: parseSubscriptions(text).length, modified: fs.statSync(p).mtimeMs }); } catch {}
    }
  }
  return out.filter(o => o.feeds > 0).sort((a, b) => b.feeds - a.feeds);
}

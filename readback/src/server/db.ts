// SQLite store. One file in the user's data folder, shared by every server process the app starts.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";

export type DB = DatabaseSync;
const DAY = 86400e3;

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(`${dataDir}/readback.sqlite`);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY, url TEXT UNIQUE NOT NULL, title TEXT, folder TEXT, site_url TEXT,
      icon TEXT, icon_checked_at INTEGER,
      etag TEXT, last_modified TEXT, next_fetch_at INTEGER DEFAULT 0, last_fetch_at INTEGER,
      error_count INTEGER DEFAULT 0, last_error TEXT, added_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS articles (
      id INTEGER PRIMARY KEY, feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE, guid TEXT NOT NULL,
      url TEXT, title TEXT, author TEXT, published_at INTEGER, summary TEXT, content_html TEXT,
      read INTEGER DEFAULT 0, starred INTEGER DEFAULT 0, created_at INTEGER,
      UNIQUE(feed_id, guid)
    );
    CREATE INDEX IF NOT EXISTS idx_articles_feed_pub ON articles(feed_id, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_unread ON articles(read, published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_articles_unread_feed ON articles(read, feed_id, published_at);
    CREATE TABLE IF NOT EXISTS lease (name TEXT PRIMARY KEY, holder TEXT, until INTEGER);
    CREATE TABLE IF NOT EXISTS prefs (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}

export type Head = { id: number; feed_id: number; feed: string; title: string; summary: string; published_at: number; read: number; starred: number };

export function sidebar(db: DB) {
  const counts = db.prepare("SELECT feed_id, COUNT(*) AS unread, SUM(published_at > ?) AS today FROM articles WHERE read=0 GROUP BY feed_id").all(Date.now() - DAY) as any[];
  const byFeed = new Map(counts.map(r => [r.feed_id, r]));
  const feeds = (db.prepare("SELECT id, title, folder, site_url, icon, last_error, error_count FROM feeds ORDER BY folder, lower(title)").all() as any[])
    .map(f => ({ ...f, unread: byFeed.get(f.id)?.unread || 0 }));
  const smart = {
    today: counts.reduce((a, r) => a + (r.today || 0), 0),
    unread: counts.reduce((a, r) => a + r.unread, 0),
    starred: (db.prepare("SELECT COUNT(*) AS n FROM articles WHERE starred=1").get() as any).n,
  };
  const lastRefresh = (db.prepare("SELECT MAX(last_fetch_at) AS t FROM feeds").get() as any).t;
  return { feeds, smart, lastRefresh };
}

export function listArticles(db: DB, scope: string, before?: number, limit = 60): Head[] {
  let [where, b] = scopeWhere(scope); b = [...b];
  if (before) { where += " AND a.published_at < ?"; b.push(before); }
  return db.prepare(`SELECT a.id, a.feed_id, f.title AS feed, a.title, a.summary, a.published_at, a.read, a.starred
    FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE ${where} ORDER BY a.published_at DESC LIMIT ?`).all(...b, limit) as Head[];
}

export function getArticles(db: DB, ids: number[]) {
  if (!ids.length) return [];
  return db.prepare(`SELECT a.id, a.feed_id, f.title AS feed, f.site_url, a.url, a.title, a.author, a.published_at, a.content_html, a.read, a.starred
    FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE a.id IN (${ids.map(() => "?").join(",")})`).all(...ids) as any[];
}

function scopeWhere(scope: string): [string, any[]] {
  if (scope === "unread") return ["a.read=0", []];
  if (scope === "today") return ["a.published_at > ?", [Date.now() - DAY]];
  if (scope === "starred") return ["a.starred=1", []];
  if (scope.startsWith("feed:")) return ["a.feed_id=?", [+scope.slice(5)]];
  if (scope.startsWith("folder:")) return ["f.folder=?", [scope.slice(7)]];
  return ["1=1", []];
}

// Mark everything unread in a scope as read; returns the ids so the reader can offer Undo.
export function markScopeRead(db: DB, scope: string): number[] {
  const [where, b] = scopeWhere(scope);
  const ids = (db.prepare(`SELECT a.id FROM articles a JOIN feeds f ON f.id=a.feed_id WHERE a.read=0 AND ${where}`).all(...b) as any[]).map(r => r.id);
  for (let i = 0; i < ids.length; i += 500) mark(db, ids.slice(i, i + 500), true);
  return ids;
}

export function feedHealth(db: DB) {
  return db.prepare(`SELECT f.id, f.title, f.url, f.site_url, f.folder, f.icon, f.last_error, f.error_count, f.last_fetch_at,
      (SELECT MAX(published_at) FROM articles WHERE feed_id=f.id) AS newest
    FROM feeds f ORDER BY lower(f.title)`).all() as any[];
}

export function unsubscribe(db: DB, ids: number[]) {
  if (!ids.length) return 0;
  const ph = ids.map(() => "?").join(",");
  db.exec("BEGIN");
  db.prepare(`DELETE FROM articles WHERE feed_id IN (${ph})`).run(...ids);
  const r = db.prepare(`DELETE FROM feeds WHERE id IN (${ph})`).run(...ids);
  db.exec("COMMIT");
  return Number(r.changes);
}

export function mark(db: DB, ids: number[], read?: boolean, starred?: boolean) {
  if (!ids.length) return;
  const ph = ids.map(() => "?").join(",");
  if (read !== undefined) db.prepare(`UPDATE articles SET read=? WHERE id IN (${ph})`).run(read ? 1 : 0, ...ids);
  if (starred !== undefined) db.prepare(`UPDATE articles SET starred=? WHERE id IN (${ph})`).run(starred ? 1 : 0, ...ids);
}

// A lease row decides which of the app's several server processes does background work.
export function holdLease(db: DB, name: string, holder: string, ms: number): boolean {
  const now = Date.now();
  db.prepare(`INSERT INTO lease (name, holder, until) VALUES (?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET holder=excluded.holder, until=excluded.until WHERE lease.until < ? OR lease.holder = excluded.holder`)
    .run(name, holder, now + ms, now);
  return (db.prepare("SELECT holder FROM lease WHERE name=?").get(name) as any)?.holder === holder;
}

export function getPrefs(db: DB): Record<string, any> {
  const out: Record<string, any> = {};
  for (const r of db.prepare("SELECT key, value FROM prefs").all() as any[]) { try { out[r.key] = JSON.parse(r.value); } catch {} }
  return out;
}
export function setPrefs(db: DB, prefs: Record<string, any>) {
  const st = db.prepare("INSERT INTO prefs (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [k, v] of Object.entries(prefs)) st.run(k, JSON.stringify(v));
}

// Keeping the data folder small. Runs at most once a day, in whichever server process holds the lease.
//  - Read, unstarred articles older than KEEP_DAYS are deleted. Feeds keep listing old items, so
//    refreshFeed never stores items older than the same window again (see feeds.ts).
//  - Undated articles can't be told apart from new ones, so old read ones keep a small stub (no text)
//    instead of being deleted; otherwise they would come back as unread.
//  - The image cache is capped at IMAGE_CACHE_MB, dropping the least recently used images first.
//  - The database file is compacted when more than a quarter of it is free space.
import fs from "node:fs";
import type { DB } from "./db.ts";

export const KEEP_DAYS = 90;
export const IMAGE_CACHE_MB = 300;
const DAY = 86400e3;

export function pruneArticles(db: DB, now = Date.now()) {
  const cutoff = now - KEEP_DAYS * DAY;
  const deleted = Number(db.prepare("DELETE FROM articles WHERE read=1 AND starred=0 AND published_at > 0 AND published_at < ?").run(cutoff).changes);
  const stubbed = Number(db.prepare("UPDATE articles SET content_html=NULL, summary=NULL WHERE read=1 AND starred=0 AND (published_at IS NULL OR published_at=0) AND created_at < ? AND content_html IS NOT NULL").run(cutoff).changes);
  return { deleted, stubbed };
}

export function trimImageCache(dataDir: string, maxBytes = IMAGE_CACHE_MB * 1024 * 1024) {
  const dir = `${dataDir}/images/`;
  let files: { f: string; size: number; used: number }[] = [];
  try {
    files = fs.readdirSync(dir).filter(f => !f.endsWith(".json")).map(f => { const st = fs.statSync(dir + f); return { f, size: st.size, used: st.atimeMs > st.mtimeMs ? st.atimeMs : st.mtimeMs }; });
  } catch { return { removed: 0, freedMB: 0, keptMB: 0 }; }
  let total = files.reduce((a, x) => a + x.size, 0), removed = 0, freed = 0;
  for (const x of files.sort((a, b) => a.used - b.used)) {
    if (total <= maxBytes) break;
    fs.rmSync(dir + x.f, { force: true }); fs.rmSync(dir + x.f + ".json", { force: true });
    total -= x.size; freed += x.size; removed++;
  }
  // Old "this image failed" markers are retried after a week.
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json") && !fs.existsSync(dir + f.slice(0, -5)) && Date.now() - fs.statSync(dir + f).mtimeMs > 7 * DAY) fs.rmSync(dir + f, { force: true }); } catch {}
  return { removed, freedMB: +(freed / 1048576).toFixed(1), keptMB: +(total / 1048576).toFixed(1) };
}

export function compactDb(db: DB) {
  const pages = (db.prepare("PRAGMA page_count").get() as any).page_count, free = (db.prepare("PRAGMA freelist_count").get() as any).freelist_count;
  if (free < 1000 || free / pages < 0.25) return false;
  try { db.exec("VACUUM"); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); return true; }
  catch { return false; } // another process is busy with the database; try again tomorrow
}

export function maintain(db: DB, dataDir: string) {
  const size = () => { try { return +(fs.statSync(`${dataDir}/readback.sqlite`).size / 1048576).toFixed(1); } catch { return 0; } };
  const before = size();
  const articles = pruneArticles(db), images = trimImageCache(dataDir), compacted = compactDb(db);
  db.prepare("INSERT INTO prefs (key, value) VALUES ('last_maintenance', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(Date.now()));
  return { ...articles, images, compacted, dbMB: { before, after: size() } };
}

export function maintenanceDue(db: DB) {
  const r = db.prepare("SELECT value FROM prefs WHERE key='last_maintenance'").get() as any;
  return !r || Date.now() - JSON.parse(r.value) > DAY;
}

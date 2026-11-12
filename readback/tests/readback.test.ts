import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs"; import os from "node:os"; import http from "node:http";
import { sanitize } from "../src/server/sanitize.ts";
import { parseSubscriptions, importFeeds, exportOpml } from "../src/server/opml.ts";
import { openDb, holdLease, listArticles, sidebar } from "../src/server/db.ts";
import { refreshDue } from "../src/server/feeds.ts";

const tmp = () => fs.mkdtempSync(os.tmpdir() + "/readback-test-");

test("sanitize removes active content and keeps images as data-img", () => {
  const out = sanitize(`<p onclick="x()" style="color:red" class="c">Hi <a href="javascript:alert(1)">bad</a> <a href="/post">rel</a></p>
    <script>alert(1)</script><iframe src="https://x"></iframe><!-- <script>y</script> -->
    <img src="/a.png" srcset="a 2x"><img src="https://t.co/p.gif" width="1" height="1"><img data-src="https://cdn/b.jpg">`, "https://example.com/blog/");
  assert.doesNotMatch(out, /script|iframe|onclick|style=|class=|javascript:|srcset|<!--/);
  assert.match(out, /href="https:\/\/example.com\/post"/);
  assert.match(out, /data-img="https:\/\/example.com\/a.png"/);
  assert.match(out, /data-img="https:\/\/cdn\/b.jpg"/);
  assert.doesNotMatch(out, /t.co\/p.gif/, "tracking pixel dropped");
  assert.doesNotMatch(out, / src=/, "no direct image loads");
});

test("OPML import keeps folders, skips duplicates, and exports back", () => {
  const db = openDb(tmp());
  const opml = `<?xml version="1.0"?><opml version="1.1"><body>
    <outline text="Loose" xmlUrl="https://a.example/feed" htmlUrl="https://a.example"/>
    <outline text="Tech"><outline text="B" xmlUrl="https://b.example/rss"/><outline text="C" title="C &amp; D" xmlUrl="https://c.example/atom"/></outline>
  </body></opml>`;
  const rows = parseSubscriptions(opml);
  assert.deepEqual(rows.map(r => [r.url, r.folder]), [["https://a.example/feed", null], ["https://b.example/rss", "Tech"], ["https://c.example/atom", "Tech"]]);
  assert.equal(importFeeds(db, rows).added, 3);
  assert.equal(importFeeds(db, rows).added, 0, "second import adds nothing");
  const again = parseSubscriptions(exportOpml(db));
  assert.deepEqual(again.map(r => [r.url, r.folder, r.title]).sort(), rows.map(r => [r.url, r.folder, r.title]).sort());
});

test("only one process holds the refresh lease", () => {
  const db = openDb(tmp());
  assert.equal(holdLease(db, "refresh", "p1", 60000), true);
  assert.equal(holdLease(db, "refresh", "p2", 60000), false);
  assert.equal(holdLease(db, "refresh", "p1", 60000), true, "holder renews");
  assert.equal(holdLease(db, "refresh", "p2", -1) || holdLease(db, "refresh", "p1", -1), true);
});

test("first fetch: last 7 days unread, older and undated read; 304 next time", async () => {
  const day = 86400e3, now = Date.now();
  const item = (id: string, t: number | null) => `<item><guid>${id}</guid><title>${id}</title><link>https://s.example/${id}</link>${t ? `<pubDate>${new Date(t).toUTCString()}</pubDate>` : ""}<description>&lt;p&gt;body ${id}&lt;/p&gt;</description></item>`;
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>Site</title><link>https://s.example</link>${item("new", now - day)}${item("old", now - 30 * day)}${item("undated", null)}</channel></rss>`;
  let hits = 0;
  const srv = http.createServer((q, r) => { hits++; if (q.headers["if-none-match"] === '"v1"') { r.writeHead(304).end(); return; } r.writeHead(200, { "content-type": "application/rss+xml", etag: '"v1"' }).end(rss); });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/feed`;
  const db = openDb(tmp()); importFeeds(db, [{ url, title: null, folder: null, site_url: null }]);
  const [r1] = await refreshDue(db);
  assert.equal(r1.added, 3);
  assert.deepEqual(listArticles(db, "unread").map(a => a.title), ["new"]);
  assert.equal(sidebar(db).feeds[0].title, "Site");
  const [r2] = await refreshDue(db, { all: true });
  assert.equal(r2.status, 304); assert.equal(hits, 2);
  srv.closeAllConnections(); srv.close();
});

test("clean-up deletes old read articles, keeps starred and unread, and they don't come back", async () => {
  const { pruneArticles, trimImageCache } = await import("../src/server/maintenance.ts");
  const day = 86400e3, now = Date.now();
  const item = (id: string, t: number) => `<item><guid>${id}</guid><title>${id}</title><pubDate>${new Date(t).toUTCString()}</pubDate><description>x</description></item>`;
  const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>S</title>${item("fresh", now - 2 * day)}${item("month", now - 30 * day)}${item("ancient", now - 400 * day)}</channel></rss>`;
  const srv = http.createServer((q, r) => r.writeHead(200, { "content-type": "application/rss+xml" }).end(rss));
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  const dir = tmp(); const db = openDb(dir);
  try {
  importFeeds(db, [{ url: `http://127.0.0.1:${(srv.address() as any).port}/f`, title: null, folder: null, site_url: null }]);
  await refreshDue(db);
  const titles = () => (db.prepare("SELECT title FROM articles ORDER BY title").all() as any[]).map(r => r.title);
  assert.deepEqual(titles(), ["fresh", "month"], "items older than 90 days are never stored");
  // an article fetched long ago, now 120 days old and read, and the feed still lists it
  const fid = (db.prepare("SELECT id FROM feeds").get() as any).id;
  db.prepare("INSERT INTO articles (feed_id,guid,title,published_at,read,created_at) VALUES (?,?,?,?,1,?)").run(fid, "ancient", "ancient", now - 400 * day, now - 400 * day);
  db.prepare("UPDATE articles SET read=1").run(); db.prepare("UPDATE articles SET starred=1 WHERE title='month'").run();
  assert.deepEqual(pruneArticles(db, now), { deleted: 1, stubbed: 0 });
  assert.deepEqual(titles(), ["fresh", "month"], "recent and starred articles stay");
  assert.deepEqual(pruneArticles(db, now + 200 * day), { deleted: 1, stubbed: 0 });
  assert.deepEqual(titles(), ["month"], "starred survives any age");
  await refreshDue(db, { all: true });
  assert.ok(!titles().includes("ancient"), "the deleted old article is not re-added by the next fetch");
  } finally { srv.closeAllConnections(); srv.close(); }
  // image cache cap: least recently used go first
  fs.mkdirSync(dir + "/images"); for (const [n, age] of [["a", 3], ["b", 2], ["c", 1]] as const) {
    fs.writeFileSync(`${dir}/images/${n}`, Buffer.alloc(1000)); fs.writeFileSync(`${dir}/images/${n}.json`, "{}");
    const t = new Date(now - age * day); fs.utimesSync(`${dir}/images/${n}`, t, t); }
  assert.equal(trimImageCache(dir, 2000).removed, 1);
  assert.deepEqual(fs.readdirSync(dir + "/images").sort(), ["b", "b.json", "c", "c.json"]);
});

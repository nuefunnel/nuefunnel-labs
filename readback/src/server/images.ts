// Article images and feed icons. The app's sandbox only shows images the reader already holds, so images
// travel as data: URIs. Each is fetched once, shrunk once with macOS's built-in sips if large, and cached on disk.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { parseHTML } from "linkedom";
import type { DB } from "./db.ts";
import { UA } from "./feeds.ts";

const sips = (args: string[]) => new Promise<boolean>(r => execFile("/usr/bin/sips", args, e => r(!e)));
const get = (u: string, ms = 10000) => fetch(u, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(ms) });
const isImage = (type: string, buf: Buffer) => /^image\//.test(type) && buf.length > 50 && !/^\s*</.test(buf.subarray(0, 20).toString());

export function imageCache(dataDir: string) {
  const dir = `${dataDir}/images/`; fs.mkdirSync(dir, { recursive: true });
  return async function imageData(url: string): Promise<string | null> {
    const f = dir + crypto.createHash("sha1").update(url).digest("hex");
    try { const m = JSON.parse(fs.readFileSync(f + ".json", "utf8"));
      if (!m.ok) return null;
      const buf = fs.readFileSync(f); const t = new Date(); try { fs.utimesSync(f, t, t); } catch {} // mark as recently used for the cache cap
      return `data:${m.type};base64,${buf.toString("base64")}`; } catch {}
    try {
      const r = await get(url);
      let type = (r.headers.get("content-type") || "").split(";")[0].trim(); let buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok || !isImage(type, buf)) throw new Error("not an image");
      if (buf.length > 300_000 && /jpeg|png|webp|heic|tiff/.test(type)) {
        fs.writeFileSync(f + ".src", buf);
        if (await sips(["-Z", "1600", "-s", "format", "jpeg", "-s", "formatOptions", "78", f + ".src", "--out", f + ".jpg"])) { buf = fs.readFileSync(f + ".jpg"); type = "image/jpeg"; fs.rmSync(f + ".jpg"); }
        fs.rmSync(f + ".src", { force: true });
      }
      if (buf.length > 4_000_000) throw new Error("too large");
      fs.writeFileSync(f, buf); fs.writeFileSync(f + ".json", JSON.stringify({ ok: 1, type, url }));
      return `data:${type};base64,${buf.toString("base64")}`;
    } catch { fs.writeFileSync(f + ".json", JSON.stringify({ ok: 0, url, at: Date.now() })); return null; }
  };
}

// Feed icons: the site's declared icon closest to 64px, else /favicon.ico; stored as a 64px PNG data: URI.
export async function findIcon(siteUrl: string, tmpDir: string): Promise<string | null> {
  const r = await get(siteUrl, 8000); const base = r.url; const html = await r.text();
  const { document } = parseHTML(html);
  const links = [...document.querySelectorAll("link[rel]")].filter((l: any) => /icon/i.test(l.getAttribute("rel")));
  const score = (l: any) => { const rel = l.getAttribute("rel").toLowerCase(), t = l.getAttribute("type") || "";
    let n = parseInt(l.getAttribute("sizes") || "") || 0; if (rel.includes("apple-touch")) n = Math.max(n, 180); if (t.includes("svg")) n = Math.max(n, 64); return -Math.abs((n || 32) - 64); };
  const candidates = [...links.sort((a: any, b: any) => score(b) - score(a)).map((l: any) => new URL(l.getAttribute("href"), base).href), new URL("/favicon.ico", base).href];
  for (const u of candidates) {
    try {
      const ir = await get(u, 8000); const buf = Buffer.from(await ir.arrayBuffer()); const type = (ir.headers.get("content-type") || "").split(";")[0];
      if (!ir.ok || !(isImage(type, buf) || /octet|icon/.test(type))) continue;
      const src = `${tmpDir}/icon-${process.pid}-${Date.now()}`, out = src + ".png";
      fs.writeFileSync(src, buf);
      const ok = await sips(["-s", "format", "png", "-Z", "64", src, "--out", out]);
      fs.rmSync(src, { force: true });
      if (!ok) continue;
      const png = fs.readFileSync(out); fs.rmSync(out, { force: true });
      if (png.length > 40_000) continue;
      return `data:image/png;base64,${png.toString("base64")}`;
    } catch {}
  }
  return null;
}

export async function refreshIcons(db: DB, tmpDir: string, limit = 40) {
  const weekAgo = Date.now() - 7 * 86400e3;
  const rows = db.prepare("SELECT id, url, site_url FROM feeds WHERE icon IS NULL AND (icon_checked_at IS NULL OR icon_checked_at < ?) LIMIT ?").all(weekAgo, limit) as any[];
  let i = 0, found = 0;
  await Promise.all(Array.from({ length: 4 }, async () => { while (i < rows.length) { const f = rows[i++];
    let icon: string | null = null;
    try { icon = await findIcon(f.site_url || new URL(f.url).origin, tmpDir); } catch {}
    if (icon) found++;
    db.prepare("UPDATE feeds SET icon=?, icon_checked_at=? WHERE id=?").run(icon, Date.now(), f.id);
  } }));
  return { checked: rows.length, found };
}

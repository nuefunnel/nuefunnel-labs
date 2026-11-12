// Clean feed HTML once, when an article is stored. Scripts, frames, forms, styles and event handlers go;
// links become absolute; images keep their address in data-img so the reader can fetch them through the
// app (the app's sandbox blocks direct image loads from other sites).
import { parseHTML } from "linkedom";

const DROP = "script,iframe,frame,frameset,object,embed,form,input,button,select,textarea,style,link,meta,base,noscript,svg,canvas,video,audio,source,template";
const DROP_ATTR = /^(on|style$|class$|id$|srcset$|sizes$|data-(?!img$))/i;

const abs = (u: string, base: string) => { try { return new URL(u, base).href; } catch { return ""; } };

export function sanitize(html: string, base: string): string {
  if (!html) return "";
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body;
  body.querySelectorAll(DROP).forEach((e: any) => e.remove());
  for (const el of body.querySelectorAll("*") as any) {
    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const src = el.getAttribute("src") || el.getAttribute("data-src") || el.getAttribute("data-original") || "";
      const w = +(el.getAttribute("width") || 0), h = +(el.getAttribute("height") || 0);
      const url = src.startsWith("data:") ? "" : abs(src, base);
      if (!url || (w && w <= 2) || (h && h <= 2)) { el.remove(); continue; } // tracking pixels and broken images
      el.removeAttribute("src"); el.setAttribute("data-img", url); el.setAttribute("loading", "lazy");
    }
    for (const a of [...el.attributes]) if (DROP_ATTR.test(a.name)) el.removeAttribute(a.name);
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && /^\s*(javascript|data|vbscript):/i.test(href)) el.removeAttribute("href");
      else if (href) el.setAttribute("href", abs(href, base));
    }
  }
  return body.innerHTML.replace(/<!--[\s\S]*?-->/g, "");
}

export const strip = (s: string) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"').replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();

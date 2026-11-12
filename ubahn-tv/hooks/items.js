// What every adapter produces, and the rules that apply to items whatever
// their feed: identity, validity, when a feed is due again, and how feeds mix.
//
// An item:
//   { id, title, kind: 'video' | 'image', mediaUrl, ext, durationS,
//     validFrom, validUntil, link, linkTitle, feed }
// feed: { url, key, adapter, title, label, city, credit, ttlMin }

const HOUR_MS = 60 * 60 * 1000
const MIN_TTL_MIN = 5
export const DEFAULT_IMAGE_S = 10

// A short stable hash (cyrb53), safe as a folder name
export function hashKey(str) {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

const EXTS = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }

// The file extension a downloaded clip is saved under: from the type, else the URL
export function extOf(mediaUrl, type) {
  if (type && EXTS[type.toLowerCase()]) return EXTS[type.toLowerCase()]
  const m = String(mediaUrl).match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i)
  return m ? m[1].toLowerCase() : 'bin'
}

// Expired, or not shown yet
export function isExpired(item, now) {
  return (Number.isFinite(item.validUntil) && item.validUntil <= now) || (Number.isFinite(item.validFrom) && item.validFrom > now)
}

// A feed is due again after its ttl (an hour unless it says, never under five
// minutes however short it asks), or on a new day
export function isStale(fetchedAt, now, ttlMin) {
  if (!fetchedAt) return true
  const maxAgeMs = ttlMin > 0 ? Math.max(MIN_TTL_MIN, ttlMin) * 60 * 1000 : HOUR_MS
  return new Date(fetchedAt).toDateString() !== new Date(now).toDateString() || now - fetchedAt > maxAgeMs
}

// Interleave feeds item by item (A1 B1 A2 B2 …), so a long feed can't drown a short one
export function mix(lists) {
  const out = []
  const longest = Math.max(0, ...lists.map((l) => l.length))
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i])
  return out
}

// Fills in what every item needs from the adapter's raw fields
export function finishItem(raw, feed) {
  return {
    id: hashKey(`${feed.url}\n${raw.guid || raw.mediaUrl}`),
    title: raw.title || '',
    kind: raw.kind,
    mediaUrl: raw.mediaUrl,
    ext: extOf(raw.mediaUrl, raw.type),
    durationS: raw.durationS > 0 ? raw.durationS : DEFAULT_IMAGE_S,
    validFrom: raw.validFrom ?? NaN,
    validUntil: raw.validUntil ?? NaN,
    link: raw.link || '',
    linkTitle: raw.linkTitle || '',
    feed,
  }
}

// Media RSS: an RSS 2.0 feed whose items carry media:content (or an enclosure).
// Only items with an image or a video are kept; the rest are skipped.

import { child, childrenNamed, parseXml, textOf } from '../xml.js'

const MEDIA = ['http://search.yahoo.com/mrss/', 'http://search.yahoo.com/mrss']
const DCTERMS = 'http://purl.org/dc/terms/'
const MAX_WIDTH = 1920

export const name = 'mrss'

const media = (local) => MEDIA.map((ns) => `{${ns}}${local}`)
const isMedia = (el, local) => media(local).includes(el.name)

const VIDEO_EXT = /\.(mp4|m4v|webm|mov)(?:[?#]|$)/i
const IMAGE_EXT = /\.(jpe?g|png|gif|webp)(?:[?#]|$)/i

// 'video', 'image' or null, from medium, then type, then the URL
function kindOf(el) {
  const medium = (el.attrs.medium || '').toLowerCase()
  if (medium === 'video' || medium === 'image') return medium
  const type = (el.attrs.type || '').toLowerCase()
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('image/')) return 'image'
  if (medium || type) return null
  const url = el.attrs.url || ''
  if (VIDEO_EXT.test(url)) return 'video'
  if (IMAGE_EXT.test(url)) return 'image'
  return null
}

// Every media:content and enclosure of an item, media:group's included
function candidates(item) {
  const out = []
  const visit = (el) => {
    for (const c of el.children) {
      if (isMedia(c, 'content') || c.name === 'enclosure') {
        const kind = kindOf(c)
        if (kind && c.attrs.url) out.push({ el: c, kind, width: Number(c.attrs.width) || 0 })
      } else if (isMedia(c, 'group')) visit(c)
    }
  }
  visit(item)
  return out
}

// How good a size is: the largest up to MAX_WIDTH, then an unknown width,
// then the smallest above it
const sizeRank = (w) => (!w ? 0 : w <= MAX_WIDTH ? 1e6 + w : -w)

// Video over image, media:content over an enclosure, then the best size
export function pickMedia(list) {
  if (!list.length) return null
  const kind = list.some((c) => c.kind === 'video') ? 'video' : 'image'
  const same = list.filter((c) => c.kind === kind)
  const isContent = (c) => (c.el.name === 'enclosure' ? 0 : 1)
  const best = same.sort((a, b) => isContent(b) - isContent(a) || sizeRank(b.width) - sizeRank(a.width))[0]
  // An enclosure and a media:content for the same file: take the duration either gives
  const durationS = Math.max(0, ...list.filter((c) => c.el.attrs.url === best.el.attrs.url).map((c) => Number(c.el.attrs.duration) || 0))
  return { ...best, durationS }
}

// "start=2026-10-01T00:00Z; end=2026-10-19T23:59+02:00; scheme=W3C-DTF"
export function parseValid(text) {
  const out = {}
  for (const part of String(text).split(';')) {
    const [k, v] = part.split('=').map((s) => s?.trim())
    if ((k === 'start' || k === 'end') && v) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) out[k] = t
    }
  }
  return { validFrom: out.start, validUntil: out.end }
}

export function parse(text) {
  const root = parseXml(text)
  const channel = root.name === 'rss' ? child(root, 'channel') : null
  if (!channel) throw new Error(`not an RSS feed (root <${root.qname}>)`)
  const items = []
  let skipped = 0
  for (const item of childrenNamed(channel, 'item')) {
    const picked = pickMedia(candidates(item))
    if (!picked) {
      skipped += 1
      continue
    }
    const titleEl = item.children.find((c) => isMedia(c, 'title')) ?? picked.el.children.find((c) => isMedia(c, 'title'))
    const valid = item.children.find((c) => c.name === `{${DCTERMS}}valid`)
    items.push({
      guid: textOf(item, 'guid'),
      title: textOf(item, 'title') || (titleEl ? textOf(titleEl) : ''),
      kind: picked.kind,
      mediaUrl: picked.el.attrs.url,
      type: picked.el.attrs.type,
      durationS: picked.durationS,
      link: textOf(item, 'link'),
      ...(valid ? parseValid(valid.text) : {}),
    })
  }
  return {
    title: textOf(channel, 'title'),
    link: textOf(channel, 'link'),
    ttlMin: Number(textOf(channel, 'ttl')) || 0,
    items,
    skipped,
  }
}

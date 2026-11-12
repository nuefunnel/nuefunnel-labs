// Which adapter reads a feed URL, and loading one feed into items. Only the
// adapters know a source's format; everything past loadFeed sees items.

import { finishItem, hashKey, isExpired } from '../items.js'
import * as mrss from './mrss.js'
import * as regiofokus from './regiofokus.js'

// Checked in order; MRSS reads anything else
const ADAPTERS = [regiofokus]

export function adapterFor(url) {
  return ADAPTERS.find((a) => a.matches(url)) ?? mrss
}

// The pane's look when no adapter brings its own, or the feeds' adapters differ
export const NEUTRAL_THEME = { name: 'neutral', lang: 'en', accent: undefined, icon: '📺' }

// One look for the whole loop, so a mixed loop never switches it clip by clip:
// an adapter's theme only when every feed uses that adapter
export function themeFor(urls) {
  const adapters = new Set(urls.map(adapterFor))
  const [only] = adapters
  return adapters.size === 1 && only.theme ? only.theme : NEUTRAL_THEME
}

// The feeds setting: URLs separated by spaces, commas or new lines
export function parseFeedList(setting) {
  const urls = String(setting ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => /^https?:\/\//i.test(s))
  return [...new Set(urls)]
}

export function hostOf(url) {
  return url.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.replace(/^www\./, '') ?? url
}

// Fetches and parses one feed. Resolves { feed, items, skipped, text }, text
// being the answer as it came, to keep; rejects with a message naming what
// went wrong.
export async function loadFeed(host, url, now) {
  const adapter = adapterFor(url)
  const res = await host.fetch(adapter.fetchUrl ? adapter.fetchUrl(url, now) : url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { ...parseFeed(url, res.text, now), text: res.text }
}

// Reads one feed's text, fresh or kept from an earlier fetch, into items:
// { feed, items, skipped }. Throws when the adapter can't read it.
export function parseFeed(url, text, now) {
  const adapter = adapterFor(url)
  const parsed = adapter.parse(text, url)
  const feed = {
    url,
    key: hashKey(url),
    adapter: adapter.name,
    title: parsed.title || hostOf(url),
    label: parsed.label || '',
    city: parsed.city || '',
    credit: parsed.credit || hostOf(parsed.link || url),
    ttlMin: parsed.ttlMin || 0,
  }
  const seen = new Set()
  const items = parsed.items
    .map((raw) => finishItem(raw, feed))
    .filter((item) => !isExpired(item, now) && !seen.has(item.id) && seen.add(item.id))
  return { feed, items, skipped: parsed.skipped + parsed.items.length - items.length }
}

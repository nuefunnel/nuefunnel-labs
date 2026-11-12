// regiofokus.de passenger TV: a network's playlist.json, as its web player
// reads it (https://regiofokus.de/player.php?site=NBG_MET). Each entry is a
// finished clip or image; the filter and titles match the website's.

// The networks regiofokus.de publishes, by playlist code
export const NETWORKS = {
  NBG_MET: { label: 'U-BAHN TV', city: 'NÜRNBERG' },
  AUG_BUS: { label: 'FAHRGAST-TV', city: 'AUGSBURG' },
  BYU_BUS: { label: 'FAHRGAST-TV', city: 'BAYREUTH' },
  ANS_BUS: { label: 'FAHRGAST-TV', city: 'ANSBACH' },
  ANS_BRC: { label: 'BRÜCKEN-CENTER', city: 'ANSBACH' },
  ULM_BUS: { label: 'FAHRGAST-TV', city: 'ULM' },
  ULM_TRA: { label: 'STRASSENBAHN-TV', city: 'ULM' },
}

const URL_RE = /^https?:\/\/(?:www\.)?regiofokus\.de\/content\/([A-Za-z0-9_]+)\/playlist\.json/

export const name = 'regiofokus'

// How the pane looks while it plays only regiofokus feeds: like the screens on board
export const theme = { name: 'ubahn', lang: 'de', accent: '#e30613', icon: '🚇' }

export function matches(url) {
  return URL_RE.test(url)
}

// The site's own cache-buster, so a fresh list arrives every time
export function fetchUrl(url, now) {
  return `${url.split('?')[0]}?timestamp=${now}`
}

// The same filter the website applies in player.php
export function keep(entry) {
  return typeof entry.Source === 'string' && !entry.Source.endsWith('mvp') && !entry.Source.toLowerCase().startsWith('vgn')
}

// "8775_Quiz_name_Tristanstrasse" -> "Quiz name Tristanstrasse"
export function prettyName(entry) {
  return String(entry.Name ?? entry.Source).replace(/^\d+_/, '').replace(/_/g, ' ')
}

export function parse(text, url) {
  const entries = JSON.parse(text)
  if (!Array.isArray(entries)) throw new Error('playlist.json is not a list')
  const base = url.split('?')[0].replace(/[^/]*$/, '')
  const code = url.match(URL_RE)?.[1]
  const network = NETWORKS[code] ?? { label: 'FAHRGAST-TV', city: code ?? '' }
  const kept = entries.filter(keep)
  return {
    title: `${network.label} · ${network.city}`,
    label: network.label,
    city: network.city,
    credit: 'regiofokus.de',
    link: `https://regiofokus.de/player.php?site=${code}`,
    ttlMin: 0,
    skipped: entries.length - kept.length,
    items: kept.map((e) => ({
      guid: e.Id,
      title: prettyName(e),
      kind: String(e.Type).toLowerCase() === 'video' ? 'video' : 'image',
      mediaUrl: base + encodeURIComponent(e.Source),
      durationS: Number(e.Length) || 0,
      // Local time, like the website reads it
      validUntil: Date.parse(e.Expires),
      link: e.Url || '',
      linkTitle: e.LinkTitle || '',
    })),
  }
}

// U-Bahn TV: plays feeds of clips and images in a pane while Claude works,
// by default Podsumo's episode cards mixed with the passenger-TV rotation of
// Nuremberg's U-Bahn (regiofokus.de).
// It opens by itself when a turn runs longer than the configured delay and
// closes when the turn completes; /ubahn opens or closes it by hand.
//
// Feeds are read by adapters (hooks/adapters/) into items; several feeds play
// mixed into one loop. The terminal plays PNG frames at the playback rate by
// blitting a keyed Image. The Desktop app has no Image, so it gets a slideshow
// instead: JPEG stills at a few a second inside an Svg, each one carried by a
// redraw of its own.

import { hostOf, loadFeed, parseFeed, parseFeedList, themeFor } from './adapters/index.js'
import { hashKey, isExpired, isStale, mix } from './items.js'
import { createCache, findTool } from './media.js'
import { MAX_LAG_MS, TIMINGS, step } from './player.js'

const PANE = 'ubahn-tv'
const PANE_COLUMNS = 84
const DEFAULT_FEEDS = 'https://podsumo.io/mrss/_IMSyPwN0vwnkpQH-69kKw https://regiofokus.de/content/NBG_MET/playlist.json'
// Each Desktop still needs a redraw, and Claude Code folds redraws past ten a second
const MAX_STILLS_FPS = 10
// Skip a clip that still isn't decoded after this long
const READY_TIMEOUT_MS = 20_000
// A feed that failed is tried again after this many minutes
const RETRY_MIN = 5

// What the pane says, in the theme's language
const WORDS = {
  en: {
    upNext: 'Up next: ',
    coming: (title) => `Coming up: ${title} …`,
    loading: 'Loading feeds …',
    more: 'more',
    credit: (source) => `From ${source} · /ubahn closes`,
    unreachable: 'Feeds unreachable: ',
    missing: (tools) => `Missing: ${tools}. Install with: brew install ${tools.replace(/, /g, ' ')}`,
    noFeeds: 'No feeds set: /plugin configure ubahn-tv@nuefunnel-labs',
    picture: 'Picture: ',
    tmux: 'No pictures in tmux. Start claude directly in Ghostty or kitty to see them.',
    surface: 'Pictures show only in the terminal and the Desktop app.',
    toastNarrow: 'playing – /ubahn shows it (window too narrow)',
    toastTmux: 'No pictures in tmux – start claude directly in Ghostty',
    toastMissing: (tools) => `Missing: ${tools} – brew install ${tools.replace(/, /g, ' ')}`,
    locale: 'en-GB',
  },
  de: {
    upNext: 'Als nächstes: ',
    coming: (title) => `Nächster Halt: ${title} …`,
    loading: 'Lade Fahrplan …',
    more: 'mehr erfahren',
    credit: (source) => `Inhalte: ${source} · /ubahn schließt`,
    unreachable: 'Fahrplan nicht erreichbar: ',
    missing: (tools) => `Fehlt: ${tools}. Installiere mit: brew install ${tools.replace(/, /g, ' ')}`,
    noFeeds: 'Keine Feeds eingestellt: /plugin configure ubahn-tv@nuefunnel-labs',
    picture: 'Bild: ',
    tmux: 'Keine Bilder in tmux. Starte claude direkt in Ghostty oder kitty, um das Video zu sehen.',
    surface: 'U-Bahn TV zeigt Bilder nur im Terminal und in der Desktop-App.',
    toastNarrow: 'läuft – /ubahn zum Anzeigen (Fenster zu schmal)',
    toastTmux: 'Keine Bilder in tmux – starte claude direkt in Ghostty',
    toastMissing: (tools) => `Fehlt: ${tools} – brew install ${tools.replace(/, /g, ' ')}`,
    locale: 'de-DE',
  },
}

// Settings, from the plugin's userConfig
let feedUrls = []
// The pane's look for these feeds, and its words
let theme = themeFor([])
let words = WORDS.en
let feedsKey = ''
let delayMs = 10_000
let fps = 12
let stillsFps = 10
let timing = 'hybrid'
let isVerbose = false

// Closures over the mods API, built in session.start (a hook can't keep $ itself)
let host = null
let cache = null
let isTmux = false
let toolsMissing = []
// Which kinds of frame the attached surfaces draw: a terminal draws frames,
// the Desktop app stills. Nothing is decoded for a surface that isn't there.
let drawsFrames = false
let drawsStills = false
// The still last read for the Svg, so a redraw on the same second reads nothing
let lastStill = { key: '', base64: '' }

// Each feed's latest copy, by URL: { feed, items, fetchedAt, error, fromDisk }
const feeds = new Map()
// Fetches in flight, by URL, so a feed is never fetched twice at once
const pending = new Map()
// The position saved by the last session, until the first list arrives
let savedId = null
let playlist = []
let idx = 0
// The clip on screen when a refresh dropped it from its feed: it plays to its
// end, then leaves the loop
let holdover = null
const failed = new Set()
let ticker = null
let armTimer = null
let isOpen = false
let openedBy = null
let status = ''
let hasHinted = false
let tickBusy = false
// The clip on screen: its clock and the stats logged when it ends
let clip = null
let elapsedMs = 0
let waitingSince = 0

const current = () => playlist[idx]
const upcoming = (k = 1) => playlist[(idx + k) % playlist.length]
const redraw = () => host.invalidate()
const log = (line) => host.log('ubahn ' + line)
const verbose = (line) => isVerbose && log(line)

// The clip's clock runs on frames when a terminal draws them, else on stills
const clockKind = () => (drawsFrames ? 'frames' : 'stills')
const clockFps = () => (drawsFrames ? fps : stillsFps)
const kinds = () => [drawsFrames && 'frames', drawsStills && 'stills'].filter(Boolean)
const isVideo = (item) => item.kind === 'video'

// A feed's name for the header: "U-BAHN TV · NÜRNBERG", or the feed's own title
const feedLabel = (feed) => (feed ? (feed.label ? [feed.label, feed.city].filter(Boolean).join(' · ') : feed.title) : 'U-BAHN TV')

// How long a clip runs: its frames at their rate, or its duration for a still image
function clipMs(item) {
  return isVideo(item) ? (cache.frameCount(item, clockKind()) * 1000) / clockFps() : Math.max(1, item.durationS) * 1000
}

// Read which surfaces draw the session; when that changes, prepare and play
// the kinds of frame they need
async function refreshSurfaces() {
  const surfaces = await host.surfaces()
  const frames = surfaces.includes('terminal')
  const stills = surfaces.includes('desktop')
  if (frames === drawsFrames && stills === drawsStills) return
  drawsFrames = frames
  drawsStills = stills
  log(`surfaces ${surfaces.join(',') || '-'} kinds=${kinds().join(',') || '-'}`)
  prefetch()
  if (isOpen) startTicker()
}

function startTicker() {
  ticker?.cancel()
  ticker = host.every(Math.round(1000 / clockFps()), tick)
}

function isPlayable(item, now) {
  return item && !failed.has(item.id) && !isExpired(item, now)
}

// Mix the feeds' latest copies into the loop, keeping the clip on screen (or
// the saved one) as the position. A clip on screen that its feed no longer
// lists stays where it was until it ends.
function rebuild() {
  const prev = current()
  const prevIdx = idx
  const keepId = prev?.id ?? savedId
  playlist = mix(feedUrls.map((url) => feeds.get(url)?.items ?? []))
  idx = playlist.findIndex((s) => s.id === keepId)
  holdover = null
  if (idx < 0 && prev && clip?.id === prev.id) {
    idx = Math.min(prevIdx, playlist.length)
    playlist.splice(idx, 0, prev)
    holdover = prev
  }
  idx = Math.max(0, idx)
  if (playlist.length) savedId = null
}

// Why nothing plays, when every feed failed and none has a copy to fall back on
function unreachableText() {
  if (playlist.length || !feedUrls.length || !feedUrls.every((url) => feeds.get(url)?.error)) return ''
  return words.unreachable + feedUrls.map((url) => `${hostOf(url)}: ${feeds.get(url).error}`).join('; ')
}

// Fetch one feed, or join the fetch already under way; a feed that fails
// keeps playing the copy we have
function loadOne(url) {
  if (!pending.has(url)) pending.set(url, fetchOne(url).finally(() => pending.delete(url)))
  return pending.get(url)
}

async function fetchOne(url) {
  const now = await host.now()
  const prev = feeds.get(url)
  try {
    const { feed, items, skipped, text } = await loadFeed(host, url, now)
    feeds.set(url, { feed, items, fetchedAt: now, error: '', fromDisk: false })
    log(`feed url=${url} adapter=${feed.adapter} key=${feed.key} count=${items.length} skipped=${skipped}`)
    cache.saveFeed(feed, { url, fetchedAt: now, text })
    cache.cleanup(feed, items)
  } catch (err) {
    feeds.set(url, { feed: prev?.feed ?? null, items: prev?.items ?? [], fetchedAt: now, error: err.message, fromDisk: prev?.fromDisk ?? false })
    log(`feed error url=${url} error="${err.message}" keeping=${prev?.items.length ?? 0}`)
  }
  rebuild()
  log(`playlist feeds=${feedUrls.length} count=${playlist.length} at=${idx + 1}`)
  prefetch()
  redraw()
}

// Fetch these feeds in the background: nothing waits, and each joins the loop
// as it arrives (a dead feed takes up to $.http.fetch's 30 s to give up)
function refresh(urls) {
  for (const url of urls) loadOne(url)
}

// A feed is due when it has no copy, its ttl ran out, or 5 minutes after it
// failed; never while a fetch of it is under way
function isFeedStale(url, now) {
  if (pending.has(url)) return false
  const state = feeds.get(url)
  if (!state) return true
  return isStale(state.fetchedAt, now, state.error ? RETRY_MIN : state.feed?.ttlMin)
}

async function refreshDue() {
  const now = await host.now()
  refresh(feedUrls.filter((url) => isFeedStale(url, now)))
}

// Each feed's last good answer from disk, so the loop starts before the
// network answers, or plays on without it. Expired items drop out here, and
// their clips go with them.
async function restoreFeeds() {
  const now = await host.now()
  for (const url of feedUrls) {
    const saved = await cache.readFeed(hashKey(url))
    if (!saved || saved.url !== url) continue
    try {
      const { feed, items } = parseFeed(url, saved.text, now)
      feeds.set(url, { feed, items, fetchedAt: saved.fetchedAt, error: '', fromDisk: true })
      log(`feed restored url=${url} key=${feed.key} count=${items.length} ageMin=${Math.round((now - saved.fetchedAt) / 60000)}`)
      cache.cleanup(feed, items)
    } catch (err) {
      log(`feed restore error url=${url} error="${err.message}"`)
    }
  }
  rebuild()
  prefetch()
}

// Download and decode the current clip and the two after it, in each kind drawn
function prefetch() {
  if (!playlist.length || toolsMissing.length) return
  const wanted = [current(), upcoming(1), upcoming(2)].filter((s) => !failed.has(s.id))
  for (const item of wanted) {
    for (const kind of kinds()) {
      cache
        .prepare(item, kind)
        .then(() => item === current() && redraw())
        .catch((err) => {
          if (failed.has(item.id)) return
          failed.add(item.id)
          log(`prepare error id=${item.id} kind=${kind} source=${item.mediaUrl} error="${err.message}"`)
          if (item === current() && isOpen) advance('failed')
        })
    }
  }
  cache.evict([current(), upcoming(1), upcoming(2)].map((s) => s.id))
}

function startClip(item, now) {
  clip = { id: item.id, startedAt: now, lastTickAt: now, ticks: 0, shown: 0, skipped: 0, maxGap: 0, sumGap: 0, lastSecond: 0, lastStill: 0 }
  elapsedMs = 0
  waitingSince = 0
  cache.touch(item, kinds())
  log(
    `clip-start n=${idx + 1}/${playlist.length} id=${item.id} feed=${item.feed.key} name="${item.title}" type=${item.kind} ` +
      `clock=${clockKind()} frames=${cache.frameCount(item, clockKind())} expectedMs=${Math.round(clipMs(item))} timing=${timing}`,
  )
}

function endClip(item, now, reason) {
  const actual = now - clip.startedAt
  const expected = clipMs(item)
  log(
    `clip-end id=${item.id} reason=${reason} expectedMs=${Math.round(expected)} actualMs=${actual} ` +
      `driftMs=${Math.round(actual - expected)} ticks=${clip.ticks} ` +
      `ticksPerSec=${((clip.ticks / Math.max(actual, 1)) * 1000).toFixed(2)} ` +
      `avgGapMs=${(clip.sumGap / Math.max(clip.ticks, 1)).toFixed(1)} maxGapMs=${clip.maxGap} ` +
      `lastFrame=${clip.shown} skipped=${clip.skipped}`,
  )
  clip = null
}

// Move to the next clip that hasn't expired or failed
async function advance(reason) {
  const now = await host.now()
  const item = current()
  if (item && clip?.id === item.id) endClip(item, now, reason)
  clip = null
  elapsedMs = 0
  waitingSince = 0
  // A clip its feed dropped leaves the loop now it has ended; the clip after
  // it moves into its place, so step back one to land on that
  if (holdover && item?.id === holdover.id) {
    playlist.splice(idx, 1)
    holdover = null
    idx -= 1
  }
  for (let i = 0; i < playlist.length; i++) {
    idx = (idx + 1) % playlist.length
    // Like the website, fetch the lists again each time the loop wraps
    if (idx === 0) refresh(feedUrls)
    if (isPlayable(current(), now)) break
    log(`skip id=${current()?.id} reason=${failed.has(current()?.id) ? 'failed' : 'expired'}`)
  }
  idx = Math.max(0, idx)
  refreshDue()
  if (current()) host.storeSet(`position:${feedsKey}`, current().id)
  prefetch()
  redraw()
}

function blit(item, frame) {
  if (isTmux || !drawsFrames) return
  const sentAt = Date.now()
  host
    .blit({ requestId: PANE, key: 'screen', source: { file: cache.framePath(item, frame), format: 'png' } })
    .then((r) => {
      if (r?.deny) {
        log(`blit frame=${frame} deny="${r.deny}"`)
        if (status !== words.picture + r.deny) {
          status = words.picture + r.deny
          redraw()
        }
      } else {
        verbose(`blit frame=${frame} ms=${Date.now() - sentAt}`)
      }
    })
}

async function tick() {
  if (tickBusy) return log('tick overlap: previous tick still running')
  tickBusy = true
  try {
    const now = await host.now()
    const item = current()
    if (!item) return
    const frames = cache.frameCount(item, clockKind())
    // A clip's clock starts once its frames are decoded
    if (frames === 0) {
      waitingSince ||= now
      if (now - waitingSince > READY_TIMEOUT_MS) {
        log(`skip id=${item.id} reason=not-ready waitedMs=${now - waitingSince}`)
        failed.add(item.id)
        await advance('not-ready')
      }
      return
    }
    if (!clip || clip.id !== item.id) startClip(item, now)

    const gap = now - clip.lastTickAt
    clip.lastTickAt = now
    clip.ticks += 1
    clip.sumGap += gap
    clip.maxGap = Math.max(clip.maxGap, gap)
    elapsedMs = now - clip.startedAt

    const r = step({ timing, shown: clip.shown, elapsedMs, fps: clockFps(), frames: isVideo(item) ? frames : 1, durationMs: clipMs(item) })
    verbose(`tick gapMs=${gap} tick=${clip.ticks} elapsedMs=${elapsedMs} frame=${r.frame} skipped=${r.skipped}`)
    if (r.isOver) {
      await advance('end')
      return
    }
    if (r.frame !== clip.shown) {
      clip.skipped += r.skipped
      clip.shown = r.frame
      blit(item, r.frame)
    }
    // Redraw once a second for the progress bar and clock, and on desktop for
    // each new still: an Svg has no blit, so a redraw is how a still changes
    const second = Math.floor(elapsedMs / 1000)
    const still = drawsStills ? Math.floor((elapsedMs * stillsFps) / 1000) : 0
    if (second !== clip.lastSecond || still !== clip.lastStill) {
      clip.lastSecond = second
      clip.lastStill = still
      redraw()
    }
  } finally {
    tickBusy = false
  }
}

async function openPane(by) {
  if (isOpen) return
  await refreshSurfaces()
  // Opens with what there is: clips that arrive later join the loop, and until
  // the first one does, the pane says the feeds are loading
  refreshDue()
  const placed = await host.open({ id: PANE, title: feedLabel(current()?.feed), columns: PANE_COLUMNS })
  log(`open by=${by} placed=${placed?.isPlaced ?? 'unknown'}${placed?.reason ? ` reason="${placed.reason}"` : ''}`)
  if (placed && placed.isPlaced === false) {
    host.toast(`${theme.icon} U-Bahn TV ${words.toastNarrow}`)
    return
  }
  isOpen = true
  openedBy = by
  if (!hasHinted && (isTmux || toolsMissing.length)) {
    hasHinted = true
    host.toast(`${theme.icon} ${isTmux ? words.toastTmux : words.toastMissing(toolsMissing.join(', '))}`)
  }
  // A paused clip resumes where it stopped: its clock moves past the pause
  if (clip) {
    const now = await host.now()
    clip.startedAt = now - elapsedMs
    clip.lastTickAt = now
  }
  prefetch()
  startTicker()
}

async function closePane(reason) {
  ticker?.cancel()
  ticker = null
  log(`close reason=${reason} clip=${current()?.id ?? '-'} elapsedMs=${Math.round(elapsedMs)}`)
  if (isOpen) await host.close({ id: PANE })
  isOpen = false
}

// The still due now, as an Svg's markup: the JPEG travels inside it as a data
// URI. Null when the clip has no stills yet or the file is gone.
async function stillSvg(item) {
  const count = cache.frameCount(item, 'stills')
  if (count === 0) return null
  const due = clip?.id === item.id && isVideo(item) ? Math.floor((elapsedMs * stillsFps) / 1000) : 0
  const i = Math.min(due, count - 1)
  const key = `${item.id}/${i}`
  if (lastStill.key !== key) {
    try {
      lastStill = { key, base64: await cache.readBase64(item, i) }
    } catch (err) {
      log(`still error id=${item.id} frame=${i} error="${err.message}"`)
      return null
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">` +
    `<rect width="640" height="360" fill="#000"/>` +
    `<image href="data:image/jpeg;base64,${lastStill.base64}" width="640" height="360"/>` +
    `</svg>`
  )
}

// What the screen says while there is no picture yet
function waitingText(item) {
  if (toolsMissing.length) return words.missing(toolsMissing.join(', '))
  if (!feedUrls.length) return words.noFeeds
  return item ? words.coming(item.title) : words.loading
}

function progressBar(width, done, total) {
  const filled = total > 0 ? Math.round((width * Math.min(done, total)) / total) : 0
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

function clockText() {
  return new Date().toLocaleTimeString(words.locale, { hour: '2-digit', minute: '2-digit' })
}

function feedLines(now) {
  return feedUrls.map((url) => {
    const state = feeds.get(url)
    const fetching = pending.has(url) ? ' · fetching …' : ''
    if (!state) return `  ${url}\n    not loaded yet${fetching}`
    const ago = Math.round((now - state.fetchedAt) / 60000)
    const what = state.feed ? `${state.feed.adapter} · ${feedLabel(state.feed)} · ${state.items.length} clips` : 'no copy'
    const source = state.fromDisk ? 'from disk, fetched' : 'fetched'
    return `  ${url}\n    ${what} · ${source} ${ago} min ago${state.error ? ` · error: ${state.error}` : ''}${fetching}`
  })
}

async function statusText() {
  const item = current()
  return [
    `U-Bahn TV · ${feedUrls.length} feed${feedUrls.length === 1 ? '' : 's'} · theme ${theme.name}`,
    ...feedLines(await host.now()),
    `timing=${timing} fps=${fps} delay=${delayMs / 1000}s pane=${isOpen ? `open (${openedBy})` : 'closed'}`,
    item ? `clip ${idx + 1}/${playlist.length}: ${item.title} (${feedLabel(item.feed)})` : 'no playlist yet',
    `draws: ${[drawsFrames && `terminal (frames at ${fps} fps)`, drawsStills && `desktop (stills at ${stillsFps} fps)`].filter(Boolean).join(', ') || 'nothing'}`,
    `cache: ${cache.root}`,
    isTmux ? 'tmux: pictures off (start claude outside tmux)' : 'tmux: no',
    toolsMissing.length ? `missing: ${toolsMissing.join(', ')}` : 'tools: curl, ffmpeg found',
    failed.size ? `skipped this session: ${failed.size}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

// A setting left blank, or one that isn't a number, gets its default
const numberOr = (value, fallback) => {
  const n = value === '' || value === null || value === undefined ? NaN : Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function register(on, options = {}) {
  // A blank feeds setting, or one with no web address in it, plays the default feeds
  const chosen = parseFeedList(options.feeds)
  feedUrls = chosen.length ? chosen : parseFeedList(DEFAULT_FEEDS)
  feedsKey = hashKey(feedUrls.join('\n'))
  theme = themeFor(feedUrls)
  words = WORDS[theme.lang] ?? WORDS.en
  delayMs = Math.max(0, numberOr(options.auto_open_delay_seconds, 10)) * 1000
  fps = Math.min(30, Math.max(4, numberOr(options.fps, 12)))
  stillsFps = Math.min(MAX_STILLS_FPS, Math.max(1, Math.round(numberOr(options.desktop_fps, 10))))
  timing = TIMINGS.includes(options.timing) ? options.timing : 'hybrid'
  isVerbose = options.verbose_log === true

  on('session.start', async ($, e, next) => {
    host = {
      fetch: (url) => $.http.fetch(url),
      run: (argv, init) => $.process.run(argv, init),
      exists: (path) => $.fs.exists(path),
      list: (path) => $.fs.list(path),
      stat: (path) => $.fs.stat(path),
      readBase64: async (path) => (await $.fs.read(path, { as: 'bytes' })).base64,
      readText: (path) => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      surfaces: () => $.session.surfaces(),
      storeGet: (key) => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      invalidate: () => $.ui.invalidate('ui.render'),
      blit: (args) => $.ui.blit(args),
      open: (pane) => $.ui.open(pane),
      close: (pane) => $.ui.close(pane),
      toast: (text) => $.ui.toast(text, { timeoutMs: 6000 }),
      every: (ms, fn) => $.clock.every(ms, fn),
      now: () => $.clock.now(),
      log: (line) => $.ui.log(line, { to: 'debug' }),
    }
    isTmux = Boolean(await $.env.get('TMUX'))
    await $.command.register({
      name: 'ubahn',
      description: 'U-Bahn TV: open or close the pane; "next" skips a clip, "status" shows the feeds and setup',
      argumentHint: '[next|status]',
      immediate: true,
    })
    const tools = { curl: await findTool(host, 'curl', '--version'), ffmpeg: await findTool(host, 'ffmpeg', '-version') }
    toolsMissing = Object.keys(tools).filter((k) => !tools[k])
    if (toolsMissing.length) status = words.missing(toolsMissing.join(', '))
    cache = createCache(host, { home: await $.env.get('HOME'), fps, stillsFps, tools, log })
    savedId = (await host.storeGet(`position:${feedsKey}`)) ?? null
    log(
      `session-start feeds=${feedUrls.length} timing=${timing} fps=${fps} stillsFps=${stillsFps} delayMs=${delayMs} maxLagMs=${MAX_LAG_MS} ` +
        `tmux=${isTmux} curl=${tools.curl ?? '-'} ffmpeg=${tools.ffmpeg ?? '-'} saved=${savedId ?? '-'}`,
    )
    await refreshSurfaces()
    // The copies on disk play at once; each feed due a fetch joins the loop
    // as it arrives
    await restoreFeeds()
    refreshDue()
    cache.removeOrphans(feedUrls.map(hashKey))
    return next(e)
  })

  // The Desktop app (or a terminal) joined or left: decode what's drawn now
  on('session.attach', async ($, e, next) => {
    const result = await next(e)
    await refreshSurfaces()
    return result
  })

  on('session.detach', async ($, e, next) => {
    const result = await next(e)
    await refreshSurfaces()
    return result
  })

  on('command.run', { command: 'ubahn' }, async ($, e) => {
    const arg = (e.args || '').trim()
    log(`command args="${arg}" isOpen=${isOpen}`)
    if (arg === 'status') return { text: await statusText() }
    if (arg === 'next') {
      if (playlist.length) await advance('skip')
    } else if (isOpen) {
      await closePane('command')
    } else {
      await openPane('user')
    }
    return {}
  })

  on('turn.start', async ($, e, next) => {
    armTimer?.cancel()
    log(`turn-start isOpen=${isOpen} armed=${!isOpen}`)
    if (!isOpen) armTimer = $.clock.after(delayMs, () => openPane('auto'))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's run ends with a turn.complete of its own (and raises no
    // turn.start); only the main loop's turn ending stops the pane
    if (e.agentId) return next(e)
    armTimer?.cancel()
    armTimer = null
    log(`turn-complete durationMs=${e.durationMs ?? '?'} isOpen=${isOpen} openedBy=${openedBy ?? '-'}`)
    // A pane the user opened stays; one that opened by itself goes with the turn
    if (isOpen && openedBy === 'auto') await closePane('turn-complete')
    return next(e)
  })

  // The user closed it (✕, Ctrl+X X) or we did: stop playing either way
  on('ui.close', { id: PANE }, async ($, e, next) => {
    log(`ui-close origin=${e.origin?.kind ?? '?'}`)
    ticker?.cancel()
    ticker = null
    isOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Image, Link, Svg } = $.ui.resolve(e)
    const cols = e.props.bodyColumns
    const bodyRows = e.props.scroll?.bodyRows ?? 0
    const item = current()

    const header = Box({
      flexDirection: 'row',
      justifyContent: 'space-between',
      children: [
        Text({ bold: true, color: theme.accent, wrap: 'truncate-end', children: [`▌${feedLabel(item?.feed ?? feeds.get(feedUrls[0])?.feed).replace(' · ', '  ·  ')}`] }),
        Text({ bold: true, children: [clockText()] }),
      ],
    })

    // 16:9 in cells about twice as tall as wide; leave room for the text below
    let imgCols = Math.min(cols, 255)
    let imgRows = Math.round((imgCols * 9) / 32)
    if (e.props.placement === 'dock' && bodyRows > 0 && imgRows > bodyRows - 8) {
      imgRows = Math.max(4, bodyRows - 8)
      imgCols = Math.min(cols, Math.round((imgRows * 32) / 9))
    }

    const notice = (text) =>
      Box({
        height: imgRows,
        width: imgCols,
        borderStyle: 'round',
        justifyContent: 'center',
        alignItems: 'center',
        children: [Text({ dimColor: true, wrap: 'wrap', children: [text] })],
      })

    let screen
    if (e.surface === 'desktop') {
      // Slow path only: each redraw carries the still due now
      const source = item && (await stillSvg(item))
      screen = source
        ? Svg({ source, alt: item.title })
        : Text({ dimColor: true, wrap: 'wrap', children: [waitingText(item)] })
    } else if (e.surface !== 'terminal') {
      screen = Text({ children: [words.surface] })
    } else if (isTmux) {
      screen = notice(words.tmux)
    } else if (item && cache.frameCount(item) > 0) {
      screen = Image({
        key: 'screen',
        source: { file: cache.framePath(item, clip?.id === item.id ? clip.shown : 0), format: 'png' },
        columns: imgCols,
        rows: imgRows,
        alt: item.title,
      })
    } else {
      screen = notice(waitingText(item))
    }

    const children = [header, screen]
    if (item) {
      const total = cache.frameCount(item, clockKind()) || !isVideo(item) ? clipMs(item) : 0
      const secs = (ms) => Math.round(ms / 1000) + 's'
      children.push(
        Text({ bold: true, wrap: 'truncate-end', children: [item.title] }),
        Text({
          children: [
            `Clip ${idx + 1}/${playlist.length}  `,
            progressBar(Math.max(10, cols - 30), elapsedMs, total),
            `  ${secs(elapsedMs)} / ${total ? secs(total) : '…'}`,
          ],
        }),
        Text({ dimColor: true, wrap: 'truncate-end', children: [words.upNext + upcoming().title] }),
      )
      if (item.link) children.push(Link({ href: item.link, label: '→ ' + (item.linkTitle || words.more) }))
    }
    const problem = status || unreachableText()
    if (problem) children.push(Text({ color: 'red', wrap: 'wrap', children: [problem] }))
    const credit = item ? item.feed.credit : [...new Set(feedUrls.map(hostOf))].join(', ')
    children.push(Text({ dimColor: true, wrap: 'truncate-end', children: [words.credit(credit)] }))

    return Box({ flexDirection: 'column', children })
  })
}

// The clip cache. curl downloads each clip (no size cap, unlike $.http.fetch)
// and ffmpeg decodes it to frames: PNGs at the playback rate, which the
// terminal reads itself, and small JPEG stills at a few a second for surfaces
// that draw an Svg (the Desktop app).
//
// Each feed has its own folder, ~/.cache/ubahn-tv/feeds/<feed key>/, holding
// feed.json (the last answer the feed gave), clips/<id>.<ext>, frames/<id> and
// stills/<rate>fps-<width>px/<id>. A frames or stills folder only exists once
// its decode finished: ffmpeg writes to a .tmp- folder that is renamed into
// place. Sessions share the cache, so a folder is only removed once nobody has
// touched it for a while, and cleanup only ever touches the feed it was given.
//
// What bounds the cache: frames and stills only for the clips playing now and
// next, clips only while their feed lists them and up to a size per feed, and
// the folder of a feed no session plays only until it has sat untouched a week.

const DOWNLOAD_TIMEOUT_S = 60
// A folder that played or decoded this recently may belong to another session
const IN_USE_MS = 3 * 60 * 1000
// Past this, a feed's clips played longest ago are deleted (and downloaded again if they come round)
const MAX_CLIPS_BYTES = 500 * 1024 * 1024
// The folder of a feed this session doesn't play goes once nothing in it was touched for this long
const ORPHAN_DAYS = 7
// $.fs reads and writes up to 4 MiB; a feed answer bigger than this isn't kept
const MAX_FEED_FILE_CHARS = 3 * 1024 * 1024
const TOOL_DIRS = ['', '/opt/homebrew/bin/', '/usr/local/bin/', '/usr/bin/']

// What each kind of frame is: its format and width. Stills stay small because
// each one travels inside the Svg's markup on every redraw.
const KINDS = {
  frames: { ext: 'png', width: 800, quality: [] },
  stills: { ext: 'jpg', width: 640, quality: ['-q:v', '5'] },
}

// Finds curl and ffmpeg even when PATH lacks Homebrew (an app launched from the Dock)
export async function findTool(host, name, versionFlag) {
  for (const dir of TOOL_DIRS) {
    try {
      const r = await host.run([dir + name, versionFlag], { timeoutMs: 5000 })
      if (r.exitCode === 0) return dir + name
    } catch {
      // Not there: try the next place
    }
  }
  return null
}

export function createCache(host, { home, fps, stillsFps, tools, log = () => {} }) {
  const root = `${home}/.cache/ubahn-tv/feeds`
  const feedRoot = (feed) => `${root}/${feed.key}`
  const clipsRoot = (feed) => `${feedRoot(feed)}/clips`
  // Stills are kept per rate and width, so a changed setting never plays stills of another
  const stillsRoot = (feed) => `${feedRoot(feed)}/stills`
  const stillsName = `${stillsFps}fps-${KINDS.stills.width}px`
  const kindRoot = (feed, kind) => (kind === 'stills' ? `${stillsRoot(feed)}/${stillsName}` : `${feedRoot(feed)}/frames`)
  const kindFps = (kind) => (kind === 'stills' ? stillsFps : fps)
  const inflight = new Map()
  const frameCounts = new Map()

  const countKey = (item, kind) => `${kind}:${item.id}`
  const framesDir = (item, kind) => `${kindRoot(item.feed, kind)}/${item.id}`
  const clipPath = (item) => `${clipsRoot(item.feed)}/${item.id}.${item.ext}`
  const framePath = (item, i, kind = 'frames') =>
    `${framesDir(item, kind)}/${String(i + 1).padStart(4, '0')}.${KINDS[kind].ext}`

  async function run(argv, timeoutMs = 120000) {
    const r = await host.run(argv, { timeoutMs })
    if (r.exitCode !== 0) throw new Error(`${argv[0].split('/').pop()} exited ${r.exitCode}: ${r.stderr.slice(0, 200)}`)
    return r
  }

  async function countFrames(dir, ext) {
    if (!(await host.exists(`${dir}/0001.${ext}`))) return 0
    const list = await host.list(dir)
    return list.filter((f) => f.kind === 'file' && f.name.endsWith('.' + ext)).length
  }

  async function download(item) {
    const src = clipPath(item)
    if (await host.exists(src)) return { src, downloadMs: 0 }
    const part = `${src}.part`
    const t0 = Date.now()
    try {
      await run(
        [tools.curl, '-sfL', '--max-time', String(DOWNLOAD_TIMEOUT_S), '-o', part, item.mediaUrl],
        (DOWNLOAD_TIMEOUT_S + 10) * 1000,
      )
      await run(['mv', '-f', part, src])
    } catch (err) {
      await host.run(['rm', '-f', part]).catch(() => {})
      throw err
    }
    return { src, downloadMs: Date.now() - t0 }
  }

  async function decode(item, src, kind) {
    const { ext, width, quality } = KINDS[kind]
    const final = framesDir(item, kind)
    const tmp = `${kindRoot(item.feed, kind)}/.tmp-${item.id}-${Math.random().toString(36).slice(2, 8)}`
    const video = item.kind === 'video'
    const t0 = Date.now()
    try {
      await run(['mkdir', '-p', tmp])
      await run([
        tools.ffmpeg, '-v', 'error', '-y', '-i', src,
        '-vf', video ? `fps=${kindFps(kind)},scale=${width}:-2` : `scale=${width}:-2`,
        ...(video ? [] : ['-frames:v', '1']),
        ...quality,
        `${tmp}/%04d.${ext}`,
      ])
      // Another session may have finished the same clip first: keep theirs
      if (await host.exists(final)) await run(['rm', '-rf', tmp])
      else await run(['mv', tmp, final])
    } catch (err) {
      await host.run(['rm', '-rf', tmp]).catch(() => {})
      throw err
    }
    return Date.now() - t0
  }

  async function prepareOnce(item, kind) {
    const { ext } = KINDS[kind]
    const cached = await countFrames(framesDir(item, kind), ext)
    if (cached > 0) {
      log(`prepare id=${item.id} kind=${kind} cached frames=${cached}`)
      return cached
    }
    if (!tools.curl || !tools.ffmpeg) throw new Error('curl or ffmpeg not found')
    await run(['mkdir', '-p', clipsRoot(item.feed), kindRoot(item.feed, kind)])
    const { src, downloadMs } = await download(item)
    const decodeMs = await decode(item, src, kind)
    const frames = await countFrames(framesDir(item, kind), ext)
    log(`prepare id=${item.id} kind=${kind} feed=${item.feed.key} source=${item.mediaUrl} downloadMs=${downloadMs} decodeMs=${decodeMs} frames=${frames}`)
    if (frames === 0) throw new Error('ffmpeg wrote no frames')
    return frames
  }

  // Resolves to the number of frames of that kind; one decode per clip and kind at a time
  function prepare(item, kind = 'frames') {
    const key = countKey(item, kind)
    if (frameCounts.has(key)) return Promise.resolve(frameCounts.get(key))
    if (!inflight.has(key)) {
      const p = prepareOnce(item, kind)
        .then((n) => {
          frameCounts.set(key, n)
          return n
        })
        .finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    return inflight.get(key)
  }

  // Marks a clip and its frames as in use: other sessions leave them alone,
  // and the clip counts as just played when its feed's clips are trimmed
  function touch(item, kinds) {
    for (const kind of kinds) host.run(['touch', framesDir(item, kind)]).catch(() => {})
    host.run(['touch', '-c', clipPath(item)]).catch(() => {})
  }

  // The feed's answer from its last good fetch: { url, fetchedAt, text }, or null
  async function readFeed(key) {
    const path = `${root}/${key}/feed.json`
    try {
      if (!(await host.exists(path))) return null
      const saved = JSON.parse(await host.readText(path))
      return saved && typeof saved.text === 'string' && Number.isFinite(saved.fetchedAt) ? saved : null
    } catch (err) {
      log(`feed-file error key=${key} error="${err.message}"`)
      return null
    }
  }

  // Keeps a good answer for the next session; written aside and renamed into
  // place, so a session never reads half a file
  async function saveFeed(feed, saved) {
    const json = JSON.stringify(saved)
    if (json.length > MAX_FEED_FILE_CHARS) return log(`feed-file skipped key=${feed.key} chars=${json.length}`)
    const path = `${feedRoot(feed)}/feed.json`
    const tmp = `${feedRoot(feed)}/.feed-${Math.random().toString(36).slice(2, 8)}.json`
    try {
      await host.write(tmp, json)
      await run(['mv', '-f', tmp, path])
      log(`feed saved key=${feed.key} chars=${json.length}`)
    } catch (err) {
      await host.run(['rm', '-f', tmp]).catch(() => {})
      log(`feed-file error key=${feed.key} error="${err.message}"`)
    }
  }

  // Deletes a feed's clips played longest ago until they fit MAX_CLIPS_BYTES,
  // never one playing now or next, nor one another session touched just now
  async function trimClips(key, keepIds, now) {
    const clips = clipsRoot({ key })
    if (!(await host.exists(clips))) return
    const files = (await host.list(clips)).filter((f) => f.kind === 'file' && !f.name.endsWith('.part'))
    let total = files.reduce((sum, f) => sum + f.size, 0)
    if (total <= MAX_CLIPS_BYTES) return
    for (const f of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= MAX_CLIPS_BYTES) break
      if (keepIds.includes(f.name.split('.')[0]) || now - f.mtimeMs < IN_USE_MS) continue
      await run(['rm', '-f', `${clips}/${f.name}`])
      total -= f.size
      log(`trim ${key}/clips/${f.name} size=${f.size}`)
    }
  }

  // Deletes the folders of feeds this session doesn't play, once nothing in
  // them was touched for ORPHAN_DAYS: another session may still play them
  async function removeOrphans(activeKeys) {
    try {
      if (!(await host.exists(root))) return
      for (const d of await host.list(root)) {
        if (d.kind !== 'dir' || activeKeys.includes(d.name)) continue
        const dir = `${root}/${d.name}`
        const recent = await run(['find', dir, '-mmin', `-${ORPHAN_DAYS * 24 * 60}`, '-print', '-quit'])
        if (recent.stdout.trim()) continue
        await run(['rm', '-rf', dir])
        log(`orphan removed key=${d.name}`)
      }
    } catch (err) {
      log(`orphan error="${err.message}"`)
    }
  }

  // Frames take ~20 MB per clip: drop folders no session is using, in every
  // feed, and trim each feed's clips to their limit
  async function evict(keepIds) {
    let keys = []
    try {
      if (await host.exists(root)) keys = (await host.list(root)).filter((d) => d.kind === 'dir').map((d) => d.name)
    } catch (err) {
      log(`evict error="${err.message}"`)
    }
    const now = Date.now()
    for (const key of keys) {
      for (const kind of Object.keys(KINDS)) {
        const kindDir = kindRoot({ key }, kind)
        try {
          if (!(await host.exists(kindDir))) continue
          for (const dir of await host.list(kindDir)) {
            if (dir.kind !== 'dir') continue
            const id = dir.name.startsWith('.tmp-') ? null : dir.name
            if (id && keepIds.includes(id)) continue
            const { mtimeMs } = await host.stat(`${kindDir}/${dir.name}`)
            // A .tmp- folder older than the window is a decode that died
            if (now - mtimeMs < IN_USE_MS) continue
            frameCounts.delete(`${kind}:${id}`)
            await run(['rm', '-rf', `${kindDir}/${dir.name}`])
            log(`evict ${key}/${kind}/${dir.name}`)
          }
        } catch (err) {
          log(`evict error kind=${kind} error="${err.message}"`)
        }
      }
      try {
        await trimClips(key, keepIds, now)
      } catch (err) {
        log(`trim error key=${key} error="${err.message}"`)
      }
    }
  }

  // Delete one feed's clips and frames its latest list no longer has
  async function cleanup(feed, items) {
    try {
      const ids = new Set(items.map((s) => s.id))
      let removed = 0
      const clips = clipsRoot(feed)
      if (await host.exists(clips)) {
        for (const f of await host.list(clips)) {
          const id = f.name.split('.')[0]
          if (f.kind === 'file' && !ids.has(id) && !f.name.endsWith('.part')) {
            await run(['rm', '-f', `${clips}/${f.name}`])
            removed += 1
          }
        }
      }
      for (const kind of Object.keys(KINDS)) {
        const kindDir = kindRoot(feed, kind)
        if (!(await host.exists(kindDir))) continue
        for (const d of await host.list(kindDir)) {
          if (d.kind === 'dir' && !d.name.startsWith('.tmp-') && !ids.has(d.name)) {
            frameCounts.delete(`${kind}:${d.name}`)
            await run(['rm', '-rf', `${kindDir}/${d.name}`])
            removed += 1
          }
        }
      }
      // Stills of another rate or width, once no session has touched them for a while
      const stills = stillsRoot(feed)
      if (await host.exists(stills)) {
        const now = Date.now()
        for (const d of await host.list(stills)) {
          if (d.kind !== 'dir' || d.name === stillsName) continue
          const { mtimeMs } = await host.stat(`${stills}/${d.name}`)
          if (now - mtimeMs < IN_USE_MS) continue
          await run(['rm', '-rf', `${stills}/${d.name}`])
          removed += 1
        }
      }
      log(`cleanup feed=${feed.key} removed=${removed}`)
    } catch (err) {
      log(`cleanup error feed=${feed.key} error="${err.message}"`)
    }
  }

  return {
    root,
    prepare,
    touch,
    evict,
    cleanup,
    readFeed,
    saveFeed,
    removeOrphans,
    framePath,
    frameCount: (item, kind = 'frames') => frameCounts.get(countKey(item, kind)) ?? 0,
    readBase64: (item, i) => host.readBase64(framePath(item, i, 'stills')),
  }
}

import { mock } from 'claude-code/testing'
import screenfeed from './fixtures/screenfeed.ts'
import fixture from './playlist.fixture.ts'
import { hashKey } from '../hooks/items.js'

export const REGIOFOKUS = 'https://regiofokus.de/content/NBG_MET/playlist.json'
export const SCREENFEED = 'https://kitchen.screenfeed.com/feed/vrqg8c8fax6emtkpbs446s17s.xml'
export const BROKEN = 'https://broken.example/feed.xml'

// Every clip decodes to 144 frames: 12 s at the default 12 fps, or 120 stills at the default 10 fps
export const FRAMES = 144
export const STILLS = 120
export const STILL_BASE64 = '/9j/AAAA'

export const PANE = {
  plugin: 'ubahn-tv',
  component: 'Pane',
  requestId: 'ubahn-tv',
  viewport: { columns: 139, rows: 64 },
  props: {
    title: 'U-BAHN TV · NÜRNBERG',
    isFocused: false,
    bodyColumns: 84,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 58 },
    view: {},
  },
} as const

export type Calls = { logs: string[]; opens: number; closes: number; toasts: string[]; blits: number; reads: string[]; runs: string[][]; fetches: string[]; writes: string[] }

// Where a feed keeps its last good answer
export const feedFile = (url: string) => `/Users/test/.cache/ubahn-tv/feeds/${hashKey(url)}/feed.json`

// Stubs everything the mod asks Claude Code for; returns the mock clock and what the mod did
export function stubSession(
  on,
  env: Record<string, string> = {},
  {
    framesReady = true,
    curlOk = true,
    surfaces = ['terminal'],
    files = new Map<string, string>(),
    hang = [],
    down = [],
  }: {
    framesReady?: boolean
    curlOk?: boolean
    surfaces?: string[]
    // Text files on disk, by path: feed.json files a test starts with, and what the mod writes
    files?: Map<string, string>
    // Feeds whose fetch answers only when the test calls release()
    hang?: string[]
    // Feeds that fail, as an unreachable host does
    down?: string[]
  } = {},
) {
  const calls: Calls = { logs: [], opens: 0, closes: 0, toasts: [], blits: 0, reads: [], runs: [], fetches: [], writes: [] }
  const held: (() => void)[] = []
  const clock = mock.clock(on, { now: Date.parse('2026-10-11T12:00') })
  mock.env(on, { HOME: '/Users/test', ...env })
  const list = fixture.map((s) => ({ ...s, Expires: '2999-01-01T00:00' }))
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  // Each feed answers by its URL; anything else fails
  on('http.fetch', ($, e) => {
    calls.fetches.push(String(e.url))
    const ok = (text: string) => ({ value: { status: 200, ok: true, headers: {}, text } })
    const answer = () => {
      if (down.some((url) => String(e.url).startsWith(url))) return { value: { status: 503, ok: false, headers: {}, text: '' } }
      if (String(e.url).startsWith(REGIOFOKUS)) return ok(JSON.stringify(list))
      if (String(e.url) === SCREENFEED) return ok(screenfeed)
      return { value: { status: 500, ok: false, headers: {}, text: '' } }
    }
    if (hang.some((url) => String(e.url).startsWith(url))) return new Promise((resolve) => held.push(() => resolve(answer())))
    return answer()
  })
  on('process.run', ($, e) => {
    calls.runs.push([...e.argv])
    // mv of a file the mod wrote, as saveFeed renames feed.json into place
    if (e.argv[0] === 'mv' && files.has(e.argv.at(-2))) {
      files.set(e.argv.at(-1), files.get(e.argv.at(-2)))
      files.delete(e.argv.at(-2))
    }
    return { value: { exitCode: curlOk || !String(e.argv[0]).endsWith('curl') ? 0 : 1, stdout: '', stderr: '' } }
  })
  on('session.surfaces', () => ({ value: surfaces }))
  on('fs.exists', ($, e) => {
    if (String(e.path).endsWith('.json')) return { value: files.has(String(e.path)) }
    return { value: framesReady || !/0001\.(png|jpg)$/.test(String(e.path)) }
  })
  on('fs.write', ($, e) => {
    calls.writes.push(String(e.path))
    files.set(String(e.path), String(e.text))
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const isStills = String(e.path).includes('/stills/')
    const files = Array.from({ length: isStills ? STILLS : FRAMES }, (_, i) => `${i}.${isStills ? 'jpg' : 'png'}`)
    return { value: files.map((name) => ({ name, kind: 'file', size: 1, isLink: false })) }
  })
  on('fs.read', ($, e) => {
    if (e.as !== 'bytes') return { value: files.get(String(e.path)) ?? '' }
    calls.reads.push(String(e.path))
    return { value: { base64: STILL_BASE64 } }
  })
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }))
  on('ui.open', () => {
    calls.opens += 1
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    calls.closes += 1
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    calls.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.blit', () => {
    calls.blits += 1
    return { value: {} }
  })
  on('ui.log', ($, e) => {
    calls.logs.push(e.text)
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  // Answers every fetch held so far
  const release = () => held.splice(0).forEach((answer) => answer())
  return { clock, calls, files, release }
}

export async function startSession($, clock) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  await clock.advance(10)
}

export const clipEnds = (logs: string[]) => logs.filter((l) => l.startsWith('ubahn clip-end'))
export const field = (line: string, name: string) => Number(line.match(new RegExp(`${name}=(-?\\d+)`))?.[1])

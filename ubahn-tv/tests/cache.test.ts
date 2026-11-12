import { expect, test } from 'claude-code/testing'
import { createCache } from '../hooks/media.js'

const MB = 1024 * 1024
const DAY = 24 * 60 * 60 * 1000
const ROOT = '/home/.cache/ubahn-tv/feeds'

// A file system of folders and files, by path: just enough for evict and removeOrphans
function fakeHost(entries: Record<string, { kind: 'dir' | 'file'; size?: number; mtimeMs?: number }>, recentDirs: string[] = []) {
  const removed: string[] = []
  const finds: string[] = []
  const children = (dir: string) =>
    Object.entries(entries)
      .filter(([p]) => p.slice(0, p.lastIndexOf('/')) === dir)
      .map(([p, e]) => ({ name: p.slice(dir.length + 1), kind: e.kind, size: e.size ?? 0, mtimeMs: e.mtimeMs ?? 0, isLink: false }))
  const host = {
    exists: async (p: string) => p in entries,
    list: async (p: string) => children(p),
    stat: async (p: string) => ({ kind: entries[p]?.kind, size: 0, mtimeMs: entries[p]?.mtimeMs ?? 0, isLink: false }),
    run: async (argv: string[]) => {
      if (argv[0] === 'find') {
        finds.push(argv[1])
        return { exitCode: 0, stdout: recentDirs.includes(argv[1]) ? `${argv[1]}/clips\n` : '', stderr: '' }
      }
      if (argv[0] === 'rm') removed.push(argv.at(-1))
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  const cache = createCache(host, { home: '/home', fps: 12, stillsFps: 10, tools: { curl: 'curl', ffmpeg: 'ffmpeg' } })
  return { cache, removed, finds }
}

const clipsOf = (key: string, clips: [string, number, number][]) =>
  Object.fromEntries([
    [ROOT, { kind: 'dir' }],
    [`${ROOT}/${key}`, { kind: 'dir' }],
    [`${ROOT}/${key}/clips`, { kind: 'dir' }],
    ...clips.map(([name, size, mtimeMs]) => [`${ROOT}/${key}/clips/${name}`, { kind: 'file', size, mtimeMs }]),
  ])

test("a feed's clips past 500 MB go, those played longest ago first", async () => {
  const old = Date.now() - DAY
  const { cache, removed } = fakeHost(clipsOf('k1', [['a.mp4', 200 * MB, old + 1], ['b.mp4', 200 * MB, old + 2], ['c.mp4', 200 * MB, old + 3], ['d.mp4', 200 * MB, old + 4]]))
  await cache.evict([])
  expect(removed).toEqual([`${ROOT}/k1/clips/a.mp4`, `${ROOT}/k1/clips/b.mp4`])
})

test('trimming never takes a clip playing now or next, nor one another session just touched', async () => {
  const old = Date.now() - DAY
  const { cache, removed } = fakeHost(
    clipsOf('k1', [['a.mp4', 200 * MB, old + 1], ['b.mp4', 200 * MB, Date.now()], ['c.mp4', 200 * MB, old + 3], ['d.mp4', 200 * MB, old + 4], ['e.mp4.part', 900 * MB, old]]),
  )
  await cache.evict(['a'])
  expect(removed).toEqual([`${ROOT}/k1/clips/c.mp4`, `${ROOT}/k1/clips/d.mp4`])
})

test('clips under 500 MB are left alone', async () => {
  const { cache, removed } = fakeHost(clipsOf('k1', [['a.mp4', 200 * MB, 1], ['b.mp4', 200 * MB, 2]]))
  await cache.evict([])
  expect(removed).toEqual([])
})

test("the folder of a feed no longer played goes after a week untouched, never this session's", async () => {
  const dirs = Object.fromEntries(['', '/mine', '/stale', '/recent'].map((d) => [`${ROOT}${d}`, { kind: 'dir' }]))
  const { cache, removed, finds } = fakeHost(dirs, [`${ROOT}/recent`])
  await cache.removeOrphans(['mine'])
  expect(finds).toEqual([`${ROOT}/stale`, `${ROOT}/recent`])
  expect(removed).toEqual([`${ROOT}/stale`])
})

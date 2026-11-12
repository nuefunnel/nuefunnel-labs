import { expect, test } from 'claude-code/testing'
import { REGIOFOKUS, SCREENFEED, feedFile, startSession, stubSession } from './helpers.ts'
import fixture from './playlist.fixture.ts'

// The mock clock's start (helpers.ts) and the playlist the stub serves
const NOW = Date.parse('2026-10-11T12:00')
const MIN = 60 * 1000
const LIST = fixture.map((s) => ({ ...s, Expires: '2999-01-01T00:00' }))
// A clip the feed listed last time but no longer does
const OLD = { Id: 'old-spot', Name: '1_Old_Spot', Expires: '2999-01-01T00:00', Source: '1_Old_Spot.mp4', Type: 'Video', Length: 12, Url: '', LinkTitle: '' }

const status = async ($) => (await $.command.run({ command: 'ubahn', args: 'status' })).text
const clipLine = async ($) => (await status($)).split('\n').find((l) => l.startsWith('clip '))
const clipCount = (line: string) => Number(line.match(/^clip \d+\/(\d+):/)?.[1])
const clipTitle = (line: string) => line.replace(/^clip \d+\/\d+: /, '')
const savedFeed = (list, fetchedAt: number) => new Map([[feedFile(REGIOFOKUS), JSON.stringify({ url: REGIOFOKUS, fetchedAt, text: JSON.stringify(list) })]])
const fetchesOf = (fetches: string[], url: string) => fetches.filter((f) => f.startsWith(url)).length

test('a feed that never answers does not hold up the pane', { options: { feeds: `${REGIOFOKUS} ${SCREENFEED}` } }, async ($, on) => {
  const { clock, calls, release } = stubSession(on, {}, { hang: [SCREENFEED] })
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(10_000)
  expect(calls.opens).toBe(1)
  expect(await clipLine($)).toMatch(/\(U-BAHN TV · NÜRNBERG\)$/)
  expect(await status($)).toMatch(/screenfeed\.com.*\n    not loaded yet · fetching …/)
  // When it answers at last, its clips join the loop around the one playing
  const before = await clipLine($)
  release()
  await clock.settle()
  const after = await clipLine($)
  expect(clipTitle(after)).toBe(clipTitle(before))
  expect(clipCount(after)).toBeGreaterThan(clipCount(before))
})

test('a feed is never fetched twice at once', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, { hang: [REGIOFOKUS] })
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(10_000)
  await $.command.run({ command: 'ubahn', args: 'next' })
  expect(fetchesOf(calls.fetches, REGIOFOKUS)).toBe(1)
})

test('with nothing to play yet the pane opens and plays once a feed answers', async ($, on) => {
  const { clock, calls, release } = stubSession(on, {}, { hang: [REGIOFOKUS] })
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(10_000)
  expect(calls.opens).toBe(1)
  expect(await status($)).toMatch(/no playlist yet/)
  release()
  await clock.settle()
  expect(await clipLine($)).toMatch(/^clip 1\/\d+: .+\(U-BAHN TV · NÜRNBERG\)$/)
})

test('a feed that is down plays its copy from the last session', async ($, on) => {
  const files = savedFeed(LIST, NOW - 120 * MIN)
  const { clock } = stubSession(on, {}, { files, down: [REGIOFOKUS] })
  await startSession($, clock)
  expect(await status($)).toMatch(/regiofokus · U-BAHN TV · NÜRNBERG · \d+ clips · from disk, fetched \d+ min ago · error: HTTP 503/)
  expect(await clipLine($)).toMatch(/\(U-BAHN TV · NÜRNBERG\)$/)
})

test('a fresh copy on disk is played without fetching the feed again', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, { files: savedFeed(LIST, NOW - 10 * MIN) })
  await startSession($, clock)
  expect(fetchesOf(calls.fetches, REGIOFOKUS)).toBe(0)
  expect(await clipLine($)).toMatch(/\(U-BAHN TV · NÜRNBERG\)$/)
})

test('a good answer is kept on disk, and a failed one never replaces it', async ($, on) => {
  const kept = savedFeed([OLD], NOW - 120 * MIN)
  const failing = stubSession(on, {}, { files: kept, down: [REGIOFOKUS] })
  await startSession($, failing.clock)
  expect(JSON.parse(kept.get(feedFile(REGIOFOKUS))).text).toBe(JSON.stringify([OLD]))
  expect(failing.calls.writes).toHaveLength(0)
})

test('a good answer is written to feed.json', async ($, on) => {
  const { clock, files } = stubSession(on)
  await startSession($, clock)
  const saved = JSON.parse(files.get(feedFile(REGIOFOKUS)))
  expect(saved.url).toBe(REGIOFOKUS)
  expect(saved.fetchedAt).toBe(NOW)
  expect(JSON.parse(saved.text)).toHaveLength(LIST.length)
  // Written aside, then renamed into place
  expect([...files.keys()].filter((p) => p.includes('/.feed-'))).toHaveLength(0)
})

test('a clip its feed drops plays to its end, then the loop goes on', async ($, on) => {
  const { clock, release } = stubSession(on, {}, { files: savedFeed([OLD, ...LIST], NOW - 120 * MIN), hang: [REGIOFOKUS] })
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  await clock.advance(1000)
  const before = await clipLine($)
  expect(before).toMatch(/^clip 1\/\d+: Old Spot/)
  // The fresh list no longer has it: it stays on screen
  release()
  await clock.settle()
  expect(await clipLine($)).toBe(before)
  // Once it ends, it leaves the loop and the clip after it plays
  for (let i = 0; i < 120; i++) await clock.advance(100)
  const after = await clipLine($)
  expect(after).toMatch(/^clip 1\/\d+: wissensieschon Chatbot FAQ/)
  expect(clipCount(after)).toBe(clipCount(before) - 1)
})

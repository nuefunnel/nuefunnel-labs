import { expect, test } from 'claude-code/testing'
import { BROKEN, REGIOFOKUS, SCREENFEED, clipEnds, field, startSession, stubSession } from './helpers.ts'

const ffmpegIds = (runs: string[][]) =>
  new Set(runs.filter((argv) => argv[0].endsWith('ffmpeg') && argv.includes('-i')).map((argv) => argv.at(-1).match(/\.tmp-([0-9a-z]+)-/)?.[1]))
const clipLine = async ($) => (await $.command.run({ command: 'ubahn', args: 'status' })).text.split('\n').find((l) => l.startsWith('clip '))

test('at session start the first clip and the next two are prepared, before any turn', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, { framesReady: false })
  await startSession($, clock)
  expect(calls.opens).toBe(0)
  expect(ffmpegIds(calls.runs).size).toBe(3)
})

test('two feeds alternate clip by clip', { options: { feeds: `${REGIOFOKUS} ${SCREENFEED}` } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  expect(await clipLine($)).toMatch(/^clip 1\/\d+: .+\(U-BAHN TV · NÜRNBERG\)$/)
  await $.command.run({ command: 'ubahn', args: 'next' })
  expect(await clipLine($)).toMatch(/^clip 2\/\d+: Social Multipost \(Content Mix for Teams Feed\)$/)
  await $.command.run({ command: 'ubahn', args: 'next' })
  expect(await clipLine($)).toMatch(/\(U-BAHN TV · NÜRNBERG\)$/)
})

test('a feed that fails does not stop the others', { options: { feeds: `${BROKEN} ${REGIOFOKUS}` } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const text = (await $.command.run({ command: 'ubahn', args: 'status' })).text
  expect(text).toMatch(/error: HTTP 500/)
  expect(await clipLine($)).toMatch(/\(U-BAHN TV · NÜRNBERG\)$/)
})

test('an image plays for the duration its feed gives', { options: { feeds: SCREENFEED } }, async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  for (let i = 0; i < 60; i++) await clock.advance(100)
  const ends = clipEnds(calls.logs)
  expect(ends.length).toBe(1)
  expect(field(ends[0], 'expectedMs')).toBe(5000)
})

test('a long turn opens the pane after the delay and closes it at the end', async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(9000)
  expect(calls.opens).toBe(0)
  await clock.advance(1500)
  expect(calls.opens).toBe(1)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 12000, isAborted: false, usage: null })
  expect(calls.closes).toBe(1)
})

test("a subagent's turn ending neither cancels the timer nor closes the pane", async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(4000)
  await $.turn.complete({ turnId: 's1', agentId: 'a1', answer: 'report', durationMs: 3000, isAborted: false, reason: 'answer', usage: null })
  await clock.advance(6500)
  expect(calls.opens).toBe(1)
  await $.turn.complete({ turnId: 's2', agentId: 'a1', answer: 'report', durationMs: 3000, isAborted: false, reason: 'answer', usage: null })
  expect(calls.closes).toBe(0)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 15000, isAborted: false, reason: 'answer', usage: null })
  expect(calls.closes).toBe(1)
})

test('a short turn never opens the pane', async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.turn.start({ turnId: 't1' })
  await clock.advance(4000)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 4000, isAborted: false, usage: null })
  await clock.advance(10000)
  expect(calls.opens).toBe(0)
})

test('a pane opened with /ubahn stays open after a turn', async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  await $.turn.start({ turnId: 't1' })
  await clock.advance(12000)
  await $.turn.complete({ turnId: 't1', answer: 'ok', durationMs: 12000, isAborted: false, usage: null })
  expect(calls.opens).toBe(1)
  expect(calls.closes).toBe(0)
})

test('hybrid timing: a 12 s clip switches at 12 s with steady ticks', async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  for (let i = 0; i < 130; i++) await clock.advance(100)
  const ends = clipEnds(calls.logs)
  expect(ends.length).toBe(1)
  expect(field(ends[0], 'expectedMs')).toBe(12000)
  expect(Math.abs(field(ends[0], 'driftMs'))).toBeLessThanOrEqual(300)
  expect(calls.blits).toBeGreaterThan(100)
})

test('hybrid timing: a 3 s stall does not stretch the clip', async ($, on) => {
  const { clock, calls } = stubSession(on)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  await clock.advance(2000)
  await clock.advance(3000)
  for (let i = 0; i < 80; i++) await clock.advance(100)
  const ends = clipEnds(calls.logs)
  expect(ends.length).toBe(1)
  expect(Math.abs(field(ends[0], 'driftMs'))).toBeLessThanOrEqual(300)
})

test('/ubahn status describes the setup', { options: { feeds: REGIOFOKUS } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const answer = await $.command.run({ command: 'ubahn', args: 'status' })
  expect(answer.text).toMatch(/1 feed · theme ubahn\n  https:\/\/regiofokus\.de\/content\/NBG_MET\/playlist\.json\n    regiofokus · U-BAHN TV · NÜRNBERG · \d+ clips/)
  expect(answer.text).toMatch(/timing=hybrid/)
})

for (const feeds of ['', '   ', 'not a web address']) {
  test(`a feeds setting of ${JSON.stringify(feeds)} plays the default feeds`, { options: { feeds } }, async ($, on) => {
    const { clock } = stubSession(on)
    await startSession($, clock)
    const answer = await $.command.run({ command: 'ubahn', args: 'status' })
    expect(answer.text).toMatch(/^U-Bahn TV · 2 feeds · theme neutral\n  https:\/\/podsumo\.io\/mrss\/\S+\n/)
  })
}

test('blank number settings get their defaults', { options: { fps: '', auto_open_delay_seconds: '', desktop_fps: '' } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const answer = await $.command.run({ command: 'ubahn', args: 'status' })
  expect(answer.text).toMatch(/fps=12 delay=10s/)
})

test('by default Podsumo and the Nuremberg U-Bahn play mixed, in neutral English', async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const answer = await $.command.run({ command: 'ubahn', args: 'status' })
  expect(answer.text).toMatch(/^U-Bahn TV · 2 feeds · theme neutral\n  https:\/\/podsumo\.io\/mrss\/\S+\n.*\n  https:\/\/regiofokus\.de\/content\/NBG_MET\/playlist\.json\n/)
})

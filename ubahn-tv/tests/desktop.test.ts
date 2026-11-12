import { expect, test } from 'claude-code/testing'
import { PANE, STILL_BASE64, clipEnds, field, startSession, stubSession } from './helpers.ts'

const DESKTOP = { surfaces: ['desktop'] }
const ffmpegOutputs = (runs: string[][]) => runs.filter((argv) => argv[0].endsWith('ffmpeg') && argv.includes('-i')).map((argv) => argv.at(-1))

test('on desktop the pane shows the current still inside an Svg', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, DESKTOP)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  await clock.advance(100)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg).toBeDefined()
  expect(svg.props.source).toContain(`data:image/jpeg;base64,${STILL_BASE64}`)
  expect(calls.reads.at(-1)).toMatch(/\/stills\/10fps-640px\/[^/]+\/0001\.jpg$/)
})

test('on desktop the slideshow shows the still the clock is at', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, DESKTOP)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  for (let i = 0; i < 4; i++) await clock.advance(1000)
  await $.ui.mount({ ...PANE, surface: 'desktop' })
  // 4 s at 10 stills a second: the 40th or 41st still
  expect(calls.reads.at(-1)).toMatch(/\/004[01]\.jpg$/)
  expect(calls.reads.at(-1)).toContain('/stills/10fps-640px/')
})

test('on desktop an open pane redraws for each new still', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, DESKTOP)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  await clock.advance(100)
  await $.ui.mount({ ...PANE, surface: 'desktop' })
  const before = calls.reads.length
  for (let i = 0; i < 20; i++) await clock.advance(100)
  // 2 s at 10 stills a second
  expect(new Set(calls.reads.slice(before)).size).toBeGreaterThanOrEqual(18)
})

test('on desktop a clip runs for its stills, with no blits', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, DESKTOP)
  await startSession($, clock)
  await $.command.run({ command: 'ubahn', args: '' })
  for (let i = 0; i < 14; i++) await clock.advance(1000)
  const ends = clipEnds(calls.logs)
  expect(ends.length).toBe(1)
  expect(field(ends[0], 'expectedMs')).toBe(12000)
  expect(calls.blits).toBe(0)
})

test('a desktop session decodes only stills', async ($, on) => {
  const desktop = stubSession(on, {}, { ...DESKTOP, framesReady: false })
  await startSession($, desktop.clock)
  const outputs = ffmpegOutputs(desktop.calls.runs)
  expect(outputs.length).toBeGreaterThan(0)
  for (const out of outputs) expect(out).toMatch(/\/stills\/.*%04d\.jpg$/)
})

test('a terminal session never decodes or reads stills', async ($, on) => {
  const { clock, calls } = stubSession(on, {}, { framesReady: false })
  await startSession($, clock)
  const outputs = ffmpegOutputs(calls.runs)
  expect(outputs.length).toBeGreaterThan(0)
  for (const out of outputs) expect(out).toMatch(/\/frames\/.*%04d\.png$/)
  expect(calls.reads).toHaveLength(0)
})

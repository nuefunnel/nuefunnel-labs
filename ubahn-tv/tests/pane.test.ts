import { expect, test } from 'claude-code/testing'
import { PANE, REGIOFOKUS, SCREENFEED, startSession, stubSession } from './helpers.ts'

const header = async (ui) => ui.find({ type: 'Text', text: /^▌/ })

test('regiofokus feeds alone keep the U-Bahn look: German words and the VAG red bar', { options: { feeds: REGIOFOKUS } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await header(ui)).props.color).toBe('#e30613')
  expect(await ui.find({ type: 'Text', text: /^Als nächstes: / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Inhalte: regiofokus\.de · \/ubahn schließt$/ })).toBeDefined()
})

test('another feed gets neutral English words and no red bar', { options: { feeds: SCREENFEED } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await header(ui)).props.color).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Up next: Social Multipost$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^From screenfeed\.com · \/ubahn closes$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Als nächstes|Inhalte/ })).toBeUndefined()
})

test('a mixed loop stays in English, even on a U-Bahn clip', { options: { feeds: `${REGIOFOKUS} ${SCREENFEED}` } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The first clip is the U-Bahn one: its header and credit are its feed's, the words are not
  expect((await header(ui)).text).toMatch(/U-BAHN TV/)
  expect(await ui.find({ type: 'Text', text: /^Up next: Social Multipost$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^From regiofokus\.de · \/ubahn closes$/ })).toBeDefined()
})

test('the pane draws a 16:9 picture and the clip details', { options: { feeds: REGIOFOKUS } }, async ($, on) => {
  const { clock } = stubSession(on)
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const img = await ui.find({ type: 'Image' })
  expect(img).toBeDefined()
  expect(img.props.columns).toBe(84)
  expect(img.props.rows).toBe(24)
  expect(await ui.find({ type: 'Text', text: /^Als nächstes: / })).toBeDefined()
})

test('inside tmux the pane explains why there is no picture', { options: { feeds: REGIOFOKUS } }, async ($, on) => {
  const { clock } = stubSession(on, { TMUX: '/tmp/tmux-501/default,1,0' })
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Keine Bilder in tmux/ })).toBeDefined()
})

test('a missing curl is named in the pane', { options: { feeds: REGIOFOKUS } }, async ($, on) => {
  const { clock } = stubSession(on, {}, { framesReady: false, curlOk: false })
  await startSession($, clock)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Fehlt: curl/ })).toBeDefined()
})

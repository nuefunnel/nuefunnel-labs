import { expect, test } from 'claude-code/testing'
import { adapterFor, parseFeedList } from '../hooks/adapters/index.js'
import { keep, matches, parse, prettyName } from '../hooks/adapters/regiofokus.js'
import fixture from './playlist.fixture.ts'

const URL = 'https://regiofokus.de/content/NBG_MET/playlist.json'

test('recognises a network playlist URL', () => {
  expect(matches(URL)).toBe(true)
  expect(matches('https://regiofokus.de/player.php?site=NBG_MET')).toBe(false)
  expect(adapterFor(URL).name).toBe('regiofokus')
  expect(adapterFor('https://example.com/feed.xml').name).toBe('mrss')
})

test('applies the website filter', () => {
  const entry = (Source) => ({ Source })
  expect(['a.mp4', 'b.mvp', 'VGN_spot.mp4', 'd.jpg'].map(entry).filter(keep).map((e) => e.Source)).toEqual(['a.mp4', 'd.jpg'])
  expect(keep({ Name: 'no source' })).toBe(false)
})

test('turns the playlist into items in the same order', () => {
  const feed = parse(JSON.stringify(fixture), URL)
  expect(feed.items).toHaveLength(fixture.filter(keep).length)
  expect(feed.label).toBe('U-BAHN TV')
  expect(feed.city).toBe('NÜRNBERG')
  expect(feed.credit).toBe('regiofokus.de')
  const first = feed.items[0]
  expect(first).toMatchObject({
    guid: fixture[0].Id,
    title: prettyName(fixture[0]),
    kind: 'video',
    mediaUrl: 'https://regiofokus.de/content/NBG_MET/9274_wissensieschon_Chatbot_FAQ.mp4',
    durationS: 20,
  })
  expect(first.validUntil).toBe(Date.parse('2026-10-11T23:59'))
  expect(feed.items.find((i) => i.title === 'NN Nürnberg 1').kind).toBe('image')
})

test('pretty names drop the numeric prefix and underscores', () => {
  expect(prettyName({ Name: '8775_Quiz_name_Tristanstrasse' })).toBe('Quiz name Tristanstrasse')
  expect(prettyName({ Name: 'Zitat_des_Tages_1084x610' })).toBe('Zitat des Tages 1084x610')
})

test('the feeds setting takes URLs separated by spaces, commas or new lines', () => {
  expect(parseFeedList(`${URL}\n https://a.example/f.xml, https://a.example/f.xml  not-a-url`)).toEqual([URL, 'https://a.example/f.xml'])
  expect(parseFeedList('')).toEqual([])
})

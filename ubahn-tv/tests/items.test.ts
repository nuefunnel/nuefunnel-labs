import { expect, test } from 'claude-code/testing'
import { extOf, finishItem, hashKey, isExpired, isStale, mix } from '../hooks/items.js'

const now = Date.parse('2026-10-11T12:00')
const feed = { url: 'https://a.example/feed.xml' }

test('feeds alternate item by item, then the longer one runs on', () => {
  expect(mix([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3'])
  expect(mix([])).toEqual([])
})

test('an item is out when it has ended or has not started yet', () => {
  expect(isExpired({ validUntil: now - 1 }, now)).toBe(true)
  expect(isExpired({ validFrom: now + 1 }, now)).toBe(true)
  expect(isExpired({ validFrom: now - 1, validUntil: now + 1 }, now)).toBe(false)
  expect(isExpired({ validFrom: NaN, validUntil: NaN }, now)).toBe(false)
})

test('a feed is due again after its ttl, an hour by default, or on a new day', () => {
  expect(isStale(0, now)).toBe(true)
  expect(isStale(now - 30 * 60 * 1000, now)).toBe(false)
  expect(isStale(now - 61 * 60 * 1000, now)).toBe(true)
  expect(isStale(now - 16 * 60 * 1000, now, 15)).toBe(true)
  expect(isStale(Date.parse('2026-10-11T23:50'), Date.parse('2026-10-12T00:05'))).toBe(true)
})

test('a ttl under five minutes counts as five', () => {
  expect(isStale(now - 2 * 60 * 1000, now, 1)).toBe(false)
  expect(isStale(now - 6 * 60 * 1000, now, 1)).toBe(true)
})

test('ids are stable, folder-safe and differ between feeds', () => {
  const a = finishItem({ guid: 'x', kind: 'image', mediaUrl: 'https://a.example/p.jpg' }, feed)
  const b = finishItem({ guid: 'x', kind: 'image', mediaUrl: 'https://a.example/p.jpg' }, { url: 'https://b.example/feed.xml' })
  expect(a.id).toBe(finishItem({ guid: 'x', kind: 'image', mediaUrl: 'whatever' }, feed).id)
  expect(a.id).not.toBe(b.id)
  expect(a.id).toMatch(/^[0-9a-z]+$/)
  expect(hashKey('')).toMatch(/^[0-9a-z]+$/)
})

test('an image without a duration gets ten seconds', () => {
  expect(finishItem({ kind: 'image', mediaUrl: 'https://a.example/p.jpg' }, feed).durationS).toBe(10)
  expect(finishItem({ kind: 'image', mediaUrl: 'https://a.example/p.jpg', durationS: 5 }, feed).durationS).toBe(5)
})

test('the saved file gets an extension from the type or the URL', () => {
  expect(extOf('https://x/clip', 'video/mp4')).toBe('mp4')
  expect(extOf('https://x/photo.JPG?w=200')).toBe('jpg')
  expect(extOf('https://x/noext')).toBe('bin')
})

import { expect, test } from 'claude-code/testing'
import { parse, parseValid } from '../hooks/adapters/mrss.js'
import flickr from './fixtures/flickr.ts'
import nbgmrss from './fixtures/nbgmrss.ts'
import noagenda from './fixtures/noagenda.ts'
import screenfeed from './fixtures/screenfeed.ts'
import sky from './fixtures/sky.ts'
import youtube from './fixtures/youtube.ts'

test('Screenfeed: finished 4K cards keep their media:content duration', () => {
  const feed = parse(screenfeed)
  expect(feed.title).toBe('Content Mix for Teams Feed')
  expect(feed.ttlMin).toBe(5)
  expect(feed.items).toHaveLength(3)
  for (const item of feed.items) {
    expect(item.kind).toBe('image')
    expect(item.durationS).toBe(5)
    expect(item.mediaUrl).toMatch(/^https:\/\/cdnkitchen\.screenfeed\.com\/.+\.jpg$/)
  }
})

test('the converted Nuremberg feed: videos, an image and an end date', () => {
  const feed = parse(nbgmrss)
  expect(feed.items.map((i) => i.kind)).toEqual(['video', 'video', 'video', 'video', 'image'])
  expect(feed.items[0]).toMatchObject({ title: 'FiF Schnuppertag Nov 26', durationS: 12, guid: 'b277842d-1d53-4cfb-852d-d3c24f2a0883' })
  expect(feed.items[0].validUntil).toBe(Date.parse('2026-10-19T23:59:00+02:00'))
})

test('news and photo feeds: one image per item', () => {
  const s = parse(sky)
  expect(s.items).toHaveLength(3)
  expect(s.items[0].mediaUrl).toMatch(/1920x1080/)
  expect(s.items[0].title).toMatch(/unemployment/i)
  expect(parse(flickr).items.every((i) => i.kind === 'image')).toBe(true)
})

test('items with no image or video are skipped', () => {
  // Audio enclosures and chapters only
  const feed = parse(noagenda)
  expect(feed.items).toHaveLength(0)
  expect(feed.skipped).toBe(2)
})

test('anything that is not RSS is refused with a reason', () => {
  expect(() => parse(youtube)).toThrow(/not an RSS feed \(root <feed>\)/)
  expect(() => parse('<!doctype html><html><body>Moved</body></html>')).toThrow(/not an RSS feed/)
})

test('picks video over image, then the largest up to 1920 px, and reads media:group', () => {
  const feed = parse(`<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><guid>g</guid>
    <media:group>
      <media:content url="https://x/small.jpg" medium="image" width="640"/>
      <media:content url="https://x/big.jpg" medium="image" width="1600"/>
      <media:content url="https://x/huge.jpg" medium="image" width="4000"/>
    </media:group></item>
    <item><enclosure url="https://x/a.jpg" type="image/jpeg"/><media:content url="https://x/v.mp4" type="video/mp4"/></item>
  </channel></rss>`)
  expect(feed.items.map((i) => i.mediaUrl)).toEqual(['https://x/big.jpg', 'https://x/v.mp4'])
})

test('reads start and end from dcterms:valid', () => {
  expect(parseValid('start=2026-10-01T00:00Z; end=2026-10-19T23:59:00+02:00; scheme=W3C-DTF')).toEqual({
    validFrom: Date.parse('2026-10-01T00:00Z'),
    validUntil: Date.parse('2026-10-19T23:59:00+02:00'),
  })
})

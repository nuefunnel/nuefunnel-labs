import { expect, test } from 'claude-code/testing'
import { child, decodeEntities, parseXml, textOf } from '../hooks/xml.js'

test('reads elements, attributes, text and CDATA', () => {
  const root = parseXml(`<?xml version="1.0"?><!-- c --><rss version="2.0"><channel><title><![CDATA[A <b>bold</b> title]]></title><x a='1' b="two"/></channel></rss>`)
  expect(root.name).toBe('rss')
  const channel = child(root, 'channel')
  expect(textOf(channel, 'title')).toBe('A <b>bold</b> title')
  expect(child(channel, 'x').attrs).toEqual({ a: '1', b: 'two' })
})

test('decodes named and numeric entities, and leaves unknown ones', () => {
  expect(decodeEntities('Fish &amp; chips &lt;3 &#252;ber &#x2192; &copy;')).toBe('Fish & chips <3 über → &copy;')
})

test('resolves namespace prefixes, whatever the feed calls them', () => {
  const root = parseXml(`<rss xmlns:m="http://search.yahoo.com/mrss/"><item><m:content url="a.jpg" m:extra="1"/></item></rss>`)
  const content = child(root, 'item').children[0]
  expect(content.name).toBe('{http://search.yahoo.com/mrss/}content')
  expect(content.attrs['{http://search.yahoo.com/mrss/}extra']).toBe('1')
})

test('keeps a > inside a quoted attribute', () => {
  const root = parseXml(`<a title="x > y"><b/></a>`)
  expect(root.attrs.title).toBe('x > y')
  expect(root.children[0].name).toBe('b')
})

test('throws on input it cannot read', () => {
  expect(() => parseXml('')).toThrow()
  expect(() => parseXml('<rss><title><![CDATA[never closed')).toThrow()
})

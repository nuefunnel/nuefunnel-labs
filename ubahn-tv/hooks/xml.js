// A small XML reader for feeds. Mods run without a DOM and can only import the
// plugin's own files, so this is self-contained. It is forgiving where feeds are
// sloppy (unknown entities, stray text) and throws only when it can't go on.
//
// parseXml(text) returns the root element:
//   { name: '{namespace}local' or 'local', attrs: { qname: value }, children: [element], text }
// Names carry the namespace the element's prefix resolves to, so a feed that
// writes `mrss:content` for `media:content` still matches.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return NAMED[ref.toLowerCase()] ?? whole
  })
}

const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g

function parseAttrs(src) {
  const attrs = {}
  for (const m of src.matchAll(ATTR)) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '')
  return attrs
}

// Turns `prefix:local` into `{uri}local` with the namespaces in scope
function resolve(qname, scope, isAttr = false) {
  const i = qname.indexOf(':')
  if (i < 0) return isAttr || !scope[''] ? qname : `{${scope['']}}${qname}`
  const uri = scope[qname.slice(0, i)]
  return uri ? `{${uri}}${qname.slice(i + 1)}` : qname
}

export function parseXml(text) {
  const src = String(text).replace(/^﻿/, '')
  const top = { name: '#document', attrs: {}, children: [], text: '', scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }
  const stack = [top]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const cur = stack[stack.length - 1]
    if (lt < 0) {
      cur.text += decodeEntities(src.slice(i))
      break
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      if (end < 0) throw new Error('unclosed CDATA section')
      cur.text += src.slice(lt + 9, end)
      i = end + 3
    } else if (src[lt + 1] === '?') {
      const end = src.indexOf('?>', lt + 2)
      i = end < 0 ? src.length : end + 2
    } else if (src[lt + 1] === '!') {
      // DOCTYPE, possibly with an internal subset in brackets
      let depth = 0
      let j = lt + 2
      for (; j < src.length; j++) {
        if (src[j] === '[') depth++
        else if (src[j] === ']') depth--
        else if (src[j] === '>' && depth <= 0) break
      }
      i = j + 1
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt)
      if (end < 0) throw new Error('unclosed end tag')
      const qname = src.slice(lt + 2, end).trim()
      // Close up to the matching element; an end tag nothing opened is ignored
      const at = stack.findLastIndex((el) => el.qname === qname)
      if (at > 0) stack.length = at
      i = end + 1
    } else {
      // A start tag: find its end outside quoted attribute values
      let j = lt + 1
      let quote = null
      for (; j < src.length; j++) {
        const c = src[j]
        if (quote) {
          if (c === quote) quote = null
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
      }
      if (j >= src.length) throw new Error('unclosed start tag')
      let body = src.slice(lt + 1, j)
      const selfClosing = body.endsWith('/')
      if (selfClosing) body = body.slice(0, -1)
      const m = body.match(/^([^\s/>]+)\s*([\s\S]*)$/)
      if (!m) throw new Error(`bad tag at ${lt}`)
      const raw = parseAttrs(m[2])
      const scope = { ...cur.scope }
      for (const [k, v] of Object.entries(raw)) {
        if (k === 'xmlns') scope[''] = v
        else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v
      }
      const attrs = {}
      for (const [k, v] of Object.entries(raw)) if (k !== 'xmlns' && !k.startsWith('xmlns:')) attrs[resolve(k, scope, true)] = v
      const el = { name: resolve(m[1], scope), qname: m[1], attrs, children: [], text: '', scope }
      cur.children.push(el)
      if (!selfClosing) stack.push(el)
      i = j + 1
    }
  }
  const root = top.children[0]
  if (!root) throw new Error('no root element')
  return root
}

// Helpers for walking parsed elements by resolved name
export const child = (el, name) => el?.children.find((c) => c.name === name)
export const childrenNamed = (el, name) => el?.children.filter((c) => c.name === name) ?? []
export const textOf = (el, name) => {
  const c = name ? child(el, name) : el
  return c ? c.text.trim() : ''
}

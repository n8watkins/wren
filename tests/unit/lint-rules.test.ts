import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/** The lint half of the Lessons must keep firing: each sample below breaks one rule. */
const eslint = new ESLint({ cwd: process.cwd() })

async function rulesHit(code: string, filePath = 'lib/server/sample.ts'): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result.messages.map((m) => `${m.ruleId}: ${m.message}`)
}

describe('lesson lint rules', { timeout: 60_000 }, () => {
  it('rejects SQL built from a template string', async () => {
    const hits = await rulesHit('export const q = (db: any, id: string) => db.prepare(`SELECT * FROM t WHERE id = ${id}`)\n')
    expect(hits.join()).toMatch(/placeholders/)
  })

  it('rejects SQL built by concatenation', async () => {
    const hits = await rulesHit("export const q = (sql: any, id: string) => sql.exec('DELETE FROM t WHERE id = ' + id)\n")
    expect(hits.join()).toMatch(/placeholders/)
  })

  it('allows parameterized SQL', async () => {
    const hits = await rulesHit("export const q = (sql: any, id: string) => sql.exec('DELETE FROM t WHERE id = ?', id)\n")
    expect(hits.join()).not.toMatch(/placeholders/)
  })

  it('rejects client-set IP headers', async () => {
    const hits = await rulesHit("export const ip = (r: Request) => r.headers.get('x-forwarded-for')\n")
    expect(hits.join()).toMatch(/CF-Connecting-IP/)
  })

  it('rejects a user id read from the request', async () => {
    const hits = await rulesHit('export const who = (body: { userId: string }) => body.userId\n', 'app/api/sample/route.ts')
    expect(hits.join()).toMatch(/verified session/)
  })

  it('rejects calling Gemini outside agent/gemini.ts', async () => {
    const hits = await rulesHit("import { GoogleGenAI } from '@google/genai'\nexport const ai = GoogleGenAI\n")
    expect(hits.join()).toMatch(/Only agent\/gemini\.ts/)
  })

  it('rejects console logging outside lib/log.ts', async () => {
    const hits = await rulesHit("export const f = (prompt: string) => console.log(prompt)\n")
    expect(hits.join()).toMatch(/no-console/)
  })

  it('rejects raw HTML rendering', async () => {
    const hits = await rulesHit('export const X = ({ h }: { h: string }) => <div dangerouslySetInnerHTML={{ __html: h }} />\n', 'components/Sample.tsx')
    expect(hits.join()).toMatch(/Markdown/)
  })
})

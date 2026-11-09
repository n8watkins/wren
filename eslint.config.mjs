import { defineConfig, globalIgnores } from 'eslint/config'
import nextVitals from 'eslint-config-next/core-web-vitals'
import nextTs from 'eslint-config-next/typescript'

/**
 * Next's rules, plus the lint half of the Lessons (docs/LESSONS.md): each rule
 * below exists because one of the apps Wren replaces shipped that mistake.
 */
const SQL_CALLS = '/^(prepare|exec|raw|run|first|all)$/'

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Logs hold counts and codes, never content: everything goes through lib/log.ts.
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        // Parameterized queries only: no SQL built from template strings or concatenation.
        {
          selector: `CallExpression[callee.property.name=${SQL_CALLS}] > TemplateLiteral.arguments:first-child[expressions.length>0]`,
          message: 'Build SQL with ? placeholders and bound values, never a template string with ${}.',
        },
        {
          selector: `CallExpression[callee.property.name=${SQL_CALLS}] > BinaryExpression.arguments:first-child[operator='+']`,
          message: 'Build SQL with ? placeholders and bound values, never string concatenation.',
        },
        // Client-controlled IP headers are never a rate-limit key: CF-Connecting-IP only (lib/server/client-ip.ts).
        {
          selector: "Literal[value=/^(x-forwarded-for|x-real-ip|true-client-ip|x-client-ip|forwarded)$/i]",
          message: 'Use clientIp() (CF-Connecting-IP); other IP headers are set by the client.',
        },
        // Identity comes from the verified session only, never from what the client sent.
        {
          selector: "MemberExpression[object.name=/^(body|query|params|searchParams|data|parsed|input)$/][property.name=/^user_?[iI]d$/]",
          message: 'Never read a user id from the request; use the verified session (lib/server/session.ts).',
        },
        {
          selector: "CallExpression[callee.property.name='get'][arguments.0.value=/^(x-)?user[-_]?id$/i]",
          message: 'Never read a user id from the request; use the verified session (lib/server/session.ts).',
        },
        // Model output is never rendered as HTML (components/Markdown.tsx).
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: 'Render text or Markdown (components/Markdown.tsx); raw HTML only in the reviewed allowlist.',
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@google/genai', message: 'Only agent/gemini.ts talks to Gemini, after the meter (docs/LESSONS.md).' },
            { name: 'rehype-raw', message: 'Model output must never be parsed as HTML.' },
          ],
        },
      ],
    },
  },
  // The one module allowed to talk to Gemini.
  { files: ['agent/gemini.ts'], rules: { 'no-restricted-imports': 'off' } },
  // The reviewed raw-HTML uses: the icon sprite (static), the pre-paint theme script (static, nonced).
  {
    files: ['components/Icons.tsx', 'app/layout.tsx'],
    rules: {
      'no-restricted-syntax': 'off',
    },
  },
  // Node scripts and tests may print, and tests feed the rules' forbidden inputs on purpose.
  { files: ['scripts/**', 'playwright.config.ts'], rules: { 'no-console': 'off' } },
  {
    files: ['tests/**'],
    rules: { 'no-console': 'off', 'no-restricted-syntax': 'off', 'no-restricted-imports': 'off' },
  },
  globalIgnores(['.next/**', '.open-next/**', '.wrangler/**', 'out/**', 'build/**', 'next-env.d.ts', 'cloudflare-env.d.ts', 'playwright-report/**', 'test-results/**']),
])

export default eslintConfig

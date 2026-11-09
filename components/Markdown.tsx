import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'

/**
 * Model output as Markdown, never as HTML: raw HTML in the text is dropped
 * (skipHtml), the result is sanitized again, images are not rendered (a
 * picture's URL could carry data out), and links open in a new tab without
 * referrer or opener. tests/unit/markdown.test.tsx feeds it XSS strings.
 */
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter((tag) => tag !== 'img' && tag !== 'input'),
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] },
}

const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow ugc">
      {children}
    </a>
  ),
  img: () => null,
}

export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      skipHtml
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, schema]]}
      components={components}
    >
      {text}
    </ReactMarkdown>
  )
}

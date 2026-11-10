/**
 * Markdown that is still arriving, made safe to render as it is: an answer
 * cut mid-way through `**bold**`, `*italic*`, `` `code` `` or a code block
 * would otherwise show its raw markers until the closing ones arrive (the
 * "**" flashing while an answer streams). Open markers are closed at the end,
 * and markers at the very end that don't balance yet (half of "**", or an
 * opening one before its words) wait for the next chunk. Only for display
 * while streaming; the saved text is untouched.
 */
export function closeOpenMarkdown(text: string): string {
  // A code block still open: close it and leave its inside as it is.
  const fences = text.match(/^ {0,3}```/gm)?.length ?? 0
  if (fences % 2 === 1) return `${text}\n\`\`\``

  let body = text
  if (/[*`]$/.test(body) && !balanced(markers(body))) body = body.replace(/[*`]+$/, '')

  const open = markers(body)
  if (open.ticks % 2 === 1) return `${body}\``
  if (open.single % 2 === 1) body += '*'
  if (open.strong % 2 === 1) body += '**'
  return body
}

interface Markers {
  ticks: number
  strong: number
  single: number
}

/** The emphasis and code markers in the prose (outside fenced code blocks). */
function markers(text: string): Markers {
  const prose = text
    .split(/^ {0,3}```.*$/m)
    .filter((_, i) => i % 2 === 0)
    .join('\n')
  const ticks = prose.match(/`/g)?.length ?? 0
  const plain = prose.replace(/`[^`\n]*`/g, '')
  const strong = plain.match(/\*\*/g)?.length ?? 0
  // A "* " at the start of a line is a list bullet, not emphasis.
  const single =
    plain
      .replace(/\*\*/g, '')
      .replace(/^[ \t]*\*[ \t]/gm, '')
      .match(/\*/g)?.length ?? 0
  return { ticks, strong, single }
}

function balanced(found: Markers): boolean {
  return found.ticks % 2 === 0 && found.strong % 2 === 0 && found.single % 2 === 0
}

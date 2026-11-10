import type { Sql } from './sql'
import { updateMessage, type ChatMessage } from './chats'
import { noteFrom, plainFrom } from './chat-memory'
import { RESEARCH_LIMITS } from '../lib/limits'
import { MEMORY_LIMITS } from '../lib/memory'
import {
  isActive,
  isRunFailure,
  type MessageResearch,
  type RunDetail,
  type RunFailure,
  type RunSource,
  type RunStatus,
  type SearchedWith,
} from '../lib/research'

/**
 * Research in chat, for one person (their agent's SQLite, like
 * agent/chats.ts): a run started from a chat is linked to the two messages it
 * adds there, the question (yours) and Wren's message that shows the run
 * (a card while it goes, then the report).
 *
 * When the run ends, the report is written into Wren's message, and its
 * sources and how it searched are kept here, so the chat keeps the report
 * even after the run is trimmed from the Runs page. The report then counts as
 * Wren's answer in the conversation the model sees, size-capped
 * (RESEARCH_LIMITS.chatHistoryChars), so the chat can carry on about it.
 */

type State = 'live' | 'done' | 'failed' | 'cancelled'

type Row = {
  message_id: string
  ask_id: string
  run_id: string
  question: string
  state: string
  failure: string | null
  sources: string | null
  searched_with: string | null
}

export function createChatResearchTable(sql: Sql): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS chat_research (
    message_id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    ask_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    question TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'done', 'failed', 'cancelled')),
    failure TEXT,
    sources TEXT,
    searched_with TEXT,
    created_at INTEGER NOT NULL
  )`)
  sql.exec('CREATE INDEX IF NOT EXISTS chat_research_by_chat ON chat_research (chat_id)')
  sql.exec('CREATE INDEX IF NOT EXISTS chat_research_by_run ON chat_research (run_id)')
}

/** Links a run to the chat it was started from: the question it asked, and Wren's message that shows it. */
export function linkRun(
  sql: Sql,
  link: { chatId: string; askId: string; messageId: string; runId: string; question: string },
  now = Date.now()
): void {
  sql.exec(
    'INSERT INTO chat_research (message_id, chat_id, ask_id, run_id, question, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    link.messageId,
    link.chatId,
    link.askId,
    link.runId,
    link.question,
    now
  )
}

/** The runs a chat is still waiting on. */
export function liveRuns(sql: Sql, chatId: string): string[] {
  return sql
    .exec<{ run_id: string }>("SELECT run_id FROM chat_research WHERE chat_id = ? AND state = 'live'", chatId)
    .toArray()
    .map((row) => row.run_id)
}

function finish(sql: Sql, row: Pick<Row, 'message_id' | 'run_id'>, state: Exclude<State, 'live'>, change: { failure?: RunFailure; detail?: RunDetail }): void {
  const { failure, detail } = change
  sql.exec(
    "UPDATE chat_research SET state = ?, failure = ?, sources = ?, searched_with = ? WHERE message_id = ? AND state = 'live'",
    state,
    failure ?? null,
    state === 'done' && detail ? JSON.stringify(detail.sources) : null,
    detail?.searchedWith ? JSON.stringify(detail.searchedWith) : null,
    row.message_id
  )
  if (state === 'done' && detail?.report) updateMessage(sql, row.message_id, detail.report, 'done')
  else updateMessage(sql, row.message_id, '', state === 'cancelled' ? 'stopped' : 'error')
}

/**
 * A run started from chat has ended: its report becomes Wren's message, or the
 * message says how it ended. Does nothing for a run that is still going, isn't
 * from a chat, or was written already. Returns the message it wrote, if any.
 */
export function settleRun(sql: Sql, runId: string, detail: RunDetail | null): string | null {
  const row = sql
    .exec<Row>(
      "SELECT message_id, ask_id, run_id, question, state, failure, sources, searched_with FROM chat_research WHERE run_id = ? AND state = 'live'",
      runId
    ).toArray()[0]
  if (!row) return null
  if (!detail) {
    // The run is gone (only finished runs are ever trimmed): nothing to show.
    finish(sql, row, 'failed', { failure: 'internal' })
  } else if (isActive(detail.status)) {
    return null
  } else if (detail.status === 'done' && detail.report) {
    finish(sql, row, 'done', { detail })
  } else if (detail.status === 'cancelled') {
    finish(sql, row, 'cancelled', { detail })
  } else {
    finish(sql, row, 'failed', { failure: detail.failure ?? 'internal', detail })
  }
  return row.message_id
}

function parseSources(json: string | null): RunSource[] {
  if (!json) return []
  try {
    const list = JSON.parse(json) as unknown
    return Array.isArray(list) ? (list as RunSource[]) : []
  } catch {
    return []
  }
}

function parseSearched(json: string | null): SearchedWith | null {
  if (!json) return null
  try {
    return JSON.parse(json) as SearchedWith
  } catch {
    return null
  }
}

/** A run still going, as the chat shows it. */
export type LiveRun = Pick<RunDetail, 'status' | 'searchedWith'>

/**
 * A chat's research marks: what each of Wren's research messages shows (by
 * message id), and which of your messages asked for a run. `live` gives a
 * running run's status; settle finished runs first (settleRun).
 */
export function researchMarks(
  sql: Sql,
  chatId: string,
  live: (runId: string) => LiveRun | null
): { cards: Map<string, MessageResearch>; asks: Set<string> } {
  const rows = sql
    .exec<Row>(
      'SELECT message_id, ask_id, run_id, question, state, failure, sources, searched_with FROM chat_research WHERE chat_id = ? ORDER BY created_at',
      chatId
    ).toArray()
  const cards = new Map<string, MessageResearch>()
  const asks = new Set<string>()
  for (const row of rows) {
    asks.add(row.ask_id)
    const running = row.state === 'live' ? live(row.run_id) : null
    const status: RunStatus = running ? running.status : row.state === 'live' ? 'failed' : (row.state as RunStatus)
    cards.set(row.message_id, {
      runId: row.run_id,
      question: row.question,
      status,
      failure: isRunFailure(row.failure) ? row.failure : status === 'failed' ? 'internal' : null,
      sources: parseSources(row.sources),
      searchedWith: running ? running.searchedWith : parseSearched(row.searched_with),
    })
  }
  return { cards, asks }
}

/** Messages with their research marks. */
export function withResearch(messages: ChatMessage[], marks: ReturnType<typeof researchMarks>): ChatMessage[] {
  return messages.map((message) => {
    const research = marks.cards.get(message.id)
    if (research) return { ...message, research }
    return marks.asks.has(message.id) ? { ...message, asksResearch: true } : message
  })
}

/** The research behind one of Wren's messages, if it shows a run. */
export function researchFor(sql: Sql, messageId: string): { question: string; state: State; sources: RunSource[] } | null {
  const row = sql
    .exec<Row>(
      'SELECT message_id, ask_id, run_id, question, state, failure, sources, searched_with FROM chat_research WHERE message_id = ?',
      messageId
    ).toArray()[0]
  return row ? { question: row.question, state: row.state as State, sources: parseSources(row.sources) } : null
}

/** Cuts text to at most `max` characters, at a word where it can, marking the cut. */
function cut(text: string, max: number, mark = '…'): string {
  if (text.length <= max) return text
  const head = text.slice(0, Math.max(0, max - mark.length))
  const atSpace = head.lastIndexOf(' ')
  return `${(atSpace > head.length - 200 ? head.slice(0, atSpace) : head).trimEnd()}${mark}`
}

function sourceLines(sources: RunSource[], withAddress: boolean): string {
  return sources
    .map((s) => `[${s.n}] ${cut(s.title.replace(/\s+/g, ' ').trim(), 140)}${withAddress ? ` - ${s.url}` : ` (${s.host})`}`)
    .join('\n')
}

/**
 * A report as Wren's turn in the conversation the model sees: what was
 * researched, the report (shortened if it is long) and its sources, within
 * RESEARCH_LIMITS.chatHistoryChars all told.
 */
export function reportForHistory(question: string, report: string, sources: RunSource[]): string {
  const head = `Research report on "${cut(question, RESEARCH_LIMITS.questionChars)}", written from the web pages I read:`
  const tail = sources.length ? `Sources:\n${sourceLines(sources, false)}` : ''
  const room = RESEARCH_LIMITS.chatHistoryChars - head.length - tail.length - 4
  return [head, cut(report.trim(), Math.max(200, room), '… (report shortened)'), tail].filter(Boolean).join('\n\n').slice(0, RESEARCH_LIMITS.chatHistoryChars)
}

/**
 * The chat as the model should see it: each research report in place of its
 * message, size-capped, with its sources. Runs still going, failed or
 * stopped have no text and are left out, as an empty answer is.
 */
export function forHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    const research = message.research
    if (!research || research.status !== 'done' || !message.content) return message
    return { ...message, content: reportForHistory(research.question, message.content, research.sources) }
  })
}

/**
 * "Save findings to Memory": the question, the report as plain text and the
 * pages it cites, as one note of at most MEMORY_LIMITS.noteChars. The sources
 * always fit; the report is shortened if it must be.
 */
export function findingsNote(question: string, report: string, sources: RunSource[]): string {
  const cited = sources.filter((s) => s.cited)
  const head = `Research: ${cut(question.replace(/\s+/g, ' ').trim(), 300)}`
  const tail = cited.length ? `Sources:\n${sourceLines(cited, true)}` : ''
  const room = MEMORY_LIMITS.noteChars - head.length - tail.length - 4
  const body = cut(plainFrom(report), Math.max(300, room))
  return noteFrom([head, body, tail].filter(Boolean).join('\n\n'))
}

/** Links whose messages are gone (a deleted chat, old messages trimmed). */
export function pruneChatResearch(sql: Sql): void {
  sql.exec('DELETE FROM chat_research WHERE message_id NOT IN (SELECT id FROM messages)')
}

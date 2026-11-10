import { describe, expect, it } from 'vitest'
import {
  createChatResearchTable,
  findingsNote,
  forHistory,
  linkRun,
  liveRuns,
  pruneChatResearch,
  reportForHistory,
  researchFor,
  researchMarks,
  settleRun,
  withResearch,
} from '../../agent/chat-research'
import { addMessage, createChat, createChatTables, deleteChat, historyForModel, listMessages } from '../../agent/chats'
import { addStep, createResearchTables, createRun, runDetail, updateRun } from '../../agent/research-store'
import { RESEARCH_LIMITS } from '../../lib/limits'
import { MEMORY_LIMITS } from '../../lib/memory'
import { searchedWithLine, type RunDetail, type RunSource } from '../../lib/research'
import { memorySql } from '../support/sql'

function store() {
  const sql = memorySql()
  createChatTables(sql)
  createResearchTables(sql)
  createChatResearchTable(sql)
  return sql
}

/** A chat with a run started from it: the question, Wren's (empty) message for the run, and the link. */
function started(sql: ReturnType<typeof store>, question = 'What should I look for in an e-bike?') {
  const chat = createChat(sql, 'E-bikes')
  const ask = addMessage(sql, chat.id, 'user', question)
  const card = addMessage(sql, chat.id, 'model', '', 'done')
  const run = createRun(sql, question, '2026-11-10')
  linkRun(sql, { chatId: chat.id, askId: ask.id, messageId: card.id, runId: run.id, question })
  return { chat, ask, card, run }
}

const SOURCES: RunSource[] = [
  { n: 1, url: 'https://pedalwise.org/guide', title: 'How to buy an e-bike', host: 'pedalwise.org', cited: true },
  { n: 2, url: 'https://batterylab.io/safety', title: 'Battery safety', host: 'batterylab.io', cited: true },
  { n: 3, url: 'https://citycycling.co/motors', title: 'Motors explained', host: 'citycycling.co', cited: false },
]

function finishRun(sql: ReturnType<typeof store>, runId: string, report: string): RunDetail {
  sql.exec(
    "INSERT INTO research_pages (run_id, page_key, url, title, host, search_index, position, state, n, cited) VALUES (?, 'a', ?, ?, ?, 0, 0, 'read', 1, 1)",
    runId,
    SOURCES[0].url,
    SOURCES[0].title,
    SOURCES[0].host
  )
  addStep(sql, runId, { kind: 'search', label: 'e-bike guide', detail: '5 results from Tavily', provider: 'tavily' })
  updateRun(sql, runId, { status: 'done', report })
  return runDetail(sql, runId) as RunDetail
}

describe('a run started from chat', () => {
  it('shows as live on Wren’s message while it goes, and your message is marked as the question', () => {
    const sql = store()
    const { chat, ask, card, run } = started(sql)
    updateRun(sql, run.id, { status: 'searching' })
    expect(settleRun(sql, run.id, runDetail(sql, run.id))).toBeNull()
    expect(liveRuns(sql, chat.id)).toEqual([run.id])

    const marks = researchMarks(sql, chat.id, (id) => runDetail(sql, id))
    const messages = withResearch(listMessages(sql, chat.id), marks)
    expect(messages.find((m) => m.id === ask.id)?.asksResearch).toBe(true)
    const shown = messages.find((m) => m.id === card.id)
    expect(shown?.research).toMatchObject({ runId: run.id, status: 'searching', failure: null, sources: [] })
    expect(shown?.content).toBe('')
  })

  it('lands its report in Wren’s message when it is done, once', () => {
    const sql = store()
    const { chat, card, run } = started(sql)
    const detail = finishRun(sql, run.id, 'Get a certified battery [1].')
    expect(settleRun(sql, run.id, detail)).toBe(card.id)
    expect(settleRun(sql, run.id, detail)).toBeNull()

    const message = listMessages(sql, chat.id).find((m) => m.id === card.id)
    expect(message).toMatchObject({ content: 'Get a certified battery [1].', status: 'done' })
    const research = researchMarks(sql, chat.id, () => null).cards.get(card.id)
    expect(research).toMatchObject({ status: 'done', failure: null })
    expect(research?.sources.map((s) => s.url)).toEqual([SOURCES[0].url])
    expect(searchedWithLine(research?.searchedWith ?? null)).toBe('Searched with Tavily')
    expect(liveRuns(sql, chat.id)).toEqual([])
    // Still there after the run itself is gone from the Runs page.
    sql.exec('DELETE FROM research_runs WHERE id = ?', run.id)
    expect(researchMarks(sql, chat.id, () => null).cards.get(card.id)?.status).toBe('done')
  })

  it('says how it ended when it failed or was cancelled, with no text for the model', () => {
    const sql = store()
    const failed = started(sql)
    updateRun(sql, failed.run.id, { status: 'failed', failure: 'no_sources' })
    settleRun(sql, failed.run.id, runDetail(sql, failed.run.id))
    expect(researchMarks(sql, failed.chat.id, () => null).cards.get(failed.card.id)).toMatchObject({ status: 'failed', failure: 'no_sources' })
    expect(listMessages(sql, failed.chat.id).find((m) => m.id === failed.card.id)?.status).toBe('error')

    const cancelled = started(sql)
    updateRun(sql, cancelled.run.id, { status: 'cancelled' })
    settleRun(sql, cancelled.run.id, runDetail(sql, cancelled.run.id))
    expect(researchMarks(sql, cancelled.chat.id, () => null).cards.get(cancelled.card.id)?.status).toBe('cancelled')
    expect(listMessages(sql, cancelled.chat.id).find((m) => m.id === cancelled.card.id)?.status).toBe('stopped')

    // A run that vanished while the chat still waited on it reads as failed, never as running forever.
    const vanished = started(sql)
    settleRun(sql, vanished.run.id, null)
    expect(researchMarks(sql, vanished.chat.id, () => null).cards.get(vanished.card.id)).toMatchObject({ status: 'failed', failure: 'internal' })
  })

  it('a done run without a report counts as failed', () => {
    const sql = store()
    const { chat, card, run } = started(sql)
    updateRun(sql, run.id, { status: 'done' })
    settleRun(sql, run.id, runDetail(sql, run.id))
    expect(researchMarks(sql, chat.id, () => null).cards.get(card.id)?.status).toBe('failed')
  })

  it('is forgotten with its chat', () => {
    const sql = store()
    const { chat, card } = started(sql)
    deleteChat(sql, chat.id)
    pruneChatResearch(sql)
    expect(researchFor(sql, card.id)).toBeNull()
  })
})

describe('the report in the conversation the model sees', () => {
  it('stands in for Wren’s message, with the question and its sources', () => {
    const sql = store()
    const { chat, card, run } = started(sql)
    settleRun(sql, run.id, finishRun(sql, run.id, 'Get a certified battery [1].'))
    addMessage(sql, chat.id, 'user', 'Which of those matters most?')
    const marks = researchMarks(sql, chat.id, () => null)
    const history = historyForModel(forHistory(withResearch(listMessages(sql, chat.id), marks)))
    expect(history.map((turn) => turn.role)).toEqual(['user', 'model', 'user'])
    expect(history[1].text).toContain('Research report on "What should I look for in an e-bike?"')
    expect(history[1].text).toContain('Get a certified battery [1].')
    expect(history[1].text).toContain('[1] How to buy an e-bike (pedalwise.org)')
    expect(listMessages(sql, chat.id).find((m) => m.id === card.id)?.content).toBe('Get a certified battery [1].')
  })

  it('is capped, however long the report', () => {
    const report = `${'A long finding about batteries and brakes. '.repeat(1_000)}The end.`
    const text = reportForHistory('e-bikes?', report, SOURCES)
    expect(text.length).toBeLessThanOrEqual(RESEARCH_LIMITS.chatHistoryChars)
    expect(text).toContain('(report shortened)')
    expect(text).not.toContain('The end.')
    // The sources always make it.
    expect(text).toContain('[3] Motors explained (citycycling.co)')
  })

  it('leaves out a run still going, failed or stopped', () => {
    const sql = store()
    const { chat, run } = started(sql)
    updateRun(sql, run.id, { status: 'reading' })
    const marks = researchMarks(sql, chat.id, (id) => runDetail(sql, id))
    expect(historyForModel(forHistory(withResearch(listMessages(sql, chat.id), marks)))).toEqual([
      { role: 'user', text: 'What should I look for in an e-bike?' },
    ])
  })
})

describe('Save findings to Memory', () => {
  it('keeps the question, the report as plain text and the cited sources', () => {
    const note = findingsNote('e-bikes under $1,500?', '## What to check\n\n- **Battery**: certified [1]\n- Brakes [2]', SOURCES)
    expect(note).toBe(
      [
        'Research: e-bikes under $1,500?',
        'What to check\n\n• Battery: certified [1]\n• Brakes [2]',
        'Sources:\n[1] How to buy an e-bike - https://pedalwise.org/guide\n[2] Battery safety - https://batterylab.io/safety',
      ].join('\n\n')
    )
  })

  it('fits in one note, shortening the report and never the sources', () => {
    const note = findingsNote('e-bikes?', 'Batteries matter a great deal. '.repeat(500), SOURCES)
    expect(note.length).toBeLessThanOrEqual(MEMORY_LIMITS.noteChars)
    expect(note).toMatch(/…\n\nSources:/)
    expect(note.endsWith('[2] Battery safety - https://batterylab.io/safety')).toBe(true)
  })
})

describe('which service searched', () => {
  it('is kept with each search and summed up for the run', () => {
    const sql = store()
    const run = createRun(sql, 'q', '2026-11-10')
    addStep(sql, run.id, { kind: 'search', label: 'a', detail: '5 results from Tavily', provider: 'tavily' })
    addStep(sql, run.id, { kind: 'search', label: 'b', detail: '2 results from Google Search', provider: 'google', backupReason: 'out_of_credits' })
    const detail = runDetail(sql, run.id)
    expect(detail?.searchedWith).toEqual({ tavily: 1, google: 1, backupReason: 'out_of_credits' })
    expect(detail?.steps.map((s) => s.provider)).toEqual(['tavily', 'google'])
    expect(searchedWithLine(detail?.searchedWith ?? null)).toBe('Searched with Tavily, then Google Search (Tavily is out of credits)')
    expect(searchedWithLine({ tavily: 0, google: 3, backupReason: 'error' })).toBe('Searched with Google Search (Tavily didn’t answer)')
    expect(searchedWithLine({ tavily: 0, google: 3, backupReason: 'no_key' })).toBe('Searched with Google Search')
    expect(searchedWithLine(null)).toBeNull()
  })

  it('adds its columns to a database from before they existed', () => {
    const sql = memorySql()
    sql.exec(`CREATE TABLE research_steps (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL,
      detail TEXT, url TEXT, created_at INTEGER NOT NULL)`)
    createResearchTables(sql)
    createResearchTables(sql)
    const columns = sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('research_steps')").toArray().map((c) => c.name)
    expect(columns).toEqual(expect.arrayContaining(['provider', 'backup_reason']))
  })
})

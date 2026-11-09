import { describe, expect, it } from 'vitest'
import {
  addMessage,
  createChat,
  createChatTables,
  deleteChat,
  dropLastAnswer,
  getChat,
  historyForModel,
  listChats,
  listMessages,
  titleFrom,
  type ChatMessage,
} from '../../agent/chats'
import { SIZE_LIMITS } from '../../lib/limits'
import { memorySql } from '../support/sql'

function store() {
  const sql = memorySql()
  createChatTables(sql)
  return sql
}

describe('chat store', () => {
  it('keeps chats and their messages in order', () => {
    const sql = store()
    const chat = createChat(sql, 'First', 1)
    addMessage(sql, chat.id, 'user', 'hi', 'done', 2)
    addMessage(sql, chat.id, 'model', 'hello', 'done', 3)
    expect(listMessages(sql, chat.id).map((m) => m.content)).toEqual(['hi', 'hello'])
    expect(listChats(sql)[0]).toMatchObject({ id: chat.id, updatedAt: 3 })
  })

  it('stores hostile text as data, not SQL', () => {
    const sql = store()
    const chat = createChat(sql, "x'); DROP TABLE chats; --")
    addMessage(sql, chat.id, 'user', "' OR 1=1 --")
    expect(getChat(sql, chat.id)?.title).toBe("x'); DROP TABLE chats; --")
    expect(listMessages(sql, chat.id)[0].content).toBe("' OR 1=1 --")
    expect(getChat(sql, "' OR '1'='1")).toBeNull()
  })

  it('deletes a chat with its messages', () => {
    const sql = store()
    const chat = createChat(sql, 'Gone')
    addMessage(sql, chat.id, 'user', 'hi')
    expect(deleteChat(sql, chat.id)).toBe(true)
    expect(getChat(sql, chat.id)).toBeNull()
    expect(listMessages(sql, chat.id)).toEqual([])
    expect(deleteChat(sql, chat.id)).toBe(false)
  })

  it('caps messages per chat, dropping the oldest', () => {
    const sql = store()
    const chat = createChat(sql, 'Long')
    for (let i = 0; i < SIZE_LIMITS.messagesPerChat + 5; i++) addMessage(sql, chat.id, 'user', `m${i}`)
    const messages = listMessages(sql, chat.id)
    expect(messages).toHaveLength(SIZE_LIMITS.messagesPerChat)
    expect(messages[0].content).toBe('m5')
  })

  it('regenerate drops the last answer and returns the prompt it answered', () => {
    const sql = store()
    const chat = createChat(sql, 'Again')
    addMessage(sql, chat.id, 'user', 'question')
    addMessage(sql, chat.id, 'model', 'answer')
    expect(dropLastAnswer(sql, chat.id)?.content).toBe('question')
    expect(listMessages(sql, chat.id).map((m) => m.role)).toEqual(['user'])
  })
})

describe('titles and history', () => {
  it('makes a one-line title, shortened at a word', () => {
    expect(titleFrom('  Sizing a\nheat pump  ')).toBe('Sizing a heat pump')
    const long = titleFrom('word '.repeat(40))
    expect(long.length).toBeLessThanOrEqual(SIZE_LIMITS.titleChars)
    expect(long.endsWith('…')).toBe(true)
  })

  it('sends the newest turns that fit, starting with a user turn', () => {
    const big = 'x'.repeat(SIZE_LIMITS.historyChars / 2)
    const messages: ChatMessage[] = ['user', 'model', 'user', 'model', 'user'].map((role, i) => ({
      id: String(i),
      role: role as 'user' | 'model',
      content: i < 2 ? big : `turn ${i}`,
      status: 'done',
      createdAt: i,
    }))
    const history = historyForModel(messages)
    expect(history[0].role).toBe('user')
    expect(history.at(-1)?.text).toBe('turn 4')
    expect(history.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(SIZE_LIMITS.historyChars)
  })
})

'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@/agent/chats'
import type { RecalledMemory } from '@/lib/memory'
import type { RunDetail } from '@/lib/research'
import { Icon } from '../Icons'
import { Markdown } from '../Markdown'
import { WrenMark } from '../WrenMark'
import { RecallChips, SaveToMemory, SavedLines, type ThreadMemory } from './ChatMemory'
import { ResearchAnswer, type ResearchMessage } from './ResearchCard'

export interface StreamingAnswer {
  chatId: string | null
  text: string
  /** The memories Wren recalled for this answer (signed in). */
  recalled?: RecalledMemory[]
}

function Answer({
  message,
  streaming,
  isLast,
  busy,
  memory,
  onRegenerate,
  onResearchThis,
}: {
  message: Pick<ChatMessage, 'id' | 'content' | 'memory'> & { status: ChatMessage['status'] | 'streaming'; recalled?: RecalledMemory[] }
  streaming: boolean
  isLast: boolean
  busy: boolean
  memory: ThreadMemory | null
  onRegenerate: () => void
  onResearchThis: (messageId: string) => void
}) {
  const recalled = message.recalled ?? message.memory?.recalled
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked; nothing to do.
    }
  }
  return (
    <div className="k" data-testid="answer" data-status={message.status}>
      <div className="who2">
        <WrenMark size={20} state={streaming ? 'thinking' : 'still'} />
        <span>Wren</span>
        {message.status === 'stopped' && <span className="st">Stopped</span>}
        {message.status === 'error' && <span className="st err">Cut off</span>}
      </div>
      <div className="md">
        {message.content ? <Markdown text={message.content} /> : null}
        {streaming && <span className="caret" aria-hidden="true" />}
      </div>
      {/* Under the answer, where reading ends: chips that arrive after it don't move the text. */}
      {memory && recalled && recalled.length > 0 && <RecallChips memories={recalled} />}
      {!streaming && (
        <div className="acts">
          <button type="button" onClick={copy}>
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          {isLast && (
            <button type="button" onClick={onRegenerate} disabled={busy} data-testid="regenerate">
              <Icon name="redo" />
              Regenerate
            </button>
          )}
          <button type="button" className="res hide-phone" onClick={() => onResearchThis(message.id)} data-testid="research-this">
            <Icon name="res" />
            Research this
          </button>
          {memory && <SaveToMemory messageId={message.id} savedAs={message.memory?.savedAs} memory={memory} />}
        </div>
      )}
    </div>
  )
}

export function Thread({
  messages,
  streaming,
  busy,
  memory,
  researchLimit,
  onRegenerate,
  onResearchThis,
  onResearchSettled,
  onResearchRetry,
}: {
  messages: ChatMessage[]
  streaming: StreamingAnswer | null
  busy: boolean
  /** Memory in chat; null for guests. */
  memory: ThreadMemory | null
  /** Research runs a day. */
  researchLimit: number
  onRegenerate: () => void
  /** "Research this" on an answer: the question it answered goes into the composer, ready to research. */
  onResearchThis: (messageId: string) => void
  /** A run started from chat has ended. */
  onResearchSettled: (messageId: string, run: RunDetail) => void
  onResearchRetry: (question: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming?.text])

  const lastModel = [...messages].reverse().find((m) => m.role === 'model')
  return (
    <div
      className="thread"
      ref={ref}
      data-testid="thread"
      onScroll={(event) => {
        const el = event.currentTarget
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
    >
      <div className="col" aria-live="polite" aria-busy={streaming ? true : undefined}>
        {messages.map((message) =>
          message.role === 'user' ? (
            <div className="uturn" key={message.id}>
              {message.asksResearch && (
                <span className="ask-res" data-testid="research-ask">
                  <Icon name="res" />
                  Research
                </span>
              )}
              <div className="urow">
                {memory && !message.id.startsWith('pending-') && (
                  <SaveToMemory messageId={message.id} savedAs={message.memory?.savedAs} memory={memory} compact />
                )}
                <div className="u" data-testid="user-message">
                  {message.content}
                </div>
              </div>
              {memory && message.memory?.saves && message.memory.saves.length > 0 && (
                <SavedLines saves={message.memory.saves} memory={memory} />
              )}
            </div>
          ) : message.research ? (
            <ResearchAnswer
              key={message.id}
              message={message as ResearchMessage}
              memory={memory}
              researchLimit={researchLimit}
              onSettled={onResearchSettled}
              onRetry={onResearchRetry}
            />
          ) : (
            <Answer
              key={message.id}
              message={message}
              streaming={false}
              isLast={!streaming && message === lastModel && messages.at(-1) === message}
              busy={busy}
              memory={memory}
              onRegenerate={onRegenerate}
              onResearchThis={onResearchThis}
            />
          )
        )}
        {streaming && (
          <Answer
            message={{ id: 'streaming', content: streaming.text, status: 'streaming', recalled: streaming.recalled }}
            streaming
            isLast={false}
            busy
            memory={memory}
            onRegenerate={onRegenerate}
            onResearchThis={onResearchThis}
          />
        )}
      </div>
    </div>
  )
}

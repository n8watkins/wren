'use client'

import { useEffect, useRef, useState } from 'react'
import type { ChatMessage } from '@/agent/chats'
import { Icon } from '../Icons'
import { Markdown } from '../Markdown'
import { WrenMark } from '../WrenMark'

export interface StreamingAnswer {
  chatId: string | null
  text: string
}

function Answer({
  message,
  streaming,
  isLast,
  busy,
  onRegenerate,
  onExplain,
}: {
  message: { content: string; status: ChatMessage['status'] | 'streaming' }
  streaming: boolean
  isLast: boolean
  busy: boolean
  onRegenerate: () => void
  onExplain: (id: 'research' | 'memory') => void
}) {
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
          <button type="button" className="res hide-phone" onClick={() => onExplain('research')}>
            <Icon name="res" />
            Research this
          </button>
          <button type="button" className="mem" onClick={() => onExplain('memory')}>
            <Icon name="mem" />
            Save to memory
          </button>
        </div>
      )}
    </div>
  )
}

export function Thread({
  messages,
  streaming,
  busy,
  onRegenerate,
  onExplain,
}: {
  messages: ChatMessage[]
  streaming: StreamingAnswer | null
  busy: boolean
  onRegenerate: () => void
  onExplain: (id: 'research' | 'memory') => void
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
            <div className="u" key={message.id} data-testid="user-message">
              {message.content}
            </div>
          ) : (
            <Answer
              key={message.id}
              message={message}
              streaming={false}
              isLast={!streaming && message === lastModel && messages.at(-1) === message}
              busy={busy}
              onRegenerate={onRegenerate}
              onExplain={onExplain}
            />
          )
        )}
        {streaming && (
          <Answer
            message={{ content: streaming.text, status: 'streaming' }}
            streaming
            isLast={false}
            busy
            onRegenerate={onRegenerate}
            onExplain={onExplain}
          />
        )}
      </div>
    </div>
  )
}

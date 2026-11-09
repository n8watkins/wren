'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { SIZE_LIMITS } from '@/lib/limits'
import { Icon } from '../Icons'

/**
 * The composer: typing and the mic always side by side, plus Research. On a
 * desktop it is the boxed composer; on a phone the rounded bar with the big
 * mic within thumb reach (globals.css shows one or the other).
 */
export function Composer({
  draft,
  setDraft,
  busy,
  error,
  onDismissError,
  onSend,
  onStop,
  onExplain,
  focusKey,
}: {
  draft: string
  setDraft: (value: string) => void
  busy: boolean
  error: string | null
  onDismissError: () => void
  onSend: () => void
  onStop: () => void
  onExplain: (id: 'mic' | 'research' | 'memory') => void
  focusKey: number
}) {
  const desk = useRef<HTMLTextAreaElement>(null)
  const phone = useRef<HTMLTextAreaElement>(null)
  const canSend = draft.trim().length > 0 && !busy

  useEffect(() => {
    for (const el of [desk.current, phone.current]) {
      if (!el) continue
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    }
  }, [draft])

  useEffect(() => {
    if (focusKey === 0) return
    const visible = [desk.current, phone.current].find((el) => el && el.offsetParent !== null)
    visible?.focus()
  }, [focusKey])

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (window.matchMedia('(pointer: coarse)').matches) return
    event.preventDefault()
    if (canSend) onSend()
  }

  const alert = error ? (
    <div className="alert" role="alert" data-testid="chat-error">
      <Icon name="alert" />
      <p>{error}</p>
      <button type="button" onClick={onDismissError} aria-label="Dismiss">
        <Icon name="x" />
      </button>
    </div>
  ) : null

  const sendOrStop = busy ? (
    <button type="button" className="send stop" onClick={onStop} aria-label="Stop answering" data-testid="stop">
      <Icon name="stop" />
    </button>
  ) : (
    <button
      type="button"
      className={canSend ? 'send go' : 'send'}
      onClick={onSend}
      disabled={!canSend}
      aria-label="Send message"
      data-testid="send"
    >
      <Icon name="send" />
    </button>
  )

  return (
    <>
      <div className="composer">
        {alert}
        <div className="cbox">
          <label className="sr-only" htmlFor="composer-desk">
            Message Wren
          </label>
          <textarea
            id="composer-desk"
            ref={desk}
            rows={1}
            value={draft}
            maxLength={SIZE_LIMITS.messageChars}
            placeholder="Message Wren, or tap the mic and just talk"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="composer"
          />
          <div className="crow">
            <button type="button" className="cbtn icon" onClick={() => onExplain('memory')} aria-label="Attach a file (next update)">
              <Icon name="clip" />
            </button>
            <button type="button" className="cbtn res" onClick={() => onExplain('research')} data-tip="res">
              <Icon name="res" />
              Research
            </button>
            <span className="sp" />
            <button type="button" className="mic" onClick={() => onExplain('mic')} aria-label="Talk (next update)" data-tip="mic">
              <Icon name="mic" />
            </button>
            {sendOrStop}
          </div>
        </div>
        <div className="hint">Wren can be wrong. Check anything that matters.</div>
      </div>
      <div className="mcomp">
        {alert}
        <div className="mcb">
          <button type="button" className="rb" onClick={() => onExplain('research')} aria-label="Research (next update)" data-tip="res">
            <Icon name="res" />
          </button>
          <label className="sr-only" htmlFor="composer-phone">
            Message Wren
          </label>
          <textarea
            id="composer-phone"
            ref={phone}
            rows={1}
            value={draft}
            maxLength={SIZE_LIMITS.messageChars}
            placeholder="Message or talk"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="composer-phone"
          />
          <button type="button" className="mic" onClick={() => onExplain('mic')} aria-label="Talk (next update)" data-tip="mic">
            <Icon name="mic" />
          </button>
          {(busy || draft.trim()) && sendOrStop}
        </div>
      </div>
    </>
  )
}

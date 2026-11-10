'use client'

import { useEffect, useRef, type KeyboardEvent } from 'react'
import { RESEARCH_LIMITS, SIZE_LIMITS } from '@/lib/limits'
import { Icon } from '../Icons'
import type { VoiceView } from './useVoice'
import { VoicePanel } from './VoicePanel'

/** Research mode in the composer: on, and how many of today's runs are left. */
export interface ComposerResearch {
  on: boolean
  left: number
  limit: number
  starting: boolean
}

/** The line under the composer in research mode. */
function researchHint(research: ComposerResearch, tooLong: boolean): string {
  if (tooLong) return `A research question is up to ${RESEARCH_LIMITS.questionChars} characters.`
  if (research.left <= 0) return 'No research runs left today. They come back at midnight UTC.'
  return `Wren searches the web, reads the pages and cites them. ${research.left} of ${research.limit} runs left today.`
}

/**
 * The composer: typing and the mic always side by side, plus Research. On a
 * desktop it is the boxed composer; on a phone the rounded bar with the big
 * mic within thumb reach (globals.css shows one or the other). While Wren is
 * listening, the listening view sits on top and typing still works.
 *
 * Research turns the composer into research mode (saffron): what you send
 * starts a research run in this chat instead of a message.
 */
export function Composer({
  draft,
  setDraft,
  busy,
  error,
  onDismissError,
  onSignIn,
  onSend,
  onStop,
  onExplain,
  research,
  onResearch,
  voice,
  onMic,
  focusKey,
}: {
  draft: string
  setDraft: (value: string) => void
  busy: boolean
  error: { message: string; signIn: boolean; info?: boolean } | null
  onDismissError: () => void
  onSignIn: () => void
  onSend: () => void
  onStop: () => void
  onExplain: (id: 'research' | 'memory') => void
  research: ComposerResearch
  /** Turns research mode on or off (a guest is asked to sign in). */
  onResearch: () => void
  /** The voice session, while there is one. */
  voice: VoiceView | null
  /** Starts talking, or ends it. */
  onMic: () => void
  focusKey: number
}) {
  const desk = useRef<HTMLTextAreaElement>(null)
  const phone = useRef<HTMLTextAreaElement>(null)
  const question = draft.trim()
  const researching = research.on && !voice
  const tooLong = researching && question.length > RESEARCH_LIMITS.questionChars
  const canSend = researching
    ? question.length >= 3 && !tooLong && !busy && !research.starting && research.left > 0
    : question.length > 0 && !busy

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
    <div className={error.info ? 'alert info' : 'alert'} role="alert" data-testid="chat-error">
      <Icon name={error.info ? 'mic' : 'alert'} />
      <p>{error.message}</p>
      {error.signIn && (
        <button type="button" className="btn pri" onClick={onSignIn} data-testid="error-sign-in">
          Sign in
        </button>
      )}
      <button type="button" className="dismiss" onClick={onDismissError} aria-label="Dismiss">
        <Icon name="x" />
      </button>
    </div>
  ) : null

  const sendOrStop = researching ? (
    <button
      type="button"
      className={canSend ? 'send go res' : 'send res'}
      onClick={onSend}
      disabled={!canSend}
      aria-label="Start research"
      title="Start research"
      data-testid="send"
    >
      <Icon name="res" />
    </button>
  ) : busy ? (
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

  const mic = (
    <button
      type="button"
      className={voice ? 'mic on' : 'mic'}
      onClick={onMic}
      aria-label={voice ? 'End voice' : 'Talk to Wren'}
      aria-pressed={voice !== null}
      title={voice ? 'End voice' : 'Talk to Wren'}
      data-tip="mic"
      data-testid="mic"
    >
      <Icon name="mic" />
    </button>
  )
  const panel = voice ? <VoicePanel view={voice} onEnd={onMic} /> : null
  const placeholder = researching ? 'What should Wren research?' : null
  const researchToggle = {
    onClick: onResearch,
    'aria-pressed': researching,
    'data-tip': 'res',
    'data-testid': 'research-toggle',
  } as const

  return (
    <>
      <div className="composer">
        {alert}
        {panel}
        <div className={researching ? 'cbox research' : 'cbox'}>
          <label className="sr-only" htmlFor="composer-desk">
            Message Wren
          </label>
          <textarea
            id="composer-desk"
            ref={desk}
            rows={1}
            value={draft}
            maxLength={SIZE_LIMITS.messageChars}
            placeholder={placeholder ?? (voice ? 'Type to Wren while you talk' : 'Message Wren, or tap the mic and just talk')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="composer"
          />
          <div className="crow">
            <button type="button" className="cbtn icon" onClick={() => onExplain('memory')} aria-label="Attach a file (next update)">
              <Icon name="clip" />
            </button>
            <button type="button" className={researching ? 'cbtn res on' : 'cbtn res'} {...researchToggle}>
              <Icon name={researching ? 'check' : 'res'} />
              Research
            </button>
            <span className="sp" />
            {mic}
            {sendOrStop}
          </div>
        </div>
        <div className={researching ? 'hint res' : 'hint'} data-testid={researching ? 'research-hint' : undefined}>
          {researching ? researchHint(research, tooLong) : 'Wren can be wrong. Check anything that matters.'}
        </div>
      </div>
      <div className="mcomp">
        {alert}
        {panel}
        {researching && (
          <div className="mhint res" data-testid="research-hint">
            {researchHint(research, tooLong)}
          </div>
        )}
        <div className={researching ? 'mcb research' : 'mcb'}>
          <button type="button" className={researching ? 'rb on' : 'rb'} aria-label="Research" {...researchToggle}>
            <Icon name={researching ? 'check' : 'res'} />
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
            placeholder={placeholder ?? (voice ? 'Type while you talk' : 'Message or talk')}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            data-testid="composer-phone"
          />
          {mic}
          {(busy || researching || draft.trim()) && sendOrStop}
        </div>
      </div>
    </>
  )
}

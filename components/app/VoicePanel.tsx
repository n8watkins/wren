'use client'

import { useEffect, useState } from 'react'
import { Icon } from '../Icons'
import { WrenMark, type WrenState } from '../WrenMark'
import type { VoiceView } from './useVoice'

const LABELS = {
  connecting: 'Connecting…',
  listening: 'Listening',
  thinking: 'Thinking…',
  talking: 'Wren is talking',
} as const

const MARK: Record<VoiceView['status'], WrenState> = {
  connecting: 'thinking',
  listening: 'listening',
  thinking: 'thinking',
  talking: 'talking',
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/** Today's voice time left, counting down between the server's updates. */
function Left({ left, ownKey }: { left: VoiceView['left']; ownKey: boolean }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!left) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [left])
  if (ownKey) return <span className="vleft">Your key</span>
  if (!left) return null
  const seconds = left.seconds - Math.max(0, (now - left.at) / 1000)
  return (
    <span className={seconds <= 60 ? 'vleft low' : 'vleft'} data-testid="voice-left" title="Voice time left today on the demo key">
      {clock(seconds)} left
    </span>
  )
}

/** The listening view: what Wren is doing, the words so far, time left, and End. */
export function VoicePanel({ view, onEnd }: { view: VoiceView; onEnd: () => void }) {
  const hint =
    view.status === 'connecting'
      ? 'Opening the mic and connecting to Wren'
      : view.status === 'talking'
        ? 'Start talking to interrupt'
        : 'Talk any time, or type below'
  return (
    <div className="voice" role="status" data-testid="voice-panel" data-status={view.status}>
      <span className="vmark" aria-hidden="true">
        <WrenMark size={26} state={MARK[view.status]} />
      </span>
      <div className="vtext">
        <b data-testid="voice-status">{LABELS[view.status]}</b>
        <span className={view.interim ? `vline ${view.interim.role}` : 'vline'} data-testid="voice-interim">
          <span>{view.interim ? view.interim.text : hint}</span>
        </span>
      </div>
      <Left left={view.left} ownKey={view.ownKey} />
      <button type="button" className="vend" onClick={onEnd} data-testid="voice-end">
        <Icon name="stop" />
        End
      </button>
    </div>
  )
}

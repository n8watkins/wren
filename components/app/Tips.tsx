'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExplainerId } from '../explainers'
import { Icon } from '../Icons'

/**
 * The tips tour: a short guided sequence, one tip at a time, each pointing at
 * a control on screen (an element with a matching data-tip attribute). A tip
 * has one sentence, "How this works", a step count, "Skip tips" and Next (Done
 * on the last). X, Esc and "Skip tips" end the whole tour; Enter and the Right
 * arrow go to the next tip. Controls that aren't on screen (a phone has no
 * sidebar) are left out of the count. The "?" dialog's "Show me around"
 * starts it again.
 */
const TIPS: { id: string; explainer: ExplainerId; text: string; side: 'above' | 'right' }[] = [
  { id: 'mic', explainer: 'mic', text: 'The mic is for talking instead of typing. Voice arrives in the next update.', side: 'above' },
  { id: 'res', explainer: 'research', text: 'Research will read the web for you and cite only the pages it opened.', side: 'above' },
  { id: 'mem', explainer: 'memory', text: 'Notes, files and links you add here will be quoted in answers.', side: 'right' },
  { id: 'meter', explainer: 'meter', text: "This is today's share of the demo key. Sign in for 10x more messages, or add your own key to remove the limit.", side: 'above' },
]

function visibleTarget(id: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tip="${id}"]`)) {
    const box = el.getBoundingClientRect()
    if (box.width > 0 && box.height > 0 && el.offsetParent !== null) return el
  }
  return null
}

const PAD = 5
const WIDTH = 260
const GAP = 14

/** Puts the ring around the target and the tip next to it (direct style writes: this is layout, not state). */
function position(tip: (typeof TIPS)[number], ring: HTMLElement, coach: HTMLElement): void {
  const target = visibleTarget(tip.id)
  if (!target) return
  const r = target.getBoundingClientRect()
  const box = { left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
  Object.assign(ring.style, {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${box.width}px`,
    height: `${box.height}px`,
    borderRadius: getComputedStyle(target).borderTopLeftRadius.endsWith('%') ? '50%' : '12px',
  })
  if (tip.side === 'right') {
    const top = Math.max(8, r.top + r.height / 2 - 24)
    coach.style.left = `${box.left + box.width + GAP}px`
    coach.style.top = `${top}px`
    coach.style.setProperty('--ay', `${r.top + r.height / 2 - top - 6}px`)
    return
  }
  const centre = r.left + r.width / 2
  const left = Math.min(Math.max(8, centre - WIDTH / 2), window.innerWidth - WIDTH - 8)
  coach.style.left = `${left}px`
  coach.style.top = `${box.top - coach.offsetHeight - 12}px`
  coach.style.setProperty('--ax', `${Math.min(Math.max(12, centre - left - 6), WIDTH - 24)}px`)
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
}

export function Tips({
  active,
  step,
  onStep,
  onClose,
  onExplain,
}: {
  active: boolean
  /** Index into the tips on screen. */
  step: number
  onStep: (step: number) => void
  /** Ends the whole tour. */
  onClose: () => void
  onExplain: (id: ExplainerId) => void
}) {
  const ring = useRef<HTMLSpanElement>(null)
  const coach = useRef<HTMLDivElement>(null)
  const next = useRef<HTMLButtonElement>(null)
  const [, setTick] = useState(0)

  const onScreen = active ? TIPS.filter((tip) => visibleTarget(tip.id) !== null) : []
  const current = onScreen[step] ?? null
  const last = step >= onScreen.length - 1
  const advance = () => (last ? onClose() : onStep(step + 1))

  useLayoutEffect(() => {
    if (current && ring.current && coach.current) position(current, ring.current, coach.current)
  })

  // Each new tip takes the focus, so Enter, Space and Tab act on it.
  const currentId = current?.id
  useEffect(() => {
    if (currentId) next.current?.focus({ preventScroll: true })
  }, [currentId])

  // Layout can change under the tip (resizing, scrolling, the thread growing).
  useEffect(() => {
    if (!active) return
    const update = () => setTick((n) => n + 1)
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    const timer = window.setInterval(update, 1000)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
      window.clearInterval(timer)
    }
  }, [active])

  // Keys: Enter or Right for Next, Esc to end the tour. Typing in a field is left alone.
  useEffect(() => {
    if (!current) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (isEditable(event.target)) return
      // A focused button inside the tip handles its own Enter.
      if (event.key === 'Enter' && event.target instanceof HTMLButtonElement && coach.current?.contains(event.target)) return
      if (event.key === 'Enter' || event.key === 'ArrowRight') {
        event.preventDefault()
        advance()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!current) return null
  return (
    <>
      <span ref={ring} className="ring" aria-hidden="true" />
      <div
        ref={coach}
        className={current.side === 'right' ? 'coach left' : 'coach down'}
        role="dialog"
        aria-label={`Tip ${step + 1} of ${onScreen.length}`}
        data-testid="tip"
        data-tip-id={current.id}
      >
        <div className="ct">
          <p>{current.text}</p>
          <button type="button" className="cx" aria-label="Close tips" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="cf">
          <button type="button" className="hw" onClick={() => onExplain(current.explainer)}>
            How this works
          </button>
          <span className="of" data-testid="tip-step">
            {step + 1} of {onScreen.length}
          </span>
        </div>
        <div className="ca">
          <button type="button" className="skip" onClick={onClose}>
            Skip tips
          </button>
          <button type="button" className="next" ref={next} onClick={advance} data-testid="tip-next">
            {last ? 'Done' : 'Next'}
            {!last && <Icon name="right" />}
          </button>
        </div>
      </div>
    </>
  )
}

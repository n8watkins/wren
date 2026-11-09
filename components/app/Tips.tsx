'use client'

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ExplainerId } from '../explainers'
import { Icon } from '../Icons'

/**
 * In-context tips: one at a time, pointing at a control on screen (an element
 * with a matching data-tip attribute). Each has one sentence, a close button
 * and "How this works". Closed tips stay closed (the parent stores them).
 */
const TIPS: { id: string; explainer: ExplainerId; text: string; side: 'above' | 'right' }[] = [
  { id: 'mic', explainer: 'mic', text: 'The mic is for talking instead of typing. Voice arrives in the next update.', side: 'above' },
  { id: 'res', explainer: 'research', text: 'Research will read the web for you and cite only the pages it opened.', side: 'above' },
  { id: 'mem', explainer: 'memory', text: 'Notes, files and links you add here will be quoted in answers.', side: 'right' },
  { id: 'meter', explainer: 'meter', text: "This is today's share of the demo key. Add your own key to remove the limit.", side: 'above' },
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

export function Tips({
  active,
  dismissed,
  onDismiss,
  onExplain,
}: {
  active: boolean
  dismissed: string[]
  onDismiss: (id: string) => void
  onExplain: (id: ExplainerId) => void
}) {
  const ring = useRef<HTMLSpanElement>(null)
  const coach = useRef<HTMLDivElement>(null)
  const [, setTick] = useState(0)

  const onScreen = active ? TIPS.filter((tip) => visibleTarget(tip.id) !== null) : []
  const current = onScreen.find((tip) => !dismissed.includes(tip.id)) ?? null

  useLayoutEffect(() => {
    if (current && ring.current && coach.current) position(current, ring.current, coach.current)
  })

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

  if (!current) return null
  const index = onScreen.indexOf(current) + 1
  return (
    <>
      <span ref={ring} className="ring" aria-hidden="true" />
      <div
        ref={coach}
        className={current.side === 'right' ? 'coach left' : 'coach down'}
        role="dialog"
        aria-label="Tip"
        data-testid="tip"
        data-tip-id={current.id}
      >
        <div className="ct">
          <p>{current.text}</p>
          <button type="button" className="cx" aria-label="Close tip" onClick={() => onDismiss(current.id)}>
            <Icon name="x" />
          </button>
        </div>
        <div className="cf">
          <button type="button" onClick={() => onExplain(current.explainer)}>
            How this works
          </button>
          <span className="of">
            {index} of {onScreen.length}
          </span>
        </div>
      </div>
    </>
  )
}

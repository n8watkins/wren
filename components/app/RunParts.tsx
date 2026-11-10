'use client'

import { useEffect, useRef, useState } from 'react'
import { ApiError } from '@/lib/client/api'
import { watchRun } from '@/lib/client/runs-api'
import { RUN_STATUS_LABELS, isActive, type RunDetail, type RunSource, type RunStatus, type RunStep } from '@/lib/research'
import { Icon, type IconName } from '../Icons'
import styles from './Runs.module.css'

/**
 * What the Runs page and a run in chat share: the status badge, one line of
 * the run's log, the numbered sources, and watching a run as it goes.
 */

export function StatusBadge({ status }: { status: RunStatus }) {
  const tone = isActive(status) ? styles.live : status === 'done' ? styles.done : status === 'failed' ? styles.failedBadge : styles.muted
  return (
    <span className={`${styles.badge} ${tone}`} data-testid="run-status">
      {isActive(status) && <span className={styles.pulse} aria-hidden="true" />}
      {RUN_STATUS_LABELS[status]}
    </span>
  )
}

const STEP_ICONS: Record<RunStep['kind'], IconName> = {
  plan: 'right',
  search: 'res',
  read: 'check',
  skip: 'x',
  note: 'stop',
  write: 'chat',
  error: 'alert',
}

export function StepLine({ step }: { step: RunStep }) {
  const label =
    step.kind === 'search' ? (
      <>Searched &ldquo;{step.label}&rdquo;</>
    ) : step.kind === 'read' && step.url ? (
      <>
        Read{' '}
        <a href={step.url} target="_blank" rel="noopener noreferrer nofollow ugc">
          {step.label}
        </a>
      </>
    ) : step.kind === 'skip' ? (
      <>Skipped {step.label}</>
    ) : (
      step.label
    )
  return (
    <li className={`${styles.step} ${styles[`k_${step.kind}`] ?? ''}`} data-testid="run-step" data-kind={step.kind}>
      <span className={styles.stepIcon} aria-hidden="true">
        <Icon name={STEP_ICONS[step.kind]} />
      </span>
      <div className={styles.stepBody}>
        <span className={styles.stepLabel}>{label}</span>
        {step.kind === 'plan' && step.detail ? (
          <ol className={styles.queries}>
            {step.detail.split('\n').map((query) => (
              <li key={query}>{query}</li>
            ))}
          </ol>
        ) : (
          step.detail && <span className={styles.stepDetail}>{step.detail}</span>
        )}
      </div>
    </li>
  )
}

/** "3 searches · 5 pages read · 2 skipped" */
export function stepsSummary(steps: RunStep[]): string {
  const count = (kind: RunStep['kind']) => steps.filter((s) => s.kind === kind).length
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const parts = [plural(count('search'), 'search', 'searches'), plural(count('read'), 'page read', 'pages read')]
  const skipped = count('skip')
  if (skipped) parts.push(`${skipped} skipped`)
  return parts.join(' · ')
}

export function Sources({ sources }: { sources: RunSource[] }) {
  return (
    <ol className={styles.sources} data-testid="run-sources">
      {sources.map((source) => (
        <li key={source.n} className={source.cited ? undefined : styles.uncited} data-testid="run-source">
          <span className={styles.num}>{source.n}</span>
          <div>
            <a href={source.url} target="_blank" rel="noopener noreferrer nofollow ugc">
              {source.title}
            </a>
            <small>
              {source.host}
              {!source.cited && ' · not cited'}
            </small>
          </div>
        </li>
      ))}
    </ol>
  )
}

/**
 * Watches a run through its NDJSON stream for as long as it goes, opening it
 * again (with a growing wait) if it drops. `onEnd` hears the run once it has
 * ended. A run that is gone, or a session that ended, stops the watch with an
 * error.
 */
export function useRunWatch(id: string, enabled: boolean, onEnd?: (run: RunDetail) => void) {
  const [run, setRun] = useState<RunDetail | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const ended = useRef(onEnd)
  useEffect(() => {
    ended.current = onEnd
  }, [onEnd])

  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    let wait = 1_000
    void (async () => {
      while (!controller.signal.aborted) {
        let last: RunDetail | null = null
        try {
          for await (const detail of watchRun(id, controller.signal)) {
            last = detail
            wait = 1_000
            setError(null)
            setRun(detail)
          }
        } catch (failure) {
          if (controller.signal.aborted) return
          if (failure instanceof ApiError && (failure.code === 'run_not_found' || failure.code === 'unauthorized')) {
            setError(failure)
            return
          }
        }
        if (controller.signal.aborted) return
        if (last && !isActive(last.status)) {
          ended.current?.(last)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, wait))
        wait = Math.min(wait * 2, 15_000)
      }
    })()
    return () => controller.abort()
  }, [id, enabled])

  return { run, setRun, error }
}

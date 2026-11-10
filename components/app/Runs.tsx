'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ApiError } from '@/lib/client/api'
import { runsApi } from '@/lib/client/runs-api'
import { errorMessage } from '@/lib/errors'
import { DAILY_LIMITS, RESEARCH_LIMITS, type UsageSnapshot } from '@/lib/limits'
import { RUN_FAILURES, isActive, linkCitations, type RunSummary } from '@/lib/research'
import { Icon } from '../Icons'
import { Markdown } from '../Markdown'
import { WrenMark } from '../WrenMark'
import type { Person } from './Chrome'
import { Sources, StatusBadge, StepLine, stepsSummary, useRunWatch } from './RunParts'
import styles from './Runs.module.css'

/**
 * The Runs page (/runs and /runs/:id): start a research run, see past runs,
 * watch one live (what it searched, read and skipped, and why), and read the
 * finished report with its numbered sources. Saffron is research's colour.
 */

function ago(at: number, now: number): string {
  const minutes = Math.round((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* ---------- starting a run ---------- */

function StartForm({
  usage,
  busy,
  initial,
  onStarted,
}: {
  usage: UsageSnapshot
  busy: boolean
  initial?: string
  onStarted: (run: RunSummary, usage: UsageSnapshot) => void
}) {
  const [question, setQuestion] = useState(initial ?? '')
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const left = Math.max(0, usage.research.limit - usage.research.used)
  const canStart = question.trim().length >= 3 && !starting && !busy && left > 0

  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [question])

  const start = async (event?: FormEvent) => {
    event?.preventDefault()
    if (!canStart) return
    setStarting(true)
    setError(null)
    try {
      const started = await runsApi.start(question.trim())
      onStarted(started.run, started.usage)
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : errorMessage('internal'))
      setStarting(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return
    if (window.matchMedia('(pointer: coarse)').matches) return
    event.preventDefault()
    void start()
  }

  return (
    <form className={styles.start} onSubmit={start} data-testid="run-start">
      {error && (
        <div className="alert" role="alert" data-testid="run-error">
          <Icon name="alert" />
          <p>{error}</p>
        </div>
      )}
      <label className="sr-only" htmlFor="run-question">
        What should Wren research?
      </label>
      <textarea
        id="run-question"
        ref={box}
        rows={2}
        value={question}
        maxLength={RESEARCH_LIMITS.questionChars}
        placeholder="What should Wren research? For example: what should I look for in an e-bike under $1,500?"
        onChange={(event) => setQuestion(event.target.value)}
        onKeyDown={onKeyDown}
        data-testid="run-question"
      />
      <div className={styles.startRow}>
        <span className={styles.left} data-testid="runs-left">
          {busy
            ? 'A run is going: let it finish first'
            : left === 0
              ? 'No runs left today · back at midnight UTC'
              : `${left} of ${usage.research.limit} runs left today`}
        </span>
        <button type="submit" className={styles.go} disabled={!canStart} data-testid="run-go">
          <Icon name="res" />
          {starting ? 'Starting…' : 'Research'}
        </button>
      </div>
    </form>
  )
}

/* ---------- the list ---------- */

function RunList({ usage, onUsage }: { usage: UsageSnapshot; onUsage: (usage: UsageSnapshot) => void }) {
  const router = useRouter()
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(0)

  useEffect(() => {
    let cancelled = false
    runsApi
      .list()
      .then((list) => {
        if (cancelled) return
        setRuns(list)
        setNow(Date.now())
      })
      .catch((failure: unknown) => !cancelled && setError(failure instanceof ApiError ? failure.message : errorMessage('internal')))
    return () => {
      cancelled = true
    }
  }, [])

  const busy = runs?.some((run) => isActive(run.status)) ?? false

  return (
    <>
      <div className={styles.intro}>
        <p>Wren plans a few searches, reads the most useful pages and writes a report that cites only what it read. A run keeps going if you close the tab.</p>
      </div>
      <StartForm
        usage={usage}
        busy={busy}
        onStarted={(run, nextUsage) => {
          onUsage(nextUsage)
          router.push(`/runs/${run.id}`)
        }}
      />
      <div className={styles.label}>Past runs</div>
      {error ? (
        <div className="alert" role="alert">
          <Icon name="alert" />
          <p>{error}</p>
        </div>
      ) : runs === null ? (
        <div className={styles.loading} aria-busy="true">
          <WrenMark size={28} state="thinking" label="Loading runs" />
        </div>
      ) : runs.length === 0 ? (
        <p className={styles.empty}>Your research runs will show up here.</p>
      ) : (
        <ul className={styles.list} data-testid="run-list">
          {runs.map((run) => (
            <li key={run.id}>
              <Link href={`/runs/${run.id}`} className={styles.row} data-testid="run-row">
                <span className={styles.rowQ}>{run.question}</span>
                <span className={styles.rowMeta}>
                  <StatusBadge status={run.status} />
                  {run.status === 'done' && <span>{run.sourceCount === 1 ? '1 source' : `${run.sourceCount} sources`}</span>}
                  <span>{ago(run.createdAt, now)}</span>
                </span>
                <Icon name="right" className={styles.chev} />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/* ---------- one run ---------- */

function RunView({
  id,
  usage,
  onUsage,
  onRefreshUsage,
}: {
  id: string
  usage: UsageSnapshot
  onUsage: (usage: UsageSnapshot) => void
  onRefreshUsage: () => void
}) {
  const router = useRouter()
  // A failed run gives the day's run back: show it in the meter.
  const watched = useRunWatch(id, true, (ended) => {
    if (ended.status === 'failed') onRefreshUsage()
  })
  const { run, setRun } = watched
  const [actionError, setActionError] = useState<string | null>(null)
  const error = watched.error
    ? { message: watched.error.message, missing: watched.error.code === 'run_not_found' }
    : actionError
      ? { message: actionError, missing: false }
      : null
  const [cancelling, setCancelling] = useState(false)
  const [copied, setCopied] = useState(false)
  const [retrying, setRetrying] = useState(false)

  const cancel = async () => {
    setCancelling(true)
    try {
      setRun(await runsApi.cancel(id))
    } catch (failure) {
      setActionError(failure instanceof ApiError ? failure.message : errorMessage('internal'))
    } finally {
      setCancelling(false)
    }
  }

  const retry = async () => {
    if (!run) return
    setRetrying(true)
    try {
      const started = await runsApi.start(run.question)
      onUsage(started.usage)
      router.push(`/runs/${started.run.id}`)
    } catch (failure) {
      setActionError(failure instanceof ApiError ? failure.message : errorMessage('internal'))
      setRetrying(false)
    }
  }

  const copy = async () => {
    if (!run?.report) return
    const sources = run.sources.map((s) => `[${s.n}] ${s.title}: ${s.url}`).join('\n')
    try {
      await navigator.clipboard.writeText(`# ${run.question}\n\n${run.report}\n\n## Sources\n\n${sources}\n`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked; nothing to do.
    }
  }

  const back = (
    <Link href="/runs" className={styles.back} data-testid="runs-back">
      <Icon name="left" />
      All runs
    </Link>
  )

  if (error && (error.missing || !run)) {
    return (
      <>
        {back}
        <div className="alert" role="alert" data-testid="run-error">
          <Icon name="alert" />
          <p>{error.message}</p>
        </div>
      </>
    )
  }
  if (!run) {
    return (
      <>
        {back}
        <div className={styles.loading} aria-busy="true">
          <WrenMark size={32} state="thinking" label="Loading run" />
        </div>
      </>
    )
  }

  const active = isActive(run.status)
  return (
    <article data-testid="run-view" data-status={run.status}>
      {back}
      <h2 className={styles.question} data-testid="run-question-title">
        {run.question}
      </h2>
      <div className={styles.statusRow}>
        {active && <WrenMark size={20} state="thinking" />}
        <StatusBadge status={run.status} />
        <span className={styles.when}>
          {new Date(run.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
        </span>
        <span className={styles.sp} />
        {active && (
          <button type="button" className="btn" onClick={cancel} disabled={cancelling} data-testid="run-cancel">
            <Icon name="stop" />
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        )}
        {run.status === 'done' && (
          <button type="button" className="btn" onClick={copy} data-testid="run-copy">
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy report'}
          </button>
        )}
      </div>
      {error && (
        <div className="alert" role="alert">
          <Icon name="alert" />
          <p>{error.message}</p>
        </div>
      )}

      {run.status === 'failed' && (
        <div className={styles.ended} data-testid="run-failed">
          <Icon name="alert" />
          <div>
            <b>Stopped without a report.</b> {run.failure ? RUN_FAILURES[run.failure] : RUN_FAILURES.internal} This run doesn&rsquo;t count
            against today&rsquo;s {usage.research.limit}.
          </div>
          <button type="button" className={styles.go} onClick={retry} disabled={retrying} data-testid="run-retry">
            <Icon name="redo" />
            Try again
          </button>
        </div>
      )}
      {run.status === 'cancelled' && (
        <div className={`${styles.ended} ${styles.endedMuted}`} data-testid="run-cancelled">
          <Icon name="stop" />
          <div>You cancelled this run. It still counts as one of today&rsquo;s.</div>
        </div>
      )}

      {run.report && (
        <section className={styles.report} aria-label="Report" data-testid="run-report">
          <div className="md">
            <Markdown text={linkCitations(run.report, run.sources)} />
          </div>
        </section>
      )}
      {run.sources.length > 0 && run.status === 'done' && (
        <section aria-label="Sources">
          <div className={styles.label}>Sources</div>
          <Sources sources={run.sources} />
        </section>
      )}

      <details className={styles.steps} open={active || run.status !== 'done' || undefined} key={active ? 'live' : 'ended'} data-testid="run-steps">
        <summary>
          <span className={styles.summaryText}>
            <span>{active ? 'What Wren is doing' : 'How Wren researched this'}</span>
            <small>{stepsSummary(run.steps)}</small>
          </span>
          <Icon name="down" className={styles.caret} />
        </summary>
        <ol className={styles.stepList} aria-live={active ? 'polite' : undefined}>
          {run.steps.length === 0 && active && (
            <li className={`${styles.step} ${styles.k_plan}`}>
              <span className={styles.stepIcon} aria-hidden="true">
                <Icon name="right" />
              </span>
              <div className={styles.stepBody}>
                <span className={styles.stepLabel}>Planning the searches…</span>
              </div>
            </li>
          )}
          {run.steps.map((step) => (
            <StepLine key={step.seq} step={step} />
          ))}
        </ol>
      </details>
    </article>
  )
}

/* ---------- the page ---------- */

export function Runs({
  person,
  usage,
  onUsage,
  onRefreshUsage,
  onSignIn,
}: {
  person: Person | null
  usage: UsageSnapshot
  onUsage: (usage: UsageSnapshot) => void
  onRefreshUsage: () => void
  onSignIn: () => void
}) {
  const pathname = usePathname()
  const runId = /^\/runs\/([0-9a-f-]{36})$/.exec(pathname)?.[1] ?? null

  if (!person) {
    return (
      <section className="soonpage" data-testid="runs-page">
        <span className="hi c-sa">
          <Icon name="res" />
        </span>
        <h2>Research runs</h2>
        <p>
          Ask Wren to research something and it plans searches, reads the pages and writes a report that cites only what it opened.
          Signed in, you get {DAILY_LIMITS.research} runs a day.
        </p>
        <button type="button" className="btn pri" onClick={onSignIn} data-testid="runs-sign-in">
          Sign in to research
        </button>
      </section>
    )
  }

  return (
    <section className={styles.page} data-testid="runs-page">
      <div className={styles.col}>
        {runId ? (
          <RunView key={runId} id={runId} usage={usage} onUsage={onUsage} onRefreshUsage={onRefreshUsage} />
        ) : (
          <RunList usage={usage} onUsage={onUsage} />
        )}
      </div>
    </section>
  )
}

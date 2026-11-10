'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import type { ChatMessage } from '@/agent/chats'
import { ApiError } from '@/lib/client/api'
import { runsApi } from '@/lib/client/runs-api'
import { errorMessage } from '@/lib/errors'
import { RUN_FAILURES, isActive, linkCitations, searchedWithLine, type MessageResearch, type RunDetail } from '@/lib/research'
import { Icon } from '../Icons'
import { Markdown } from '../Markdown'
import { WrenMark } from '../WrenMark'
import { SaveToMemory, type ThreadMemory } from './ChatMemory'
import { Sources, StatusBadge, StepLine, stepsSummary, useRunWatch } from './RunParts'
import styles from './ResearchCard.module.css'

/**
 * A research run started from chat, as Wren's message: a saffron card while
 * it goes (what it searched and read, with Stop), reattached to the running
 * run after a reload; then the report with its numbered sources, which the
 * conversation can carry on about, and "Save findings to memory". Failed and
 * stopped runs say so.
 */

/** Steps shown on the card while a run goes; the Runs page has them all. */
const LIVE_STEPS = 4

export type ResearchMessage = ChatMessage & { research: MessageResearch }

/** Wren's message once its run has ended, as the server writes it (agent/chat-research.ts). */
export function settledMessage(message: ResearchMessage, run: RunDetail): ResearchMessage {
  const done = run.status === 'done' && run.report !== null
  const status = done ? 'done' : run.status === 'cancelled' ? 'cancelled' : 'failed'
  return {
    ...message,
    content: done ? (run.report ?? '') : '',
    status: done ? 'done' : status === 'cancelled' ? 'stopped' : 'error',
    research: {
      ...message.research,
      status,
      failure: status === 'failed' ? (run.failure ?? 'internal') : null,
      sources: done ? run.sources : [],
      searchedWith: run.searchedWith,
    },
  }
}

function failureOf(failure: unknown): string {
  return failure instanceof ApiError ? failure.message : errorMessage('internal')
}

export function ResearchAnswer({
  message,
  memory,
  researchLimit,
  onSettled,
  onRetry,
}: {
  message: ResearchMessage
  memory: ThreadMemory | null
  /** Runs a day, for "doesn't count against today's 3". */
  researchLimit: number
  onSettled: (messageId: string, run: RunDetail) => void
  /** Starts the same question again (a failed run). */
  onRetry: (question: string) => void
}) {
  const research = message.research
  const watching = isActive(research.status)
  const watched = useRunWatch(research.runId, watching, (run) => onSettled(message.id, run))
  const run = watching ? watched.run : null
  const status = run?.status ?? research.status
  const live = isActive(status)
  const [stopping, setStopping] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const runHref = `/runs/${research.runId}`
  const searched = searchedWithLine(run?.searchedWith ?? research.searchedWith)

  const stop = async () => {
    setStopping(true)
    setProblem(null)
    try {
      const ended = await runsApi.cancel(research.runId)
      watched.setRun(ended)
      if (!isActive(ended.status)) onSettled(message.id, ended)
    } catch (failure) {
      setProblem(failureOf(failure))
    } finally {
      setStopping(false)
    }
  }

  const copy = async () => {
    const sources = research.sources.map((s) => `[${s.n}] ${s.title}: ${s.url}`).join('\n')
    try {
      await navigator.clipboard.writeText(`# ${research.question}\n\n${message.content}\n\n## Sources\n\n${sources}\n`)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard blocked; nothing to do.
    }
  }

  const fullRun = (
    <Link href={runHref} className={styles.runLink} data-testid="research-open-run">
      Full run
      <Icon name="right" />
    </Link>
  )

  let body: ReactNode
  if (live) {
    const steps = run?.steps ?? []
    const recent = steps.slice(-LIVE_STEPS)
    body = (
      <section className={styles.card} aria-label="Research in progress" data-testid="research-live">
        <div className={styles.top}>
          <StatusBadge status={status} />
          <span className={styles.count}>{steps.length ? stepsSummary(steps) : 'Starting'}</span>
          <span className={styles.sp} />
          <button type="button" className={styles.stop} onClick={() => void stop()} disabled={stopping} data-testid="research-stop">
            <Icon name="stop" />
            {stopping ? 'Stopping…' : 'Stop'}
          </button>
        </div>
        <ol className={styles.steps} aria-live="polite" data-testid="research-steps">
          {recent.length === 0 ? (
            <li className={styles.planning}>Planning the searches…</li>
          ) : (
            recent.map((step) => <StepLine key={step.seq} step={step.kind === 'plan' ? { ...step, detail: null } : step} />)
          )}
        </ol>
        <div className={styles.foot}>
          <span data-testid="research-searched">{searched ?? 'It keeps going if you close the tab.'}</span>
          {fullRun}
        </div>
        {(problem || watched.error) && (
          <p className={styles.problem} role="alert">
            {problem ?? watched.error?.message}
          </p>
        )}
      </section>
    )
  } else if (status === 'done') {
    body = (
      <>
        <div className={`md ${styles.report}`} data-testid="research-report">
          <Markdown text={linkCitations(message.content, research.sources)} />
        </div>
        <section className={styles.sourcesBox} aria-label="Sources">
          <div className={styles.label}>
            <span>Sources</span>
            {searched && <small data-testid="research-searched">{searched}</small>}
          </div>
          <Sources sources={research.sources} />
        </section>
        <div className="acts">
          <button type="button" onClick={() => void copy()} data-testid="research-copy">
            <Icon name={copied ? 'check' : 'copy'} />
            {copied ? 'Copied' : 'Copy'}
          </button>
          {fullRun}
          {/* Last, so its label changing never moves another control under the pointer. */}
          {memory && <SaveToMemory messageId={message.id} savedAs={message.memory?.savedAs} memory={memory} label="Save findings to memory" />}
        </div>
      </>
    )
  } else if (status === 'failed') {
    body = (
      <div className={`${styles.ended} ${styles.failed}`} data-testid="research-failed">
        <Icon name="alert" />
        <div>
          <p>
            <b>Stopped without a report.</b> {RUN_FAILURES[research.failure ?? 'internal']} This run doesn&rsquo;t count against
            today&rsquo;s {researchLimit}.
          </p>
          {searched && <small data-testid="research-searched">{searched}</small>}
          <div className={styles.endedActs}>
            <button type="button" className={styles.retry} onClick={() => onRetry(research.question)} data-testid="research-retry">
              <Icon name="redo" />
              Try again
            </button>
            {fullRun}
          </div>
        </div>
      </div>
    )
  } else {
    body = (
      <div className={styles.ended} data-testid="research-cancelled">
        <Icon name="stop" />
        <div>
          <p>You stopped this run. It still counts as one of today&rsquo;s.</p>
          <div className={styles.endedActs}>{fullRun}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="k" data-testid="research-card" data-status={status}>
      <div className="who2">
        <WrenMark size={20} state={live ? 'thinking' : 'still'} />
        <span>Wren</span>
        <span className={styles.kicker}>
          <Icon name="res" />
          {live ? 'Researching' : 'Research'}
        </span>
      </div>
      {body}
    </div>
  )
}

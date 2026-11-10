'use client'

import { useState, type FormEvent } from 'react'
import { authClient } from '@/lib/client/auth-client'
import { Dialog } from '../Dialog'
import { ExplainerBody, type ExplainerId } from '../explainers'
import { Icon } from '../Icons'
import { WrenMark } from '../WrenMark'

/** First visit, and any time from "?": four steps, in the order people try things. */
export function HowItWorksDialog({
  open,
  onClose,
  onShowAround,
}: {
  open: boolean
  onClose: () => void
  onShowAround: () => void
}) {
  return (
    <Dialog open={open} onClose={onClose} label="How Wren works" testId="how-it-works">
      <div className="mtop">
        <WrenMark size={46} state="idle" />
        <div>
          <h2>How Wren works</h2>
          <p>Four things to know before you start.</p>
        </div>
      </div>
      <ol className="how">
        <li className="howi">
          <span className="hi c-em">
            <Icon name="mic" />
          </span>
          <div>
            <span className="num">Step 1</span>
            <b>
              <span className="n">1. </span>
              Talk or type
            </b>
            <p>Type in the box and Wren answers as it writes, or tap the mic and talk; talk over Wren to interrupt. Both land in the same chat.</p>
          </div>
        </li>
        <li className="howi">
          <span className="hi c-sa">
            <Icon name="res" />
          </span>
          <div>
            <span className="num">Step 2</span>
            <b>
              <span className="n">2. </span>
              Ask it to research
            </b>
            <p>Turn on Research in the composer and ask: Wren searches, reads the pages, shows each step and writes a report into the chat that cites only pages it opened.</p>
          </div>
        </li>
        <li className="howi">
          <span className="hi c-sg">
            <Icon name="mem" />
          </span>
          <div>
            <span className="num">Step 3</span>
            <b>
              <span className="n">3. </span>
              Build your memory
            </b>
            <p>Save notes, files, links and chat messages, and find them by meaning. Wren keeps lasting facts you tell it (with an Undo), checks your memory before it answers and links to whatever it used.</p>
          </div>
        </li>
        <li className="howi">
          <span className="hi c-ink">
            <Icon name="key" />
          </span>
          <div>
            <span className="num">Step 4</span>
            <b>
              <span className="n">4. </span>
              Your key, limits and privacy
            </b>
            <p>
              Try it as a guest: 5 messages a day, kept only in this tab. Sign in for 10x more messages, voice, research and
              memory, with your chats saved. Or add your own Gemini key to lift the limit; it&rsquo;s kept in this browser.
            </p>
          </div>
        </li>
      </ol>
      <div className="mfoot">
        <span className="note">
          <span className="qk" aria-hidden="true">
            ?
          </span>
          Reopen from the header
        </span>
        <button type="button" className="btn" onClick={onShowAround}>
          Show me around
        </button>
        <button type="button" className="btn pri" onClick={onClose} data-testid="start-chatting" autoFocus>
          Start chatting
        </button>
      </div>
    </Dialog>
  )
}

/** Sign-in as a modal (the owner's preference): GitHub, or a one-time link by email. */
export function SignInDialog({
  open,
  onClose,
  reason,
  github,
}: {
  open: boolean
  onClose: () => void
  reason: string | null
  github: boolean
}) {
  const [email, setEmail] = useState('')
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'github'>('idle')
  const [error, setError] = useState<string | null>(null)

  const close = () => {
    onClose()
    setState('idle')
    setError(null)
  }

  const sendLink = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    setState('sending')
    const { error: failed } = await authClient.signIn.magicLink({ email: email.trim(), callbackURL: window.location.pathname })
    if (failed) {
      setState('idle')
      setError(
        failed.status === 429
          ? 'Too many sign-in emails for now. Try again later.'
          : "That didn't work. Check the address and try again."
      )
      return
    }
    setState('sent')
  }

  const signInWithGithub = async () => {
    setError(null)
    setState('github')
    const { error: failed } = await authClient.signIn.social({ provider: 'github', callbackURL: window.location.pathname })
    if (failed) {
      setState('idle')
      setError("GitHub sign-in didn't start. Try again.")
    }
  }

  return (
    <Dialog open={open} onClose={close} label="Sign in to Wren" narrow testId="sign-in">
      <div className="mtop">
        <WrenMark size={40} state="idle" />
        <div>
          <h2>Sign in to Wren</h2>
          <p>{reason ?? 'Keep your chats on every device.'}</p>
        </div>
      </div>
      {state === 'sent' ? (
        <div className="stack">
          <div className="okbox" role="status" data-testid="link-sent">
            <Icon name="mail" />
            <p>
              Check your inbox at <b>{email.trim()}</b>. The link works once and expires in 10 minutes.
            </p>
          </div>
          <button type="button" className="btn wide" onClick={() => setState('idle')}>
            Use a different address
          </button>
        </div>
      ) : (
        <div className="stack">
          <button
            type="button"
            className="btn wide"
            onClick={signInWithGithub}
            disabled={!github || state === 'github'}
            data-testid="github-sign-in"
          >
            <Icon name="git" />
            Continue with GitHub
          </button>
          {!github && <p className="fine">GitHub sign-in isn&rsquo;t set up on this preview yet. Use email for now.</p>}
          <div className="or">or</div>
          <form className="stack" onSubmit={sendLink}>
            <div className="field">
              <label htmlFor="sign-in-email">Email</label>
              <input
                id="sign-in-email"
                type="email"
                autoFocus
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
              />
            </div>
            <button type="submit" className="btn pri wide" disabled={state === 'sending'} data-testid="email-sign-in">
              <Icon name="mail" />
              {state === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>
          </form>
          {error && (
            <p className="formerr" role="alert">
              {error}
            </p>
          )}
          <p className="fine">GitHub or email only. No password, and nothing is posted anywhere.</p>
        </div>
      )}
    </Dialog>
  )
}

/** The person's own Gemini key: kept in this browser, sent per request, never stored on the server. */
export function KeyDialog({
  open,
  onClose,
  current,
  onSave,
}: {
  open: boolean
  onClose: () => void
  current: string | null
  onSave: (key: string | null) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const save = (event: FormEvent) => {
    event.preventDefault()
    const key = value.trim()
    if (key.length < 20 || key.length > 200 || !/^[A-Za-z0-9_.-]+$/.test(key)) {
      setError("That doesn't look like a Gemini API key.")
      return
    }
    onSave(key)
    setValue('')
    setError(null)
    onClose()
  }
  return (
    <Dialog open={open} onClose={onClose} label="Use your own Gemini key" narrow testId="key-dialog">
      <div className="mtop">
        <span className="hi c-ink">
          <Icon name="key" />
        </span>
        <div>
          <h2>Your own key</h2>
          <p>No daily limit, on your own Gemini quota.</p>
        </div>
      </div>
      <div className="stack">
        {current ? (
          <div className="okbox" role="status">
            <Icon name="check" />
            <p>
              A key ending in <b>{current.slice(-4)}</b> is saved in this browser.
            </p>
          </div>
        ) : null}
        <form className="stack" onSubmit={save}>
          <div className="field">
            <label htmlFor="gemini-key">{current ? 'Replace it' : 'Gemini API key'}</label>
            <input
              id="gemini-key"
              type="password"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="AIza…"
            />
          </div>
          {error && (
            <p className="formerr" role="alert">
              {error}
            </p>
          )}
          <button type="submit" className="btn pri wide">
            Save key
          </button>
        </form>
        {current && (
          <button
            type="button"
            className="btn danger wide"
            onClick={() => {
              onSave(null)
              onClose()
            }}
          >
            Remove key
          </button>
        )}
        <p className="fine">
          Kept in this browser only and sent with your own messages. Wren never stores or logs it, and if Gemini rejects it you
          see an error: Wren doesn&rsquo;t switch to the demo key. Get a key at{' '}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">
            aistudio.google.com
          </a>
          .
        </p>
      </div>
    </Dialog>
  )
}

export function ExplainerDialog({ id, onClose }: { id: ExplainerId | null; onClose: () => void }) {
  return (
    <Dialog open={id !== null} onClose={onClose} label="How this works" narrow testId="explainer">
      {id && <ExplainerBody id={id} />}
      <div className="mfoot">
        <button type="button" className="btn pri" onClick={onClose} autoFocus>
          Got it
        </button>
      </div>
    </Dialog>
  )
}

export function ConfirmDeleteDialog({
  title,
  onCancel,
  onConfirm,
}: {
  title: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={title !== null} onClose={onCancel} label="Delete chat" narrow testId="confirm-delete">
      <div className="mtop">
        <span className="hi c-ink">
          <Icon name="trash" />
        </span>
        <div>
          <h2>Delete this chat?</h2>
          <p>&ldquo;{title}&rdquo; and its messages are deleted for good.</p>
        </div>
      </div>
      <div className="mfoot">
        <span className="note" />
        <button type="button" className="btn" onClick={onCancel} autoFocus>
          Keep it
        </button>
        <button type="button" className="btn pri" onClick={onConfirm} data-testid="confirm-delete-yes">
          Delete
        </button>
      </div>
    </Dialog>
  )
}

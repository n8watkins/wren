'use client'

import Link from 'next/link'
import type { ChatSummary } from '@/agent/chats'
import type { UsageSnapshot } from '@/lib/limits'
import { Icon } from '../Icons'
import { WrenMark } from '../WrenMark'
import { Meter, UsageRing } from './Meter'

export type Theme = 'auto' | 'light' | 'dark'
export type Place = 'chat' | 'runs' | 'memory'

export interface Person {
  name: string
  email: string
}

function initials(person: Person): string {
  const source = person.name?.trim() || person.email
  const parts = source.split(/[\s@._-]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? 'W') + (parts[1]?.[0] ?? '')).toUpperCase()
}

function ThemeSwitch({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  return (
    <div className="theme" role="group" aria-label="Theme">
      {(['auto', 'light', 'dark'] as const).map((t) => (
        <button key={t} type="button" aria-pressed={theme === t} onClick={() => setTheme(t)}>
          {t === 'auto' ? 'Auto' : t === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  )
}

interface ChromeProps {
  place: Place
  chats: ChatSummary[]
  currentChatId: string | null
  person: Person | null
  usage: UsageSnapshot
  ownKey: boolean
  /** A guest with guest chat on: the meter shows the guest allowance and what signing in unlocks. */
  guest: boolean
  theme: Theme
  setTheme: (t: Theme) => void
  onNewChat: () => void
  onOpenChat: (id: string) => void
  onDeleteChat: (chat: ChatSummary) => void
  onSignIn: () => void
  onSignOut: () => void
  onKey: () => void
  onMemoryAdd: () => void
}

function RecentList({
  chats,
  currentChatId,
  onOpenChat,
  onDeleteChat,
}: Pick<ChromeProps, 'chats' | 'currentChatId' | 'onOpenChat' | 'onDeleteChat'>) {
  return (
    <>
      {chats.map((chat) => (
        <div key={chat.id} className={chat.id === currentChatId ? 'recent on' : 'recent'} data-testid="recent-chat">
          <a
            href={`/chat/${chat.id}`}
            aria-current={chat.id === currentChatId ? 'page' : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
              event.preventDefault()
              onOpenChat(chat.id)
            }}
          >
            {chat.title}
          </a>
          <button type="button" className="del" aria-label={`Delete "${chat.title}"`} onClick={() => onDeleteChat(chat)}>
            <Icon name="trash" />
          </button>
        </div>
      ))}
    </>
  )
}

function Who({ person, onSignIn }: { person: Person | null; onSignIn: () => void }) {
  if (!person) {
    return (
      <div className="who" data-testid="who">
        <span className="av guest">
          <Icon name="key" />
        </span>
        <div>
          <span className="nm">Not signed in</span>
          <small>
            <button type="button" onClick={onSignIn} data-testid="open-sign-in">
              Sign in with GitHub or email
            </button>
          </small>
        </div>
      </div>
    )
  }
  const hasName = Boolean(person.name?.trim()) && person.name.trim() !== person.email
  return (
    <div className="who" data-testid="who">
      <span className="av" aria-hidden="true">
        {initials(person)}
      </span>
      <div>
        <span className="nm">{hasName ? person.name : person.email}</span>
        <small className="nm">{hasName ? person.email : 'Signed in with an email link'}</small>
      </div>
    </div>
  )
}

/** Desktop: the three places, recent chats, the meter and the account. */
export function Sidebar(props: ChromeProps) {
  const { place, person } = props
  return (
    <aside className="side" aria-label="Wren">
      <Link className="logo" href="/" onClick={(e) => (e.preventDefault(), props.onNewChat())}>
        <WrenMark size={26} state="idle" />
        <b>Wren</b>
      </Link>
      <button type="button" className="newchat" onClick={props.onNewChat} data-testid="new-chat">
        <Icon name="plus" />
        New chat
      </button>
      <nav aria-label="Places">
        <Link className={place === 'chat' ? 'nav on' : 'nav'} href="/" aria-current={place === 'chat' ? 'page' : undefined}>
          <Icon name="chat" />
          Chat
        </Link>
        <Link className={place === 'runs' ? 'nav on' : 'nav'} href="/runs" aria-current={place === 'runs' ? 'page' : undefined}>
          <Icon name="res" />
          Research runs
        </Link>
        <div className={place === 'memory' ? 'navrow on' : 'navrow'}>
          <Link className="nav" href="/memory" aria-current={place === 'memory' ? 'page' : undefined}>
            <Icon name="mem" />
            Memory
          </Link>
          <button type="button" className="plus" aria-label="Add a note to Memory" onClick={props.onMemoryAdd} data-tip="mem">
            <Icon name="plus" />
          </button>
        </div>
      </nav>
      {person && (
        <>
          <div className="lab">Recent chats</div>
          {props.chats.length === 0 ? (
            <div className="empty">Your chats will show up here.</div>
          ) : (
            <RecentList {...props} />
          )}
        </>
      )}
      <div className="grow" />
      <Meter usage={props.usage} ownKey={props.ownKey} guest={props.guest} onKey={props.onKey} onSignIn={props.onSignIn} />
      <Who person={person} onSignIn={props.onSignIn} />
      <div className="acct">
        <ThemeSwitch theme={props.theme} setTheme={props.setTheme} />
        {person && (
          <button type="button" className="linkbtn" onClick={props.onSignOut} data-testid="sign-out">
            Sign out
          </button>
        )}
      </div>
    </aside>
  )
}

/** Phone: the header with the title menu, the usage ring and "?". */
export function MobileHeader(
  props: ChromeProps & {
    title: string
    menuOpen: boolean
    setMenuOpen: (open: boolean) => void
    onHelp: () => void
    onMeter: () => void
  }
) {
  return (
    <>
      <header className="mhd">
        <WrenMark size={24} state="idle" />
        <button
          type="button"
          className="tt"
          aria-expanded={props.menuOpen}
          aria-controls="phone-menu"
          onClick={() => props.setMenuOpen(!props.menuOpen)}
          data-testid="title-menu"
        >
          <span>{props.title}</span>
          <Icon name="down" />
        </button>
        <span className="sp" />
        <UsageRing usage={props.usage} ownKey={props.ownKey} onClick={props.onMeter} />
        <button type="button" className="mib" aria-label="How Wren works" onClick={props.onHelp} data-testid="help-phone">
          ?
        </button>
      </header>
      <div className="mmenu" id="phone-menu" hidden={!props.menuOpen} data-testid="phone-menu">
        <button type="button" className="newchat" onClick={props.onNewChat}>
          <Icon name="plus" />
          New chat
        </button>
        {props.person && (
          <>
            <div className="lab">Recent</div>
            {props.chats.length === 0 ? <div className="empty">Your chats will show up here.</div> : <RecentList {...props} />}
          </>
        )}
        <Meter usage={props.usage} ownKey={props.ownKey} guest={props.guest} onKey={props.onKey} onSignIn={props.onSignIn} />
        <Who person={props.person} onSignIn={props.onSignIn} />
        <div className="row">
          <button type="button" className="btn" onClick={props.onKey}>
            <Icon name="key" />
            {props.ownKey ? 'Your key' : 'Use your key'}
          </button>
          {props.person ? (
            <button type="button" className="btn" onClick={props.onSignOut}>
              <Icon name="out" />
              Sign out
            </button>
          ) : (
            <button type="button" className="btn pri" onClick={props.onSignIn}>
              Sign in
            </button>
          )}
        </div>
        <ThemeSwitch theme={props.theme} setTheme={props.setTheme} />
      </div>
    </>
  )
}

/** Phone: the three places. */
export function BottomNav({ place }: { place: Place }) {
  const items: { href: string; place: Place; icon: 'chat' | 'res' | 'mem'; label: string }[] = [
    { href: '/', place: 'chat', icon: 'chat', label: 'Chat' },
    { href: '/runs', place: 'runs', icon: 'res', label: 'Runs' },
    { href: '/memory', place: 'memory', icon: 'mem', label: 'Memory' },
  ]
  return (
    <nav className="mnav" aria-label="Places">
      {items.map((item) => (
        <Link key={item.place} href={item.href} className={place === item.place ? 'on' : undefined} aria-current={place === item.place ? 'page' : undefined}>
          <Icon name={item.icon} />
          {item.label}
        </Link>
      ))}
    </nav>
  )
}

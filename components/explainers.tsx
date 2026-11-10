import { Icon, type IconName } from './Icons'
import { DAILY_LIMITS, GUEST_LIMITS } from '@/lib/limits'

/**
 * The short "How this works" explainers that tips and buttons open. Voice
 * says plainly that it arrives in the next update, Memory says which part
 * does, and Research and the meter describe what runs today.
 */
export type ExplainerId = 'mic' | 'research' | 'memory' | 'meter'

interface Explainer {
  icon: IconName
  tone: string
  kicker: string
  title: string
  body: string
  flow: string[]
  under: string
  soon: boolean
  /** A part that isn't switched on yet, said plainly. */
  later?: string
}

const EXPLAINERS: Record<ExplainerId, Explainer> = {
  mic: {
    icon: 'mic',
    tone: 'c-em',
    kicker: 'Mic',
    title: 'How talking will work',
    body: 'Your mic will stream to your own agent, which relays it to Gemini Live. The reply plays back as audio while a transcript lands in this chat, and you can start talking at any time to make Wren stop and listen.',
    flow: ['Mic', 'Your agent', 'Gemini Live', 'Voice + captions'],
    under: 'one Durable Object per person holds the live connection and saves each turn.',
    soon: true,
  },
  research: {
    icon: 'res',
    tone: 'c-sa',
    kicker: 'Research',
    title: 'How research works',
    body: 'Start a run from Research runs. Wren plans a few searches, opens the most useful pages and reads them, then writes a report. It can only cite a page it actually read, and every step stays visible so you can check it. Starting a run from chat comes in the next update.',
    flow: ['Plan', 'Search', 'Read pages', 'Write + cite'],
    under: 'each run lives in your own agent and saves every step, so it keeps going if you close the tab.',
    soon: false,
  },
  memory: {
    icon: 'mem',
    tone: 'c-sg',
    kicker: 'Memory',
    title: 'How Memory finds things',
    body: 'Notes, links and files (text, Markdown or PDF) you save on the Memory page are turned into vectors with Gemini and stored in Vectorize, so a search finds what you meant, not just the words you typed. You can edit or delete anything at any time.',
    flow: ['Save', 'Embed', 'Vectorize', 'Search by meaning'],
    under: 'items live in your own agent’s database, files in R2 and vectors in a namespace of your own; deleting an item removes all of it.',
    soon: false,
    later: 'Saving from chat, and answers that quote your memory, arrive in the next update.',
  },
  meter: {
    icon: 'gauge',
    tone: 'c-ink',
    kicker: 'Usage meter',
    title: 'Limits and your own key',
    body: `Without a key you share the demo key. As a guest that is ${GUEST_LIMITS.chat} messages a day, kept only in this tab; signed in, it is ${DAILY_LIMITS.chat} messages, ${DAILY_LIMITS.voiceMinutes} voice minutes and ${DAILY_LIMITS.research} research runs a day, with your chats saved. Add your own Gemini key and the limit goes away. Your key is kept in this browser and sent only with your own requests, never stored on the server.`,
    flow: ['Demo key', 'Daily counter', 'or', 'Your key', 'No limit'],
    under: 'a Durable Object counts each person’s use (and each guest’s, network’s and the whole site’s guest total) and resets at midnight UTC.',
    soon: false,
  },
}

export function ExplainerBody({ id }: { id: ExplainerId }) {
  const e = EXPLAINERS[id]
  return (
    <div className="explain">
      <div className="eh">
        <span className={`hi ${e.tone}`}>
          <Icon name={e.icon} />
        </span>
        <div>
          <small>{e.kicker}</small>
          <h2>{e.title}</h2>
        </div>
      </div>
      {e.soon && (
        <p className="soonnote">
          <Icon name="alert" />
          Coming in the next update. It isn&rsquo;t switched on yet.
        </p>
      )}
      {e.later && (
        <p className="soonnote">
          <Icon name="alert" />
          {e.later}
        </p>
      )}
      <p>{e.body}</p>
      <div className="flow" aria-label="Steps">
        {e.flow.map((step, i) =>
          step === 'or' ? (
            <i key={i}>or</i>
          ) : (
            <span key={i} style={{ display: 'contents' }}>
              {i > 0 && e.flow[i - 1] !== 'or' && <i aria-hidden="true">&rarr;</i>}
              <span>{step}</span>
            </span>
          )
        )}
      </div>
      <div className="uh">
        <b>Under the hood:</b> {e.under}
      </div>
    </div>
  )
}

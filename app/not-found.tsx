import Link from 'next/link'
import { WrenMark } from '@/components/WrenMark'

export default function NotFound() {
  return (
    <main className="soonpage" style={{ minHeight: '100dvh' }}>
      <WrenMark size={44} state="idle" />
      <h2>Nothing here</h2>
      <p>That page doesn&rsquo;t exist.</p>
      <Link className="btn pri" href="/">
        Back to Wren
      </Link>
    </main>
  )
}

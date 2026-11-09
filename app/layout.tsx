import type { Metadata, Viewport } from 'next'
import { Bricolage_Grotesque, Inter, JetBrains_Mono, Newsreader } from 'next/font/google'
import { headers } from 'next/headers'
import type { ReactNode } from 'react'
import { IconSprite } from '@/components/Icons'
import './globals.css'

const bricolage = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-bricolage', weight: ['500', '600', '700', '800'] })
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', weight: ['400', '500', '600'] })
const jetbrains = JetBrains_Mono({ subsets: ['latin'], variable: '--font-jetbrains', weight: ['400', '500'] })
const newsreader = Newsreader({ subsets: ['latin'], variable: '--font-newsreader', weight: ['400', '500'], style: ['normal', 'italic'] })

export const metadata: Metadata = {
  title: 'Wren',
  description: 'An AI assistant you can type or talk to, that researches the web for you and remembers what you save.',
  applicationName: 'Wren',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fbf7f1' },
    { media: '(prefers-color-scheme: dark)', color: '#14100e' },
  ],
}

// Sets the saved theme before the first paint, so a dark-mode choice never
// flashes light. Runs with this request's CSP nonce.
const THEME_SCRIPT = `try{var t=localStorage.getItem('wren:theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`

function nonceFrom(csp: string | null): string | undefined {
  return csp?.match(/'nonce-([A-Za-z0-9+/=_-]+)'/)?.[1]
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const nonce = nonceFrom((await headers()).get('content-security-policy'))
  return (
    <html
      lang="en"
      className={`${bricolage.variable} ${inter.variable} ${jetbrains.variable} ${newsreader.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <IconSprite />
        {children}
      </body>
    </html>
  )
}

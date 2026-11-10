'use client'

import { useEffect } from 'react'

/**
 * Keeps the app the height of what is visible while the on-screen keyboard is
 * up on iOS, so the composer sits right above the keyboard and the header
 * stays on screen. iOS Safari doesn't resize the page for its keyboard (it
 * ignores interactive-widget, app/layout.tsx); it shrinks the visual viewport
 * and scrolls the page instead. Elsewhere the page is resized already, the
 * two heights match and nothing is set. A pinch zoom also shrinks the visual
 * viewport, so a zoomed page is left alone.
 */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return
    const root = document.documentElement
    const sync = () => {
      const covered = viewport.scale <= 1.01 && window.innerHeight - viewport.height > 1
      if (covered) {
        root.style.setProperty('--app-h', `${Math.round(viewport.height)}px`)
        if (window.scrollY !== 0) window.scrollTo(0, 0)
      } else {
        root.style.removeProperty('--app-h')
      }
    }
    sync()
    viewport.addEventListener('resize', sync)
    viewport.addEventListener('scroll', sync)
    return () => {
      viewport.removeEventListener('resize', sync)
      viewport.removeEventListener('scroll', sync)
      root.style.removeProperty('--app-h')
    }
  }, [])
}

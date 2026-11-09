'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icons'

/**
 * A modal on desktop and a bottom sheet on phones (globals.css), built on the
 * native <dialog>: focus stays inside, Esc closes, the page behind is inert.
 * Clicking the backdrop closes it too.
 */
export function Dialog({
  open,
  onClose,
  label,
  narrow,
  children,
  testId,
}: {
  open: boolean
  onClose: () => void
  label: string
  narrow?: boolean
  children: ReactNode
  testId?: string
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  return (
    <dialog
      ref={ref}
      className={narrow ? 'dialog narrow' : 'dialog'}
      aria-label={label}
      data-testid={testId}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose()
      }}
    >
      {open && (
        <div className="inner">
          <div className="grab" aria-hidden="true" />
          <button type="button" className="x" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
          {children}
        </div>
      )}
    </dialog>
  )
}

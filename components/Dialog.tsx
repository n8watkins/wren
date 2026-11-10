'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icons'

/**
 * A modal on desktop and a bottom sheet on phones (globals.css), built on the
 * native <dialog>: focus stays inside, Esc closes, the page behind is inert.
 * Clicking the backdrop closes it too.
 */
/**
 * Where focus starts once the dialog is open. React's autoFocus runs before
 * showModal, while the dialog is still hidden, so it never lands; the browser
 * would then pick the first control, the close button, and ring it. Instead:
 * the control marked data-autofocus, except a text field on a touch screen
 * (focusing it would throw the keyboard over the sheet), else the dialog's
 * content, so Tab starts inside and nothing looks selected.
 */
function focusFirst(dialog: HTMLDialogElement): void {
  const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]')
  const typing = preferred instanceof HTMLInputElement || preferred instanceof HTMLTextAreaElement
  if (preferred && !(typing && window.matchMedia('(pointer: coarse)').matches)) {
    preferred.focus()
    return
  }
  dialog.querySelector<HTMLElement>('.inner')?.focus()
}

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
    if (open && !dialog.open) {
      dialog.showModal()
      focusFirst(dialog)
    }
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
        <div className="inner" tabIndex={-1}>
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

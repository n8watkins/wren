'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { Icon } from './Icons'

/**
 * A modal on desktop and a bottom sheet on phones (globals.css), built on the
 * native <dialog>: focus stays inside, Esc closes, the page behind is inert.
 * Clicking the backdrop closes it too.
 */
/**
 * Where focus starts once the dialog is open: on its content (the title and
 * text), so nothing looks selected when it opens, Tab goes to its first
 * control with the focus ring showing, and a screen reader reads it from the
 * top. React's autoFocus can't do this (it runs before showModal, while the
 * dialog is hidden), and left alone the browser focuses and rings the close
 * button. The one exception is a field marked data-autofocus (the email and
 * key fields) on a device with a keyboard; on a touch screen focusing it
 * would throw the on-screen keyboard over the sheet.
 */
function focusFirst(dialog: HTMLDialogElement): void {
  const field = dialog.querySelector<HTMLElement>('input[data-autofocus], textarea[data-autofocus]')
  if (field && !window.matchMedia('(pointer: coarse)').matches) {
    field.focus()
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

import React from 'react'

/**
 * The system's file dialog, opened from a control of the surface's own (owner
 * ruling 2026-10-04: the New chat composer's "Attach files"). It draws nothing
 * and is never a tab stop: the control a person presses is the kit button or
 * menu row that calls `.click()` on it, and that control carries the name and
 * the focus ring. It is the input component's one invisible shape
 * (design-system/components/input → The file dialog).
 *
 * The value is cleared after every pick, so the same file can be picked twice
 * in a row.
 */
export const HiddenFileInput = React.forwardRef<
  HTMLInputElement,
  { accept?: string; multiple?: boolean; onFiles: (files: File[]) => void }
>(function HiddenFileInput({ accept, multiple = true, onFiles }, ref) {
  return (
    <input
      ref={ref}
      type="file"
      accept={accept}
      multiple={multiple}
      tabIndex={-1}
      aria-hidden="true"
      className="hidden"
      onChange={(event) => {
        const files = Array.from(event.currentTarget.files ?? [])
        event.currentTarget.value = ''
        if (files.length > 0) onFiles(files)
      }}
    />
  )
})

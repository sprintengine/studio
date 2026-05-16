import React from 'react'

type FieldChildProps = {
  id?: string
  'aria-invalid'?: boolean
  'aria-describedby'?: string
  'aria-required'?: boolean
}

type FieldProps = {
  /** Visible label text. Rendered in sentence case. */
  label: string
  /** Stable id given to the labelled control. The Field clones the child to
   *  receive this id, so a single child element is required. */
  htmlFor: string
  /** Optional help text rendered below the control. Hidden when an error is
   *  shown so the labelled element only references one supporting message. */
  help?: string
  /** Optional error message. When set, the labelled child receives
   *  aria-invalid and aria-describedby pointing at this message. */
  error?: string
  required?: boolean
  /** A single focusable form control. Field injects id and ARIA wiring. */
  children: React.ReactElement<FieldChildProps>
  className?: string
}

/**
 * Standalone label, for layouts that don't fit the wrapped `Field` API
 * (radio groups, segmented controls, label-above-non-control rows).
 * Use `Field` itself whenever the label points at a single focusable control.
 */
function FieldLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={['text-[12px] font-medium text-[color:var(--text-default)]', className ?? ''].join(' ')}>
      {children}
    </span>
  )
}

export function Field({ label, htmlFor, help, error, required, children, className }: FieldProps) {
  const helpId = help && !error ? `${htmlFor}-help` : undefined
  const errorId = error ? `${htmlFor}-error` : undefined
  const describedBy = errorId ?? helpId

  const labelledChild = React.cloneElement<FieldChildProps>(children, {
    id: htmlFor,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    'aria-required': required ? true : undefined,
  })

  return (
    <div className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      <label
        htmlFor={htmlFor}
        className="text-[12px] font-medium text-[color:var(--text-default)]"
      >
        {label}
        {required ? (
          <span aria-hidden="true" className="ml-1 text-[color:var(--tone-error)]">
            *
          </span>
        ) : null}
      </label>
      {labelledChild}
      {error ? (
        <p id={errorId} className="text-[11px] text-[color:var(--tone-error)]">
          {error}
        </p>
      ) : null}
      {help && !error ? (
        <p id={helpId} className="text-[11px] text-[color:var(--text-subtle)]">
          {help}
        </p>
      ) : null}
    </div>
  )
}

Field.Label = FieldLabel

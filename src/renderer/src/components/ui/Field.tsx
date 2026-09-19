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
  /**
   * Stable id given to the labelled control. The Field clones the child to
   * receive this id, so a single child element is required.
   *
   * OMIT IT when the row holds a composite rather than one labellable control —
   * a chip group, a value plus a Clear button, a read-only field beside a Copy
   * button. The label then renders as a `<span>` and nothing is cloned, and the
   * caller owns the accessible name (`role="group" aria-label` on the group, or
   * `aria-label` on the control inside). Passing it anyway was the bug this
   * replaced: `cloneElement` put the id on the WRAPPER DIV, so the `<label for>`
   * addressed an element that cannot be labelled — and where the composite also
   * held a real field carrying that same id, the document had it twice and the
   * label resolved to the div.
   */
  htmlFor?: string
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
    <span className={['text-body font-medium text-[color:var(--text-default)]', className ?? ''].join(' ')}>
      {children}
    </span>
  )
}

export function Field({ label, htmlFor, help, error, required, children, className }: FieldProps) {
  const helpId = htmlFor && help && !error ? `${htmlFor}-help` : undefined
  const errorId = htmlFor && error ? `${htmlFor}-error` : undefined
  const describedBy = errorId ?? helpId

  // Without an `htmlFor` there is no control to clone onto: the row is a
  // composite the caller has named itself. The child is rendered untouched.
  const labelledChild = htmlFor
    ? React.cloneElement<FieldChildProps>(children, {
        id: htmlFor,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedBy,
        'aria-required': required ? true : undefined,
      })
    : children

  const labelBody = (
    <>
      {label}
      {required ? (
        <span aria-hidden="true" className="ml-1 text-[color:var(--text-subtle)]">
          *
        </span>
      ) : null}
    </>
  )

  return (
    <div className={['flex flex-col gap-1.5', className ?? ''].join(' ')}>
      {htmlFor ? (
        <label htmlFor={htmlFor} className="text-body font-medium text-[color:var(--text-default)]">
          {labelBody}
        </label>
      ) : (
        // A `<label>` with no `for` and no control inside it labels nothing —
        // it is a span that lies about being a label, which is worse than a
        // span. So: a span, at the same type step.
        <span className="text-body font-medium text-[color:var(--text-default)]">{labelBody}</span>
      )}
      {labelledChild}
      {error ? (
        <p id={errorId} className="text-meta text-[color:var(--tone-error)]">
          {error}
        </p>
      ) : null}
      {help && !error ? (
        <p id={helpId} className="text-meta text-[color:var(--text-subtle)]">
          {help}
        </p>
      ) : null}
    </div>
  )
}

Field.Label = FieldLabel

import React, { type JSX } from 'react'

// The kit's table. Three bespoke variants shipped with no shared
// header/row/cell chrome: a run-summary table (a `table-fixed` with a
// shared `<colgroup>`), `DiagnosticsContent` (a `w-full` with its own local
// `Th`/`Td`, the only one with a sticky header), and
// and a div-grid that is not a table at all).
// They disagreed on cell padding, header ink, header weight, and whether a
// numeric column was right-aligned or tabular.
//
// Composed rather than data-driven on purpose. The three call sites need
// `<colgroup>` tracks, per-cell `title`s, spanning rows and conditional row
// paint — a `columns={[…]} rows={[…]}` API would have to grow an escape hatch
// for each of those, and the escape hatches are where the chrome would drift
// apart again. What is shared here is exactly the chrome: nothing about the
// data model.
//
// Real `<table>` semantics throughout. The div-grid variant reads as a stack of
// unrelated cells to a screen reader — no row/column association, no header
// relationship — which is the one difference between these three that was a
// defect rather than a preference.

export type TableProps = {
  children: React.ReactNode
  /** Column tracks, for a fixed-layout table (a `<colgroup>`). */
  colgroup?: React.ReactNode
  /**
   * Take column widths from `colgroup` instead of auto-sizing to content. Set
   * this when several tables must share one set of column tracks.
   */
  fixed?: boolean
  /** Accessible name, when no caption names the table. */
  ariaLabel?: string
  className?: string
  style?: React.CSSProperties
}

export function Table({ children, colgroup, fixed = false, ariaLabel, className, style }: TableProps): JSX.Element {
  return (
    <table
      aria-label={ariaLabel}
      style={style}
      className={['border-collapse text-meta', fixed ? 'table-fixed' : 'w-full', className ?? ''].join(' ')}
    >
      {colgroup}
      {children}
    </table>
  )
}

type TableCellProps = {
  children?: React.ReactNode
  /** Right-align and use tabular figures, so digits line up column-wise. */
  numeric?: boolean
  title?: string
  colSpan?: number
  scope?: 'col' | 'row'
  className?: string
}

/**
 * A header cell. Sticky by default: every one of these tables is inside a
 * scrollport, and a header that scrolls away turns the numbers under it into
 * unlabelled figures. Pass `sticky={false}` for a table short enough that it
 * never scrolls.
 */
function TableHead({
  children,
  numeric,
  title,
  colSpan,
  scope = 'col',
  sticky = true,
  className,
}: TableCellProps & { sticky?: boolean }): JSX.Element {
  return (
    <th
      scope={scope}
      title={title}
      colSpan={colSpan}
      className={[
        'border-b border-[color:var(--border-default)] px-2 py-1.5 font-medium text-[color:var(--text-muted)]',
        // The header paints a ground only when it is sticky — otherwise rows
        // would slide under a transparent header and show through it.
        // `--z-sticky`, the ramp's own tier for pinned in-flow chrome — a header
        // held above its own rows, not an overlay layer.
        sticky ? 'sticky top-0 z-[var(--z-sticky)] bg-[color:var(--bg-surface)]' : '',
        numeric ? 'text-right' : 'text-left',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  )
}

function TableCell({ children, numeric, title, colSpan, className }: TableCellProps): JSX.Element {
  return (
    <td
      title={title}
      colSpan={colSpan}
      className={[
        'px-2 py-1 text-[color:var(--text-default)]',
        numeric ? 'text-right tabular-nums' : 'text-left',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </td>
  )
}

/** A body row. Hairline-separated, in the one divider token. */
function TableRow({
  children,
  className,
  ...rest
}: { children: React.ReactNode; className?: string } & React.HTMLAttributes<HTMLTableRowElement>): JSX.Element {
  return (
    <tr {...rest} className={['border-b border-[color:var(--border-subtle)]', className ?? ''].join(' ')}>
      {children}
    </tr>
  )
}

Table.Head = TableHead
Table.Cell = TableCell
Table.Row = TableRow

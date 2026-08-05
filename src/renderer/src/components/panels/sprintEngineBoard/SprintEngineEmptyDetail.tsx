import { EmptyState } from '../../ui'

// The detail column with nothing selected. The board's own copy of the centred
// empty pane, folded onto the kit's `EmptyState` (MC-2115) — what is left here
// is the one thing the kit does not own: the detail column's surface fill and
// its place in the flex row.

export function SprintEngineEmptyDetail({ message }: { message: string }) {
  return (
    <section className="flex min-w-0 flex-1 bg-[color:var(--bg-surface)]">
      <EmptyState title={message} className="flex-1" />
    </section>
  )
}

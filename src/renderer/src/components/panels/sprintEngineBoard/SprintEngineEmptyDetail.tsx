// Shared empty-state panel rendered by the Inbox and Roster views when no
// inspector content is selected. Centered, low-contrast copy that keeps the
// detail column readable without competing with the list pane.

export function SprintEngineEmptyDetail({ message }: { message: string }) {
  return (
    <section className="flex min-w-0 flex-1 items-center justify-center bg-[color:var(--bg-surface)] p-6 text-center">
      <p className="max-w-md text-[12px] leading-5 text-[color:var(--text-muted)]">
        {message}
      </p>
    </section>
  )
}

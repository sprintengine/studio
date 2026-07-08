// AgentWorkingDots — the "an agent is working right now" marker for workspace
// rows: three staggered accent dots (~12px wide). Motion is pure CSS keyframes
// (`agent-working-dot` in index.css) — no per-frame JS; reduced motion collapses
// it to a single static accent dot via the same stylesheet. Use only while work
// is genuinely live, never as ambient decoration.
export function AgentWorkingDots({ label }: { label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="agent-working-dots inline-flex w-[14px] shrink-0 items-center justify-center gap-[2px]"
    >
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          aria-hidden
          className="agent-working-dot inline-block h-[3px] w-[3px] rounded-full bg-[color:var(--accent-primary)]"
        />
      ))}
    </span>
  )
}

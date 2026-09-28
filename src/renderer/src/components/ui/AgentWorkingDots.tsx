// AgentWorkingDots — the app's one "working right now" marker: three staggered
// accent dots (~12px wide), on workspace rows, tabs, and anywhere else a
// process is live (StatusDot draws it for a live good or accent tone). Motion
// is pure CSS keyframes (`agent-working-dot` in index.css) — no per-frame JS;
// reduced motion stills the three dots via the same stylesheet. Use only while
// work is genuinely live, never as ambient decoration.
//
// `label` names the state for a mark that stands alone; omit it when adjacent
// text already says "working", and the mark is decorative.
export function AgentWorkingDots({ label, className }: { label?: string; className?: string }) {
  return (
    <span
      {...(label ? { role: 'img', 'aria-label': label, title: label } : { 'aria-hidden': true })}
      className={`agent-working-dots inline-flex w-[14px] shrink-0 items-center justify-center gap-[2px] ${className ?? ''}`}
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

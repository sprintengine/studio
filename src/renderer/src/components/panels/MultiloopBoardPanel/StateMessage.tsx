import { StatusDot, type Tone } from '../../ui'

export function StateMessage({ title, message, tone }: { title: string; message: string; tone: 'empty' | 'error' | 'loading' }) {
  const dotTone: Tone = tone === 'error' ? 'error' : tone === 'loading' ? 'accent' : 'neutral'
  return (
    <section
      className="flex h-full min-w-0 items-center justify-center bg-[color:var(--bg-app)] px-6 text-center text-[color:var(--text-default)] [overflow-wrap:anywhere]"
      role={tone === 'loading' ? 'status' : 'region'}
      aria-live="polite"
    >
      <div className="min-w-0 max-w-md rounded-[7px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] p-4">
        <div className="flex items-center justify-center gap-2">
          <StatusDot tone={dotTone} pulse={tone === 'loading'} />
          <h1 className="text-[13px] font-semibold text-[color:var(--text-strong)]">{title}</h1>
        </div>
        <p className="mt-2 text-[12px] leading-[1.5] text-[color:var(--text-muted)]">{message}</p>
      </div>
    </section>
  )
}

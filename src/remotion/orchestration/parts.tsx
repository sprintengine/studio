// Shared primitives, entrance hooks, and persistent app-shell chrome for the
// Sprint Engine orchestration film. Motion comes only from the frame — no CSS
// transitions or Tailwind animate-* (they do not render in Remotion).

import { Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import type { CSSProperties, ReactNode } from 'react'

import {
  baseFont,
  entranceBezier,
  ink,
  model as modelTable,
  monoFont,
  premiumBezier,
  roleAccent,
  roleLabel,
  vendor as vendorTable,
  type ModelId,
  type RoleId,
} from './tokens'

// ---------- entrance hooks (spring-driven, reused across scenes) ----------

export function useFadeIn(startFrame: number, durationInFrames = 18): number {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return spring({
    frame: frame - startFrame,
    fps,
    durationInFrames,
    config: { damping: 200 },
  })
}

// Enter → hold → exit envelope, so a scene can fade its content in and out
// against the persistent shell. Returns 0..1.
export function useSceneEnvelope(
  start: number,
  end: number,
  fadeIn = 18,
  fadeOut = 16,
): number {
  const frame = useCurrentFrame()
  const local = frame - start
  const span = end - start
  return interpolate(
    local,
    [0, fadeIn, span - fadeOut, span],
    [0, 1, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(...premiumBezier),
    },
  )
}

export function easeBezier(
  frame: number,
  input: [number, number],
  output: [number, number],
  bezier: readonly [number, number, number, number] = entranceBezier,
): number {
  return interpolate(frame, input, output, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(bezier[0], bezier[1], bezier[2], bezier[3]),
  })
}

// ---------- brand mark ----------

export function MulticodeMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={`mc-left-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#f4f4f5" />
          <stop offset="100%" stopColor="#7a7a82" />
        </linearGradient>
        <linearGradient id={`mc-right-${size}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#9a9aa2" />
          <stop offset="100%" stopColor="#3a3a44" />
        </linearGradient>
      </defs>
      <path d="M4 3.5 L16 13.5 L16 28.5 L4 28.5 Z" fill={`url(#mc-left-${size})`} />
      <path d="M28 3.5 L16 13.5 L16 28.5 L28 28.5 Z" fill={`url(#mc-right-${size})`} />
      <path d="M16 13.5 L16 28.5" stroke="#08090b" strokeWidth="0.4" strokeOpacity="0.6" />
    </svg>
  )
}

// ---------- role avatar (accent glyph square) ----------

function roleInitials(role: RoleId): string {
  const label = roleLabel[role]
  const parts = label.replace('/', ' ').split(' ').filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return label.slice(0, 2).toUpperCase()
}

export function RoleAvatar({ role, size = 34 }: { role: RoleId; size?: number }) {
  const accent = roleAccent[role]
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `${accent}1f`,
        border: `1px solid ${accent}66`,
        color: accent,
        fontSize: Math.round(size * 0.34),
        fontWeight: 800,
        flexShrink: 0,
        ...baseFont,
      }}
    >
      {roleInitials(role)}
    </span>
  )
}

// ---------- vendor / model chip (the "bring your own model" signal) ----------

export function ModelChip({ modelId, dim = false }: { modelId: ModelId; dim?: boolean }) {
  const entry = modelTable[modelId]
  const dot = vendorTable[entry.vendor].dot
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px 3px 7px',
        borderRadius: 999,
        border: `1px solid ${ink.hairline}`,
        background: ink.surface,
        opacity: dim ? 0.55 : 1,
        ...monoFont,
      }}
    >
      <span style={{ width: 7, height: 7, borderRadius: 999, background: dot, flexShrink: 0 }} />
      <span style={{ color: ink.text, fontSize: 12, fontWeight: 500 }}>{entry.label}</span>
    </span>
  )
}

// ---------- caption bar (single message per scene, lower third) ----------

export function CaptionBar({
  kicker,
  caption,
  progress,
}: {
  kicker: string
  caption: string
  progress: number
}) {
  const y = easeBezier(progress, [0, 1], [26, 0])
  return (
    <div
      style={{
        position: 'absolute',
        left: 54,
        right: 54,
        bottom: 40,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        opacity: progress,
        transform: `translateY(${y}px)`,
      }}
    >
      <div
        style={{
          ...monoFont,
          color: ink.accent,
          fontSize: 14,
          letterSpacing: 1.4,
          textTransform: 'uppercase',
        }}
      >
        {kicker}
      </div>
      <div style={{ ...baseFont, color: ink.textStrong, fontSize: 30, fontWeight: 600, lineHeight: 1.25 }}>
        {caption}
      </div>
    </div>
  )
}

// ---------- persistent app shell (top bar + workspace sidebar) ----------

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div style={shell.root}>
      <div style={shell.topBar}>
        <div style={shell.brand}>
          <MulticodeMark size={26} />
          <span style={shell.brandText}>multicode</span>
        </div>
        <div style={shell.tabs}>
          <span style={shell.tabActive}>
            <span style={shell.seDot} />
            Sprint Engine
          </span>
          <span style={shell.tab}>Switchboard</span>
          <span style={shell.tab}>Watchtower</span>
        </div>
        <div style={shell.topRight}>Local workspace</div>
      </div>
      <aside style={shell.sidebar}>
        <div style={shell.sidebarLabel}>Workspaces</div>
        <div style={shell.workspaceActive}>
          <span style={shell.seDot} />
          <span>Metering &amp; billing</span>
        </div>
        <div style={shell.workspaceItem}>Realtime presence</div>
        <div style={shell.workspaceItem}>Onboarding revamp</div>
        <div style={shell.sidebarFoot}>
          <MulticodeMark size={52} />
        </div>
      </aside>
      <div style={shell.stage}>{children}</div>
    </div>
  )
}

const shell: Record<string, CSSProperties> = {
  root: {
    position: 'absolute',
    inset: 54,
    overflow: 'hidden',
    borderRadius: 22,
    border: `1px solid ${ink.hairline}`,
    background: ink.shell,
    boxShadow: '0 40px 140px rgba(0,0,0,0.55)',
  },
  topBar: {
    position: 'absolute',
    inset: '0 0 auto 0',
    height: 66,
    display: 'flex',
    alignItems: 'center',
    gap: 32,
    padding: '0 24px',
    borderBottom: `1px solid ${ink.hairline}`,
    background: ink.shell,
    ...baseFont,
  },
  brand: { display: 'flex', alignItems: 'center', gap: 11 },
  brandText: { color: ink.textStrong, fontWeight: 650, fontSize: 22 },
  tabs: { display: 'flex', gap: 6 },
  tabActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 12px',
    borderRadius: 8,
    background: ink.hover,
    color: ink.textStrong,
    fontSize: 14,
  },
  tab: { padding: '7px 12px', borderRadius: 8, color: ink.textMuted, fontSize: 14 },
  seDot: { width: 7, height: 7, borderRadius: 999, background: ink.gold, flexShrink: 0 },
  topRight: { marginLeft: 'auto', color: ink.textMuted, fontSize: 13 },
  sidebar: {
    position: 'absolute',
    top: 66,
    bottom: 0,
    left: 0,
    width: 220,
    padding: 18,
    borderRight: `1px solid ${ink.hairline}`,
    background: ink.surface,
    ...baseFont,
  },
  sidebarLabel: { color: ink.textSubtle, fontSize: 11, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 },
  workspaceActive: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '9px 10px',
    borderRadius: 8,
    background: ink.accentSoft,
    color: ink.textStrong,
    fontSize: 13.5,
  },
  workspaceItem: { padding: '9px 10px', color: ink.textMuted, fontSize: 13.5 },
  sidebarFoot: { position: 'absolute', bottom: 24, left: 82, opacity: 0.18 },
  stage: { position: 'absolute', top: 66, right: 0, bottom: 0, left: 220 },
}

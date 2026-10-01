import { useSyncExternalStore, type CSSProperties } from 'react'
import type { AnsiColor, AnsiLine, AnsiSpan } from '../../../../../shared/conversation/ansi'
import { getTerminalAnsiPalette, getTerminalThemeEpoch, subscribeTerminalTheme } from '../../../utils/terminalTheme'

function colorValue(color: AnsiColor | undefined, palette: string[]): string | undefined {
  if (!color) return undefined
  if (color.kind === 'rgb') return `rgb(${color.r} ${color.g} ${color.b})`
  if (color.index < 16) return palette[color.index]
  if (color.index < 232) {
    const value = color.index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    return `rgb(${steps[Math.floor(value / 36)]} ${steps[Math.floor(value / 6) % 6]} ${steps[value % 6]})`
  }
  const gray = 8 + (color.index - 232) * 10
  return `rgb(${gray} ${gray} ${gray})`
}

function spanStyle(span: AnsiSpan, palette: string[]): CSSProperties {
  const foreground = colorValue(span.fg, palette) ?? 'var(--terminal-fg)'
  const background = colorValue(span.bg, palette) ?? 'var(--terminal-bg)'
  return {
    color: span.inverse ? background : foreground,
    backgroundColor: span.inverse ? foreground : span.bg ? background : undefined,
    fontWeight: span.bold ? 'var(--sem-font-weight-emphasis)' : undefined,
    fontStyle: span.italic ? 'italic' : undefined,
    textDecoration:
      [span.underline ? 'underline' : '', span.strike ? 'line-through' : ''].filter(Boolean).join(' ') || undefined,
    opacity: span.dim ? 'var(--sem-opacity-dimmed)' : undefined,
  }
}

export function AnsiOutput({ lines }: { lines: AnsiLine[] }) {
  useSyncExternalStore(subscribeTerminalTheme, getTerminalThemeEpoch, getTerminalThemeEpoch)
  const palette = getTerminalAnsiPalette()
  return (
    <div className="overflow-x-auto whitespace-pre-wrap font-mono">
      {lines.map((line, lineIndex) => (
        <div key={lineIndex}>
          {line.length
            ? line.map((span, spanIndex) => (
                <span key={spanIndex} style={spanStyle(span, palette)}>
                  {span.text}
                </span>
              ))
            : '\u00a0'}
        </div>
      ))}
    </div>
  )
}

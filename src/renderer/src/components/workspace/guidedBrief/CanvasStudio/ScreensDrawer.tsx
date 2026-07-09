import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { TruncatedText } from '../../../ui'
import type { CanvasScreen } from './canvasStudioModel'

// The floating screens drawer for the 7+ screen case (MC-1510): one row per
// real page, name + wireframe thumbnail, roving focus (Arrow/Home/End),
// Enter/Space selects, Escape closes and returns focus to the Screens button
// (the shell restores it via `onClose`). ≤6 screens never reach here — they
// ride inline in the toolbar pill.

type Props = {
  screens: CanvasScreen[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: () => void
}

export function ScreensDrawer({ screens, activeId, onSelect, onClose }: Props) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([])
  const selectedIndex = Math.max(
    0,
    screens.findIndex((screen) => screen.id === activeId),
  )
  const [focusIndex, setFocusIndex] = useState(selectedIndex)
  const openedRef = useRef(false)

  // Focus the active row once when the drawer opens so keyboard users land
  // inside it; later row focus is user-driven.
  useEffect(() => {
    if (openedRef.current) return
    openedRef.current = true
    rowRefs.current[selectedIndex]?.focus()
  }, [selectedIndex])

  const focusRow = (next: number) => {
    const clamped = Math.max(0, Math.min(screens.length - 1, next))
    setFocusIndex(clamped)
    rowRefs.current[clamped]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault()
        focusRow(focusIndex + 1)
        break
      case 'ArrowUp':
        event.preventDefault()
        focusRow(focusIndex - 1)
        break
      case 'Home':
        event.preventDefault()
        focusRow(0)
        break
      case 'End':
        event.preventDefault()
        focusRow(screens.length - 1)
        break
      default:
        break
    }
  }

  return (
    <div
      role="dialog"
      aria-label="Screens"
      onKeyDown={onKeyDown}
      className="absolute bottom-5 left-5 top-16 z-30 flex w-60 max-w-[calc(100%-2.5rem)] flex-col overflow-hidden rounded-[9px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] shadow-[var(--shadow-drawer)]"
    >
      <div className="flex shrink-0 items-baseline justify-between border-b border-[color:var(--border-subtle)] px-3.5 py-2.5">
        <span className="text-[12px] font-semibold text-[color:var(--text-strong)]">Screens</span>
        <span className="text-[11px] tabular-nums text-[color:var(--text-subtle)]">
          {screens.length}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1.5">
        {screens.map((screen, index) => {
          const isSelected = screen.id === activeId
          return (
            <button
              key={screen.id}
              ref={(element) => {
                rowRefs.current[index] = element
              }}
              type="button"
              aria-selected={isSelected}
              tabIndex={index === focusIndex ? 0 : -1}
              onFocus={() => setFocusIndex(index)}
              onClick={() => {
                onSelect(screen.id)
                onClose()
              }}
              className={`
                flex w-full items-center gap-2.5 border-l-2 py-1.5 pl-3 pr-3.5 text-left outline-none transition-colors
                focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[color:var(--border-focus)]
                ${
                  isSelected
                    ? 'border-[color:var(--accent-primary)] bg-[color:var(--accent-primary-soft)]'
                    : 'border-transparent hover:bg-[color:var(--bg-hover)]'
                }
              `}
            >
              <ScreenThumbnail />
              <TruncatedText
                as="span"
                text={screen.name}
                className="min-w-0 font-mono text-[11.5px] text-[color:var(--text-strong)]"
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// A neutral wireframe glyph — a title bar over a body block — so each row reads
// as a screen at a glance without rendering (and reflowing) a live preview.
function ScreenThumbnail() {
  return (
    <span
      aria-hidden="true"
      className="relative h-5 w-[30px] shrink-0 overflow-hidden rounded-[3px] border border-[color:var(--border-subtle)] bg-[color:var(--bg-surface)]"
    >
      <span className="absolute left-[3px] right-3 top-[3px] h-[3px] rounded-[1px] bg-[color:var(--bg-selected)]" />
      <span className="absolute bottom-[3px] left-[3px] right-[5px] top-[9px] rounded-[1px] bg-[color:var(--bg-hover)]" />
    </span>
  )
}

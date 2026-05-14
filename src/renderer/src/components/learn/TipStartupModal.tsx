import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, ModalButton } from '../ui/Modal'
import { StatusDot } from '../ui'
import { useWorkspaceStore } from '../../store/workspaceStore'
import { LEARNING_CATEGORY_LABELS } from '../../content/learning/types'
import type { LearningAction, LearningItem } from '../../content/learning/types'
import { pickStartupTip } from '../../content/learning/selectors'
import type { LearningContext } from '../../content/learning/selectors'

type TipStartupModalProps = {
  open: boolean
  context: LearningContext
  onClose: () => void
  onOpenLearnCenter: () => void
  onSettingsTab?: (tabId: string) => void
}

export function TipStartupModal({
  open,
  context,
  onClose,
  onOpenLearnCenter,
  onSettingsTab,
}: TipStartupModalProps) {
  const learning = useWorkspaceStore((s) => s.appSettings.learning)
  const setLearningShowTipsOnStartup = useWorkspaceStore((s) => s.setLearningShowTipsOnStartup)
  const markLearningTipSeen = useWorkspaceStore((s) => s.markLearningTipSeen)

  const initialSelection = useMemo(
    () =>
      pickStartupTip(context, learning?.seenTipIds ?? [], learning?.lastShownTipId ?? null),
    // Stable rotation while the modal is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open]
  )

  const [position, setPosition] = useState(0)

  useEffect(() => {
    if (!open || !initialSelection) return
    setPosition(initialSelection.index)
  }, [open, initialSelection])

  const rotation = initialSelection?.rotation ?? []
  const currentTip: LearningItem | null = rotation.length > 0 ? rotation[position % rotation.length] : null

  useEffect(() => {
    if (!open || !currentTip) return
    markLearningTipSeen(currentTip.id)
  }, [open, currentTip, markLearningTipSeen])

  const handlePrevious = useCallback(() => {
    if (rotation.length === 0) return
    setPosition((p) => (p - 1 + rotation.length) % rotation.length)
  }, [rotation.length])

  const handleNext = useCallback(() => {
    if (rotation.length === 0) return
    setPosition((p) => (p + 1) % rotation.length)
  }, [rotation.length])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        handlePrevious()
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        handleNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, handlePrevious, handleNext])

  const handleAction = useCallback(
    (action: LearningAction | undefined) => {
      if (!action) return
      switch (action.kind) {
        case 'open-learn-center':
          onClose()
          onOpenLearnCenter()
          return
        case 'open-settings-tab': {
          const tab = action.args?.tab
          if (tab && onSettingsTab) {
            onClose()
            onSettingsTab(tab)
          }
          return
        }
        case 'open-url': {
          const url = action.args?.url
          if (url) window.open(url, '_blank', 'noopener,noreferrer')
          return
        }
      }
    },
    [onClose, onOpenLearnCenter, onSettingsTab]
  )

  if (!open || !currentTip) return null

  const categoryLabel = LEARNING_CATEGORY_LABELS[currentTip.category]
  const canNavigate = rotation.length > 1
  const showTipsOnStartup = learning?.showTipsOnStartup ?? true

  // Single primary action. If the tip names its own action, use that. Otherwise,
  // offer Learn Center as the one forward path so the modal never has two
  // buttons saying the same thing.
  const primary: { label: string; onClick: () => void } = currentTip.action
    ? { label: currentTip.action.label, onClick: () => handleAction(currentTip.action) }
    : { label: 'Open Learn Center', onClick: () => { onClose(); onOpenLearnCenter() } }

  return (
    <Modal open={open} onClose={onClose} labelledBy="tip-startup-title" width={480}>
      <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <StatusDot tone="accent" label="Tip" />
            <span className="text-[11px] font-medium text-[color:var(--accent-primary)]">
              Tip
            </span>
            <span aria-hidden="true" className="text-[color:var(--border-default)]">·</span>
            <span className="text-[11px] font-medium text-[color:var(--text-muted)]">
              {categoryLabel}
            </span>
          </div>
          <h2
            id="tip-startup-title"
            className="mt-2 text-[16px] font-semibold leading-snug tracking-tight text-[color:var(--text-strong)]"
          >
            {currentTip.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md px-2 py-1 text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
        >
          <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3.5 3.5L12.5 12.5M12.5 3.5L3.5 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="px-5 pb-5 space-y-2.5">
        <p className="text-[13px] leading-[1.55] text-[color:var(--text-default)]">{currentTip.summary}</p>
        {currentTip.body ? (
          <p className="text-[12px] leading-[1.6] text-[color:var(--text-muted)]">{currentTip.body}</p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-[color:var(--border-subtle)] px-5 py-3">
        <label className="flex items-center gap-2 text-[11px] text-[color:var(--text-subtle)] hover:text-[color:var(--text-muted)] transition-colors">
          <input
            type="checkbox"
            checked={showTipsOnStartup}
            onChange={(event) => setLearningShowTipsOnStartup(event.target.checked)}
            className="h-3 w-3 rounded border-[color:var(--border-default)] bg-[color:var(--bg-surface)] text-[color:var(--accent-primary)] focus:ring-1 focus:ring-[color:var(--border-focus)]"
          />
          Show on startup
        </label>

        <div className="flex items-center gap-2">
          {canNavigate ? (
            <div className="flex items-center gap-1 pr-1">
              <TipPagerButton
                direction="prev"
                onClick={handlePrevious}
                label="Previous tip"
              />
              <span className="min-w-[34px] text-center text-[11px] tabular-nums text-[color:var(--text-muted)]">
                {position + 1}<span className="mx-0.5 text-[color:var(--border-strong)]">/</span>{rotation.length}
              </span>
              <TipPagerButton
                direction="next"
                onClick={handleNext}
                label="Next tip"
              />
            </div>
          ) : null}
          <ModalButton variant="primary" onClick={primary.onClick}>
            {primary.label}
          </ModalButton>
        </div>
      </div>
    </Modal>
  )
}

type TipPagerButtonProps = {
  direction: 'prev' | 'next'
  onClick: () => void
  label: string
}

function TipPagerButton({ direction, onClick, label }: TipPagerButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-md text-[color:var(--text-muted)] transition-colors hover:bg-[color:var(--bg-hover)] hover:text-[color:var(--text-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--border-focus)]"
    >
      <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {direction === 'prev' ? (
          <path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        )}
      </svg>
    </button>
  )
}

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
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
    // Only recompute when the modal opens — we want a stable rotation while the user is reading.
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

  return (
    <Modal open={open} onClose={onClose} labelledBy="tip-startup-title" width={520}>
      <ModalHeader
        title={currentTip.title}
        titleId="tip-startup-title"
        subtitle={`${categoryLabel} · Tip ${position + 1} of ${rotation.length}`}
        onClose={onClose}
      />
      <ModalBody className="space-y-3">
        <p className="text-[13px] leading-5 text-[#d7d7dc]">{currentTip.summary}</p>
        {currentTip.body ? (
          <p className="text-[12px] leading-5 text-[#9a9aa2]">{currentTip.body}</p>
        ) : null}
        <label className="mt-2 flex items-center gap-2 text-[12px] text-[#9a9aa2]">
          <input
            type="checkbox"
            checked={learning?.showTipsOnStartup ?? true}
            onChange={(event) => setLearningShowTipsOnStartup(event.target.checked)}
            className="h-3.5 w-3.5 rounded border-[#303139] bg-[#0d0e11] text-[#5c7cff] focus:ring-1 focus:ring-[#5c7cff]/60"
          />
          Show tips on startup
        </label>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={handlePrevious} disabled={!canNavigate}>
          Previous
        </ModalButton>
        <ModalButton onClick={handleNext} disabled={!canNavigate}>
          Next
        </ModalButton>
        <div className="flex-1" />
        <ModalButton onClick={onOpenLearnCenter}>Open Learn Center</ModalButton>
        {currentTip.action ? (
          <ModalButton variant="primary" onClick={() => handleAction(currentTip.action)}>
            {currentTip.action.label}
          </ModalButton>
        ) : (
          <ModalButton variant="primary" onClick={onClose}>
            Got it
          </ModalButton>
        )}
      </ModalFooter>
    </Modal>
  )
}

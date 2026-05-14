import { useEffect } from 'react'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import type { GuidedBriefStage } from './types'

const CONFIRM_BUTTON_ID = 'guided-brief-close-confirm'

type Props = {
  open: boolean
  stage: GuidedBriefStage | null
  onCancel: () => void
  onConfirm: () => void
}

function bodyCopyForStage(stage: GuidedBriefStage | null): string {
  switch (stage) {
    case 'strategist-working':
    case 'strategist-ready':
      return 'Closing now will end the live Product Strategist session. The idea seed and any accepted brief snapshot stay on disk.'
    case 'designer-working':
    case 'designer-ready':
      return 'Closing now will end the live Frontend Designer session. The accepted brief and any saved mockups stay on disk.'
    case 'handoff':
      return 'Closing now will skip Start the build. The accepted artifacts and product/build-handoff.md stay on disk.'
    default:
      return 'Closing now will end the live Guided brief session. Accepted artifacts stay on disk.'
  }
}

export function GuidedBriefCloseConfirmation({ open, stage, onCancel, onConfirm }: Props) {
  const titleId = 'guided-brief-close-title'

  useEffect(() => {
    if (!open) return
    const handle = window.requestAnimationFrame(() => {
      document.getElementById(CONFIRM_BUTTON_ID)?.focus()
    })
    return () => window.cancelAnimationFrame(handle)
  }, [open])

  if (!open) return null

  return (
    <Modal open onClose={onCancel} labelledBy={titleId} width={460}>
      <ModalHeader
        title="Close the guided brief?"
        subtitle="The wizard holds a live specialist session you have not handed off yet."
        titleId={titleId}
        onClose={onCancel}
      />
      <ModalBody>
        <p className="text-[13px] leading-6 text-[color:var(--text-default)]">
          {bodyCopyForStage(stage)}
        </p>
      </ModalBody>
      <ModalFooter>
        <ModalButton variant="ghost" onClick={onCancel}>
          Keep working
        </ModalButton>
        <ModalButton id={CONFIRM_BUTTON_ID} variant="danger" onClick={onConfirm}>
          Close anyway
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}

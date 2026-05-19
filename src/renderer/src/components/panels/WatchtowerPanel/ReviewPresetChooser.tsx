import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { Select } from '../../ui'
import { WATCHTOWER_REVIEW_PRESETS, getWatchtowerReviewSector, type WatchtowerReviewPresetId } from '../../../utils/watchtowerReview'
import { getSpecialistAction } from '../../../specialists/specialistActions'
import type { SpecialistActionId } from '../../../types/workspace'

export function ReviewPresetChooser({
  preset,
  onPresetChange,
  onClose,
  onStart,
  starting,
}: {
  preset: WatchtowerReviewPresetId
  onPresetChange: (next: WatchtowerReviewPresetId) => void
  onClose: () => void
  onStart: () => void
  starting: boolean
}) {
  const selectedPreset =
    WATCHTOWER_REVIEW_PRESETS.find((item) => item.id === preset) ?? WATCHTOWER_REVIEW_PRESETS[0]
  const presetAgents = Object.entries(selectedPreset.agents)
  const hasAgents = presetAgents.some(([, sectors]) => (sectors ?? []).length > 0)

  return (
    <Modal open onClose={onClose} contained labelledBy="watchtower-review-title" width={520}>
      <ModalHeader title="Run a review" titleId="watchtower-review-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Preset">
          <Select<WatchtowerReviewPresetId>
            ariaLabel="Review preset"
            items={WATCHTOWER_REVIEW_PRESETS.filter((item) => item.id !== 'custom').map((item) => ({
              value: item.id,
              label: item.label,
            }))}
            value={preset}
            onChange={(value) => onPresetChange(value)}
          />
        </Field>
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] text-[color:var(--text-muted)]">Agents</div>
          {hasAgents ? (
            <ul className="flex flex-col gap-1">
              {presetAgents.map(([specialistId, sectors]) => {
                const specialist = getSpecialistAction(specialistId as SpecialistActionId)
                const labels = (sectors ?? []).map((sector) => getWatchtowerReviewSector(sector).label)
                return (
                  <li
                    key={specialistId}
                    className="flex min-w-0 items-baseline gap-2 rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-2 py-1.5 text-[12px]"
                  >
                    <span className="shrink-0 font-medium text-[color:var(--text-strong)]">
                      {specialist.shortLabel}
                    </span>
                    <span className="min-w-0 truncate text-[color:var(--text-muted)]">
                      {labels.join(', ') || 'No sectors'}
                    </span>
                  </li>
                )
              })}
            </ul>
          ) : (
            <div className="text-[12px] text-[color:var(--text-muted)]">
              This preset has no agents. Pick another preset to start a review.
            </div>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton
          variant="primary"
          onClick={onStart}
          disabled={starting || !hasAgents}
        >
          {starting ? 'Starting…' : 'Start review'}
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}


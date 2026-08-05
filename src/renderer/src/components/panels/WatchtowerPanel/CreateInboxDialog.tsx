import { Field, Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { FOCUS_RING_CLASS, Select } from '../../ui'
import type { DraftTask } from './types'

export function CreateInboxDialog({
  draft,
  onChange,
  onClose,
  onSubmit,
  busy,
}: {
  draft: DraftTask
  onChange: (next: DraftTask) => void
  onClose: () => void
  onSubmit: () => void
  busy: boolean
}) {
  const inputClass =
    'block w-full rounded-[5px] border border-[color:var(--border-default)] bg-[color:var(--bg-surface)] px-3 py-2 text-body ' +
    `text-[color:var(--text-strong)] placeholder:text-[color:var(--text-disabled)] ${FOCUS_RING_CLASS}`
  return (
    <Modal open onClose={onClose} contained labelledBy="watchtower-create-title" size="standard">
      <ModalHeader title="New inbox task" titleId="watchtower-create-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Title">
          <input
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            placeholder="Short triage title"
            className={inputClass}
            autoFocus
          />
        </Field>
        <Field label="Description">
          <textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={4}
            placeholder="What did you observe? What should the next reader know?"
            className={`${inputClass} resize-y leading-6`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select<string>
              ariaLabel="Task priority"
              items={[
                { value: '', label: 'No priority' },
                { value: '0', label: 'Urgent' },
                { value: '1', label: 'High' },
                { value: '2', label: 'Medium' },
                { value: '3', label: 'Low' },
              ]}
              value={draft.priority == null ? '' : String(draft.priority)}
              onChange={(value) => onChange({ ...draft, priority: value === '' ? null : Number(value) })}
            />
          </Field>
          <Field label="Identifier">
            <input
              value={draft.identifier}
              onChange={(event) => onChange({ ...draft, identifier: event.target.value })}
              placeholder="WT-7"
              className={`${inputClass} h-9 py-0`}
            />
          </Field>
        </div>
        <Field label="Labels (comma separated)">
          <input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="bug, auth"
            className={`${inputClass} h-9 py-0`}
          />
        </Field>
      </ModalBody>
      <ModalFooter>
        <ModalButton onClick={onClose}>Cancel</ModalButton>
        <ModalButton
          variant="primary"
          onClick={onSubmit}
          disabled={busy || !draft.title.trim()}
        >
          Create in inbox
        </ModalButton>
      </ModalFooter>
    </Modal>
  )
}


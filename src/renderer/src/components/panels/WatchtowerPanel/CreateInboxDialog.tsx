import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../../ui/Modal'
import { Field, Input, Select, Textarea } from '../../ui'
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
  return (
    <Modal open onClose={onClose} contained labelledBy="watchtower-create-title" size="standard">
      <ModalHeader title="New inbox task" titleId="watchtower-create-title" onClose={onClose} />
      <ModalBody className="space-y-3">
        <Field label="Title" htmlFor="watchtower-create-title-field">
          <Input
            value={draft.title}
            onChange={(event) => onChange({ ...draft, title: event.target.value })}
            placeholder="Short triage title"
            size="md"
            autoFocus
          />
        </Field>
        <Field label="Description" htmlFor="watchtower-create-description">
          <Textarea
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            rows={4}
            placeholder="What did you observe? What should the next reader know?"
            size="md"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority" htmlFor="watchtower-create-priority">
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
          <Field label="Identifier" htmlFor="watchtower-create-identifier">
            <Input
              value={draft.identifier}
              onChange={(event) => onChange({ ...draft, identifier: event.target.value })}
              placeholder="WT-7"
              size="md"
            />
          </Field>
        </div>
        <Field label="Labels (comma separated)" htmlFor="watchtower-create-labels">
          <Input
            value={draft.labels}
            onChange={(event) => onChange({ ...draft, labels: event.target.value })}
            placeholder="bug, auth"
            size="md"
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

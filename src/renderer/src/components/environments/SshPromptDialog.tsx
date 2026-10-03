import React, { useCallback, useEffect, useId, useState } from 'react'

import type { SshPromptRequest } from '../../../../shared/ssh-environments'
import { Field } from '../ui/Field'
import { Input } from '../ui/Input'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'

// What ssh asks while Studio connects to an SSH machine (phase 8 spec, 5.5),
// one question at a time, in this window. Main classified each from ssh's
// own words; a question the remote wrote is shown verbatim inside a frame
// that names the machine, so it can never pass for one of these.
//
// Nothing here is remembered: the answer goes to main, which writes it to
// ssh's askpass and keeps no copy (decision R26). The Trust button for a new
// host key is never the focused default: trusting is a choice, not a reflex.

type Api = Pick<Window['api'], 'onSshPrompt' | 'onSshPromptClosed' | 'sshPromptAnswer'>

const TEXT = 'text-body leading-5 text-[color:var(--text-default)]'
const MUTED = 'text-body leading-5 text-[color:var(--text-muted)]'
const FRAME = 'rounded-md border border-[color:var(--border-default)] bg-[color:var(--bg-surface-raised)] px-3 py-2'

function titleFor(request: SshPromptRequest): string {
  switch (request.kind) {
    case 'host-key':
      return `New machine: ${request.label}`
    case 'passphrase':
      return 'The passphrase for your SSH key'
    case 'password':
      return `Your password on ${request.label}`
    case 'confirm':
      return 'Use your SSH key?'
    case 'touch':
      return 'Touch your security key'
    case 'remote':
      return `${request.label} asks`
  }
}

function needsInput(request: SshPromptRequest): boolean {
  return request.kind === 'passphrase' || request.kind === 'password' || request.kind === 'remote'
}

export function SshPromptDialogBody({
  request,
  onAnswer,
}: {
  request: SshPromptRequest
  onAnswer: (answer: string | null) => void
}) {
  const titleId = useId()
  const inputId = useId()
  const [value, setValue] = useState('')
  const cancel = () => onAnswer(null)
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault()
    if (request.kind === 'host-key') onAnswer('yes')
    else if (request.kind === 'confirm') onAnswer('yes')
    else if (needsInput(request)) onAnswer(value)
  }
  const hostKey = request.hostKey
  return (
    <Modal open onClose={cancel} labelledBy={titleId} size="confirm">
      <form onSubmit={submit}>
        <ModalHeader title={titleFor(request)} titleId={titleId} onClose={cancel} />
        <ModalBody className="flex flex-col gap-3">
          {request.kind === 'host-key' && hostKey ? (
            <>
              <p className={TEXT}>
                Studio has not connected to {request.label} before. Check this fingerprint with whoever runs the machine
                before you trust it.
              </p>
              <dl className="flex flex-col gap-1">
                <dt className={MUTED}>Host</dt>
                <dd className={`${TEXT} font-mono`}>{hostKey.host}</dd>
                <dt className={MUTED}>{hostKey.keyType} key fingerprint</dt>
                <dd className={`${TEXT} break-all font-mono`} data-testid="ssh-fingerprint">
                  {hostKey.fingerprint}
                </dd>
              </dl>
            </>
          ) : null}
          {request.kind === 'passphrase' || request.kind === 'password' || request.kind === 'confirm' ? (
            <p className={TEXT}>{request.text}</p>
          ) : null}
          {request.kind === 'touch' ? (
            <p className={TEXT}>Touch your security key to sign in to {request.label}.</p>
          ) : null}
          {request.kind === 'remote' ? (
            <>
              <p className={MUTED}>{request.label} asks:</p>
              <div className={FRAME}>
                <p className={`${TEXT} whitespace-pre-wrap break-words`} data-testid="ssh-remote-text">
                  {request.text}
                </p>
              </div>
            </>
          ) : null}
          {needsInput(request) ? (
            <Field
              label={request.kind === 'remote' ? 'Answer' : request.kind === 'password' ? 'Password' : 'Passphrase'}
              htmlFor={inputId}
            >
              <Input
                id={inputId}
                type="password"
                autoComplete="off"
                autoFocus
                value={value}
                onChange={(event) => setValue(event.target.value)}
              />
            </Field>
          ) : null}
          {request.kind === 'passphrase' ? (
            <p className={MUTED}>Studio does not keep it. Add the key to ssh-agent to stop being asked.</p>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <ModalButton type="button" onClick={cancel} autoFocus={!needsInput(request)}>
            Cancel
          </ModalButton>
          {request.kind === 'touch' ? null : (
            <ModalButton type="submit" variant="primary">
              {request.kind === 'host-key' ? 'Trust and connect' : request.kind === 'confirm' ? 'Allow' : 'Continue'}
            </ModalButton>
          )}
        </ModalFooter>
      </form>
    </Modal>
  )
}

/** Mounted once per workspace window: shows main's SSH questions as they come, one at a time. */
export function SshPromptDialogHost({ api = window.api }: { api?: Api }) {
  const [queue, setQueue] = useState<SshPromptRequest[]>([])
  useEffect(() => {
    if (!api?.onSshPrompt) return undefined
    const offPrompt = api.onSshPrompt((request) => setQueue((current) => [...current, request]))
    const offClosed = api.onSshPromptClosed((id) => setQueue((current) => current.filter((entry) => entry.id !== id)))
    return () => {
      offPrompt()
      offClosed()
    }
  }, [api])
  const current = queue[0] ?? null
  useEffect(() => {
    if (!current) return undefined
    // Main gives up at the same moment; the dialog does not outstay it.
    const timer = setTimeout(
      () => setQueue((entries) => entries.filter((entry) => entry.id !== current.id)),
      Math.max(0, current.expiresAt - Date.now()),
    )
    return () => clearTimeout(timer)
  }, [current])
  const answer = useCallback(
    (value: string | null) => {
      if (!current) return
      api.sshPromptAnswer(current.id, value)
      setQueue((entries) => entries.filter((entry) => entry.id !== current.id))
    },
    [api, current],
  )
  if (!current) return null
  return <SshPromptDialogBody key={current.id} request={current} onAnswer={answer} />
}

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
  // Words a remote could have written itself never get a title of Studio's own.
  if (request.unverified) return `ssh or ${request.label} asks`
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
    case 'sign-in':
      return `Sign in on ${request.label}`
  }
}

function needsInput(request: SshPromptRequest): boolean {
  return (
    request.kind === 'passphrase' ||
    request.kind === 'password' ||
    request.kind === 'remote' ||
    (request.kind === 'sign-in' && request.signIn?.paste === true)
  )
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
    else if (request.kind === 'sign-in' && !value.trim()) return
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
          {request.unverified ? (
            <>
              <p className={MUTED}>ssh or {request.label} asks:</p>
              <div className={FRAME}>
                <p className={`${TEXT} whitespace-pre-wrap break-words`} data-testid="ssh-unverified-text">
                  {request.text}
                </p>
              </div>
              <p className={MUTED}>
                This computer's OpenSSH is older than 8.4 and does not mark the questions a machine asks, so Studio
                can't tell whether this one comes from ssh here or from {request.label}. Answer only if you expected it.
              </p>
            </>
          ) : request.kind === 'passphrase' || request.kind === 'password' || request.kind === 'confirm' ? (
            <p className={TEXT}>{request.text}</p>
          ) : null}
          {request.kind === 'touch' ? (
            <p className={TEXT}>Touch your security key to sign in to {request.label}.</p>
          ) : null}
          {request.kind === 'sign-in' && request.signIn ? (
            <>
              <p className={TEXT}>{request.text}</p>
              <p className={MUTED}>
                {request.signIn.code
                  ? 'Open the link in your browser here, sign in, and enter this code there:'
                  : request.signIn.paste
                    ? 'Open the link in your browser here, sign in, and paste the code the page shows below.'
                    : 'Open the link in your browser here and sign in. This closes by itself when the machine is signed in.'}
              </p>
              <div className={FRAME}>
                <p className={`${TEXT} break-all font-mono`} data-testid="ssh-sign-in-url">
                  {request.signIn.url}
                </p>
              </div>
              {request.signIn.code ? (
                <p className={`${TEXT} font-mono`} data-testid="ssh-sign-in-code">
                  {request.signIn.code}
                </p>
              ) : null}
              <ModalButton type="button" onClick={() => void window.api?.openExternal?.(request.signIn!.url)}>
                Open in browser
              </ModalButton>
            </>
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
                type={request.kind === 'sign-in' ? 'text' : 'password'}
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
          {request.kind === 'touch' || (request.kind === 'sign-in' && !request.signIn?.paste) ? null : (
            <ModalButton
              type="submit"
              variant="primary"
              // A login waiting for a pasted code is not sent an empty one.
              disabled={request.kind === 'sign-in' && !value.trim()}
            >
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

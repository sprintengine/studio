import React, { useCallback, useEffect, useId, useMemo, useRef, useState, type JSX } from 'react'

import { conversationProviderForCli, CONVERSATION_DEFAULT_MODEL_ID } from '../../../../shared/conversation-harness'
import {
  EXTENSION_BUILDER_SKILL_ID,
  extensionIdFromName,
  type ExtensionScaffoldCheck,
  type ExtensionScaffoldFolderPick,
  type ExtensionTemplateSummary,
} from '../../../../shared/extension-scaffold'
import { DEFAULT_AGENT_SPAWN_PERMISSION_PRESET, normalizeSelectedCli } from '../../store/slices/settingsSlice'
import { useWorkspaceStore } from '../../store/workspaceStore'
import {
  Badge,
  CardButton,
  Field,
  InlineNotice,
  Input,
  LinkButton,
  OutlineButton,
  Popover,
  Skeleton,
  Textarea,
  TriggerButton,
} from '../ui'
import { resolveCliPermissionPreset } from '../ui/cliPermissionPresets'
import { Modal, ModalBody, ModalButton, ModalFooter, ModalHeader } from '../ui/Modal'
import type { Tone } from '../ui/tokens'
import { engineNames, useAgentCliCatalogOptions } from '../workspace/agentComposer/useAgentComposer'
import { LaunchModelPicker, type CardLaunchChoice } from '../workspace/globalSurface/extensions/home/CardGoPicker'
import { getBuildExtensionHost } from './buildExtensionHost'
import { buildExtensionBlocker, buildExtensionIdeaMarkdown, buildExtensionPrompt } from './buildExtensionModel'

// "Build your own extension" (the Extensions home): pick a starting point, name
// it, choose where it goes and which agent builds it, and the flow scaffolds
// the project from the SDK's own templates and opens it in a chat.
//
// The chat is the point. The project arrives with the SDK as a dependency and
// the extension-builder skill in its `.claude/skills` and `.agents/skills`, and
// the chat opens with that skill attached and a first message that sends the
// agent to IDEA.md, the dev loop, and three questions before any code. So the
// person describes what they want and the agent builds it — the templates are
// where it starts, not what it becomes.
//
// Two steps, because they are two different questions: WHAT (a template, and
// the idea in their own words) and WHERE and WHO (name, folder, agent), with
// the machine's readiness said beside the second — Node.js, npm, git and the
// chosen agent — before the press, not after it. A check that fails for a
// required tool holds Create and says what to do; a probe that could not answer
// never does.
//
// The agent is chosen in the same picker a card's Go opens (`LaunchModelPicker`),
// on the chat roster: only CLIs that run as a chat are offered, because the
// build happens in a conversation. It opens on the person's remembered CLI when
// that one can chat.

type Step = 'idea' | 'setup'

function describePermissions(permissions: readonly string[]): string {
  return permissions.length ? `Asks for ${permissions.join(', ')}` : 'Asks for no permissions'
}

const CHECK_WORD: Record<ExtensionScaffoldCheck['status'], { word: string; tone: Tone }> = {
  ok: { word: 'Ready', tone: 'good' },
  missing: { word: 'Missing', tone: 'error' },
  outdated: { word: 'Too old', tone: 'error' },
  unknown: { word: 'Unknown', tone: 'neutral' },
}

/** The person's remembered CLI, as a chat launch — or null when it cannot chat. */
function useDefaultChatChoice(): CardLaunchChoice | null {
  const cli = useWorkspaceStore((state) => normalizeSelectedCli(state.appSettings.lastSelectedCli))
  const fallback = useWorkspaceStore(
    (state) => state.appSettings.lastAgentSpawnPermissionPreset ?? DEFAULT_AGENT_SPAWN_PERMISSION_PRESET,
  )
  return useMemo(
    () =>
      conversationProviderForCli(cli)
        ? { cli, model: null, reasoning: null, permissionPreset: resolveCliPermissionPreset(cli, fallback) }
        : null,
    [cli, fallback],
  )
}

/** The plate on the Extensions home that opens the flow. Always there, whatever the card feed says. */
export function BuildExtensionPlate({ onOpen }: { onOpen: () => void }): JSX.Element {
  return (
    <CardButton variant="bordered" onClick={onOpen} className="px-4 py-3">
      <span className="text-body font-semibold text-[color:var(--text-strong)]">Build your own extension</span>
      <span className="mt-0.5 text-meta text-[color:var(--text-muted)]">
        Start from a template and build it with an agent in a chat — it has the SDK and the skill that teaches it.
      </span>
    </CardButton>
  )
}

export function BuildExtensionFlow({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const titleId = useId()
  const fieldId = useId()
  const defaultChoice = useDefaultChatChoice()
  const catalog = useAgentCliCatalogOptions()

  const [step, setStep] = useState<Step>('idea')
  const [templates, setTemplates] = useState<ExtensionTemplateSummary[] | null>(null)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [templateId, setTemplateId] = useState<string | null>(null)
  const [idea, setIdea] = useState('')
  const [name, setName] = useState('')
  const [id, setId] = useState('')
  const [idEdited, setIdEdited] = useState(false)
  const [folder, setFolder] = useState<ExtensionScaffoldFolderPick | null>(null)
  const [choice, setChoice] = useState<CardLaunchChoice | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [checks, setChecks] = useState<ExtensionScaffoldCheck[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A fresh flow every time it opens: a half-filled form from last time is a
  // decision the person did not make today.
  useEffect(() => {
    if (!open) return
    setStep('idea')
    setTemplateId(null)
    setIdea('')
    setName('')
    setId('')
    setIdEdited(false)
    setFolder(null)
    setChoice(null)
    setChecks(null)
    setCreating(false)
    setError(null)
    let live = true
    setTemplates(null)
    setTemplatesError(null)
    window.api
      .extensionScaffoldTemplates()
      .then((list) => {
        if (live) setTemplates(list)
      })
      .catch((reason: unknown) => {
        if (live) setTemplatesError(reason instanceof Error ? reason.message : 'The templates could not be read.')
      })
    return () => {
      live = false
    }
  }, [open])

  const agent = choice ?? defaultChoice
  const template = templates?.find((entry) => entry.id === templateId) ?? null

  // The machine check, again whenever the agent changes. A later answer
  // replaces an earlier one only if it is the latest question asked.
  const checkSeq = useRef(0)
  const runChecks = useCallback(() => {
    const seq = ++checkSeq.current
    setChecks(null)
    window.api
      .extensionScaffoldCheck(agent ? { cli: agent.cli } : {})
      .then((answer) => {
        if (checkSeq.current === seq) setChecks(answer)
      })
      .catch(() => {
        if (checkSeq.current === seq) setChecks([])
      })
  }, [agent])
  useEffect(() => {
    if (open && step === 'setup') runChecks()
  }, [open, step, runChecks])

  const onName = (next: string) => {
    setName(next)
    if (!idEdited) setId(extensionIdFromName(next))
  }

  const chooseFolder = async () => {
    setError(null)
    try {
      const picked = await window.api.extensionScaffoldPickFolder()
      if (picked) setFolder(picked)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The folder could not be chosen.')
    }
  }

  const names = agent ? engineNames(catalog, agent.cli, agent.model ?? undefined) : null
  const agentLabel = names ? (names.modelLabel ? `${names.cliLabel} · ${names.modelLabel}` : names.cliLabel) : null
  const blocker = buildExtensionBlocker({
    name,
    id,
    folderChosen: folder !== null,
    agentChosen: agent !== null,
    checks,
  })

  const create = async () => {
    if (!template || !folder || !agent || blocker || creating) return
    const providerId = conversationProviderForCli(agent.cli)
    const host = getBuildExtensionHost()
    if (!providerId || !host) {
      setError('This window cannot open a chat right now.')
      return
    }
    setCreating(true)
    setError(null)
    try {
      const result = await window.api.extensionScaffoldCreate({
        templateId: template.id,
        id,
        displayName: name.trim(),
        parentDir: folder.path,
        parentDirToken: folder.token,
        ideaMarkdown: buildExtensionIdeaMarkdown({ name, idea, template }),
      })
      if (!result.ok) {
        // A pick main no longer honours has to be made again; anything else
        // keeps the form as it is, so trying again is one press.
        if (result.code === 'folder_not_picked') setFolder(null)
        setError(result.message)
        return
      }
      host.openChat({
        folder: result.folder,
        confirm: {
          provider: {
            providerId,
            modelId: agent.model ?? CONVERSATION_DEFAULT_MODEL_ID,
            modelLabel: names?.modelLabel ?? names?.cliLabel ?? agent.cli,
          },
          cli: agent.cli,
          reasoning: agent.reasoning,
          skills: [{ id: EXTENSION_BUILDER_SKILL_ID }],
        },
        prompt: buildExtensionPrompt({ name, idea, template }),
      })
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The project could not be created.')
    } finally {
      setCreating(false)
    }
  }

  if (!open) return null

  return (
    <Modal open={open} onClose={creating ? () => {} : onClose} labelledBy={titleId} size="wide">
      <ModalHeader
        title="Build your own extension"
        titleId={titleId}
        subtitle={
          step === 'idea'
            ? 'Pick where it starts and say what it should do. An agent builds it with you in a chat.'
            : 'Name it, choose where the project goes, and the agent that builds it with you.'
        }
        onClose={creating ? undefined : onClose}
      />
      {step === 'idea' ? (
        <ModalBody className="flex flex-col gap-4">
          {templatesError ? (
            <InlineNotice tone="error" title="The templates could not be read" hint={templatesError} />
          ) : null}
          <div role="group" aria-label="Starting points" className="@container">
            <ul className="m-0 grid list-none grid-cols-1 gap-2 p-0 @[520px]:grid-cols-2">
              {templates === null && !templatesError
                ? [0, 1, 2, 3].map((slot) => (
                    <li key={slot}>
                      <Skeleton className="h-[72px] w-full rounded-md bg-[color:var(--bg-surface-raised)]" />
                    </li>
                  ))
                : (templates ?? []).map((entry) => (
                    <li key={entry.id} className="flex flex-col">
                      <CardButton
                        variant="bordered"
                        selected={entry.id === templateId}
                        onClick={() => setTemplateId(entry.id)}
                        className="h-full px-3 py-2.5"
                      >
                        <span className="text-body font-semibold text-[color:var(--text-strong)]">{entry.title}</span>
                        <span className="mt-0.5 text-meta text-[color:var(--text-muted)]">{entry.summary}</span>
                        <span className="mt-auto pt-1.5 text-micro text-[color:var(--text-subtle)]">
                          {describePermissions(entry.permissions)}
                        </span>
                      </CardButton>
                    </li>
                  ))}
            </ul>
          </div>
          <Field
            label="Your idea"
            htmlFor={`${fieldId}-idea`}
            help="Optional. It becomes the brief (IDEA.md) the agent reads first, and it will ask about the rest."
          >
            <Textarea
              rows={3}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              placeholder={template ? template.summary : 'What should the extension do, and for whom?'}
            />
          </Field>
        </ModalBody>
      ) : (
        <ModalBody className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor={`${fieldId}-name`} required>
              <Input value={name} onChange={(event) => onName(event.target.value)} maxLength={80} autoFocus />
            </Field>
            <Field label="Id" htmlFor={`${fieldId}-id`} help="The module's id, and the project folder's name.">
              <Input
                value={id}
                onChange={(event) => {
                  setIdEdited(true)
                  setId(event.target.value.trim().toLowerCase())
                }}
                maxLength={63}
                spellCheck={false}
              />
            </Field>
          </div>
          <Field label="Where the project goes">
            <div className="flex min-w-0 items-center gap-3" role="group" aria-label="Where the project goes">
              <span className="min-w-0 flex-1 truncate text-meta text-[color:var(--text-muted)]">
                {folder ? `${folder.path}/${id || '…'}` : 'No folder chosen yet.'}
              </span>
              <OutlineButton size="sm" onClick={() => void chooseFolder()} disabled={creating}>
                {folder ? 'Change…' : 'Choose folder…'}
              </OutlineButton>
            </div>
          </Field>
          <Field label="Agent">
            <Popover
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              ariaLabel="Choose the agent that builds the extension"
              popupRole="dialog"
              placement="bottom-start"
              surfaceClassName="overflow-hidden"
              renderTrigger={({ ref, triggerProps, togglePopover }) => (
                <TriggerButton
                  ref={ref}
                  open={pickerOpen}
                  disabled={creating}
                  onClick={togglePopover}
                  {...triggerProps}
                >
                  <span className="min-w-0 truncate">{agentLabel ?? 'Choose an agent that runs as a chat'}</span>
                </TriggerButton>
              )}
            >
              <LaunchModelPicker
                ariaLabel="Agents that run as a chat"
                selection={{ kind: 'conversation' }}
                onChoose={(next) => {
                  setPickerOpen(false)
                  setChoice(next)
                }}
                onNavigate={() => setPickerOpen(false)}
              />
            </Popover>
          </Field>
          <section aria-labelledby={`${fieldId}-checks`} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={`${fieldId}-checks`} className="m-0 text-body font-medium text-[color:var(--text-default)]">
                This machine
              </h3>
              <LinkButton ink="quiet" onClick={runChecks} disabled={checks === null || creating}>
                Check again
              </LinkButton>
            </div>
            {checks === null ? (
              <p className="m-0 text-meta text-[color:var(--text-muted)]" aria-live="polite">
                Checking for Node.js, npm, git and the agent…
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0" aria-live="polite">
                {checks.map((check) => (
                  <li key={check.id} className="flex items-baseline gap-2 text-meta">
                    <span className="w-24 shrink-0 font-medium text-[color:var(--text-strong)]">{check.label}</span>
                    <Badge tone={CHECK_WORD[check.status].tone} className="shrink-0">
                      {check.required || check.status === 'ok' ? CHECK_WORD[check.status].word : 'Optional'}
                    </Badge>
                    <span className="min-w-0 text-[color:var(--text-muted)]">{check.detail}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {error ? <InlineNotice tone="error" title="The project was not created" hint={error} /> : null}
          {blocker && checks !== null ? (
            <p className="m-0 text-meta text-[color:var(--text-muted)]" aria-live="polite">
              {blocker}
            </p>
          ) : null}
        </ModalBody>
      )}
      <ModalFooter>
        {step === 'idea' ? (
          <>
            <ModalButton type="button" onClick={onClose}>
              Cancel
            </ModalButton>
            <ModalButton type="button" variant="primary" disabled={!template} onClick={() => setStep('setup')}>
              Next
            </ModalButton>
          </>
        ) : (
          <>
            <ModalButton type="button" onClick={() => setStep('idea')} disabled={creating}>
              Back
            </ModalButton>
            <ModalButton
              type="button"
              variant="primary"
              disabled={blocker !== null || creating}
              onClick={() => void create()}
            >
              {creating ? 'Creating…' : 'Create and open chat'}
            </ModalButton>
          </>
        )}
      </ModalFooter>
    </Modal>
  )
}

export default BuildExtensionFlow

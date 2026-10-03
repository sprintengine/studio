import { useCallback, useEffect, useState } from 'react'

import type { SshPreviewStatus } from '../../../../shared/ssh-preview'
import type { StudioServerInfo, StudioServerStatus } from '../../../../shared/studio-server-status'
import { useStudioServerStatus } from '../studioServer/useStudioServerStatus'
import { uptimeWords } from '../studioServer/studioServerWords'
import { GhostButton, InlineNotice, Switch } from '../ui'
import { SettingCard, SettingsRow, SettingsSectionTitle } from './SettingsAtoms'

// Settings → Agents → Studio server: the Advanced toggle that runs the server
// in a process of its own (phase 6, off by default), and, while it does, what
// it is doing in words, with the actions a person takes on it.

const SSH_TOGGLE_ID = 'settings-ssh-machines-preview'
const SSH_TOGGLE_HELP_ID = 'settings-ssh-machines-preview-help'

/**
 * SSH machines (phase 8), a preview until it is complete: off by default.
 * Read once at launch, like the process switch above it.
 */
export function SshMachinesPreviewSwitch() {
  const [status, setStatus] = useState<SshPreviewStatus | null>(null)
  const [pending, setPending] = useState(false)
  useEffect(() => {
    if (typeof window.api?.sshPreviewStatus !== 'function') return
    let cancelled = false
    void window.api
      .sshPreviewStatus()
      .then((next) => {
        if (!cancelled) setStatus(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  if (!status) return null
  const restartNeeded = status.saved !== status.enabled && !status.fromEnvironment
  return (
    <>
      <SettingsRow
        label="SSH machines (preview)"
        helpId={SSH_TOGGLE_HELP_ID}
        help={
          status.fromEnvironment
            ? 'Set for this launch by SPRINTENGINE_SSH_MACHINES.'
            : 'Run chats on machines you reach over SSH, from Settings › Machines. Still being built: some views do not work for them yet. Takes effect after a restart.'
        }
      >
        <Switch
          id={SSH_TOGGLE_ID}
          checked={status.saved}
          onChange={(next) => {
            if (pending) return
            setPending(true)
            void window.api
              .sshPreviewSet(next)
              .then(setStatus)
              .finally(() => setPending(false))
          }}
          disabled={pending || status.fromEnvironment}
          ariaLabel="SSH machines (preview)"
          ariaDescribedBy={SSH_TOGGLE_HELP_ID}
        />
      </SettingsRow>
      {restartNeeded ? (
        <InlineNotice
          tone="warn"
          action={<GhostButton onClick={() => void window.api.studioServerRelaunch()}>Restart now</GhostButton>}
        >
          {status.saved ? 'SSH machines appear after a restart.' : 'SSH machines go away after a restart.'}
        </InlineNotice>
      ) : null}
    </>
  )
}

const TOGGLE_ID = 'settings-studio-server-process'
const TOGGLE_HELP_ID = 'settings-studio-server-process-help'

const PHASE_WORDS: Record<StudioServerStatus['phase'], string> = {
  'in-process': 'Inside the app',
  starting: 'Starting',
  running: 'Running',
  reconnecting: 'Reconnecting',
  stopped: 'Stopped',
  stopping: 'Stopping',
}

export function StudioServerSettings() {
  const [status, setStatus] = useStudioServerStatus()
  const [info, setInfo] = useState<StudioServerInfo | null>(null)
  const [pending, setPending] = useState(false)

  const running = status?.phase === 'running'
  useEffect(() => {
    if (!running) {
      setInfo(null)
      return
    }
    let cancelled = false
    void window.api
      .studioServerInfo()
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [running, status?.pid])

  const setOwnProcess = useCallback(
    async (next: boolean) => {
      if (pending) return
      setPending(true)
      try {
        setStatus(await window.api.studioServerSetMode(next ? 'out-of-process' : 'in-process'))
      } finally {
        setPending(false)
      }
    },
    [pending, setStatus],
  )

  if (!status) return null
  const restartNeeded = status.savedMode !== status.mode && !status.fromEnvironment
  const outOfProcess = status.mode === 'out-of-process'
  return (
    <section className="space-y-3 pt-2">
      <SettingsSectionTitle>Studio server</SettingsSectionTitle>
      <SettingCard>
        <SettingsRow
          label="Run Studio server in its own process"
          helpId={TOGGLE_HELP_ID}
          help={
            status.fromEnvironment
              ? 'Set for this launch by SPRINTENGINE_SERVER_MODE.'
              : 'Chats, the gateway and paired machines run apart from the windows. Takes effect after a restart.'
          }
        >
          <Switch
            id={TOGGLE_ID}
            checked={status.savedMode === 'out-of-process'}
            onChange={(next) => void setOwnProcess(next)}
            disabled={pending || status.fromEnvironment}
            ariaLabel="Run Studio server in its own process"
            ariaDescribedBy={TOGGLE_HELP_ID}
          />
        </SettingsRow>
        {outOfProcess ? (
          <SettingsRow
            label={PHASE_WORDS[status.phase]}
            help={
              info
                ? `Process ${info.pid}, up ${uptimeWords(info.uptimeMs)}, ${info.rssMb} MB` +
                  (status.restarts > 0 ? `, restarted ${status.restarts} time${status.restarts === 1 ? '' : 's'}` : '')
                : status.reason
            }
          >
            <span className="flex items-center gap-2">
              <GhostButton onClick={() => void window.api.studioServerOpenLog()}>Open log</GhostButton>
              <GhostButton onClick={() => void window.api.studioServerRestart()} disabled={!running}>
                Restart server
              </GhostButton>
            </span>
          </SettingsRow>
        ) : null}
        <SshMachinesPreviewSwitch />
      </SettingCard>
      {restartNeeded ? (
        <InlineNotice
          tone="warn"
          action={<GhostButton onClick={() => void window.api.studioServerRelaunch()}>Restart now</GhostButton>}
        >
          {status.savedMode === 'out-of-process'
            ? 'Studio server moves to its own process after a restart.'
            : 'Studio server moves back inside the app after a restart.'}
        </InlineNotice>
      ) : null}
      {status.fellBack ? (
        <InlineNotice tone="warn">
          Studio server could not start in its own process, so it runs inside the app this time. {status.fellBack}
        </InlineNotice>
      ) : null}
    </section>
  )
}

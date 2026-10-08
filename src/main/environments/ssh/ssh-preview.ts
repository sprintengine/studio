import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { writeFileAtomicSync } from '../../../server/platform/atomic-file'

import {
  parseSshPreview,
  SSH_PREVIEW_ARGUMENT,
  SSH_PREVIEW_ENV,
  SSH_PREVIEW_FILENAME,
} from '../../../shared/ssh-preview'

// The SSH machines preview switch (shared/ssh-preview.ts), read at boot and
// fixed for the session.

export type SshPreviewChoice = { enabled: boolean; fromEnvironment: boolean }

export function readSshPreview(userDataDir: string, env: NodeJS.ProcessEnv = process.env): SshPreviewChoice {
  const fromEnv = parseSshPreview(env[SSH_PREVIEW_ENV])
  if (fromEnv !== null) return { enabled: fromEnv, fromEnvironment: true }
  return { enabled: readSavedSshPreview(userDataDir), fromEnvironment: false }
}

export function readSavedSshPreview(userDataDir: string): boolean {
  try {
    const stored = JSON.parse(readFileSync(join(userDataDir, SSH_PREVIEW_FILENAME), 'utf8')) as { enabled?: unknown }
    return parseSshPreview(stored.enabled) ?? false
  } catch {
    return false
  }
}

/** What the next launch has. Written whole and renamed into place. */
export function writeSshPreview(userDataDir: string, enabled: boolean): void {
  writeFileAtomicSync(join(userDataDir, SSH_PREVIEW_FILENAME), `${JSON.stringify({ enabled }, null, 2)}\n`, {
    mode: 0o600,
  })
}

let session = false

export function setSessionSshPreview(enabled: boolean): void {
  session = enabled
}

export function sessionSshPreview(): boolean {
  return session
}

/** The switch every app window's renderer is started with. */
export function sshPreviewWindowArguments(): string[] {
  return [`${SSH_PREVIEW_ARGUMENT}${session ? 'on' : 'off'}`]
}

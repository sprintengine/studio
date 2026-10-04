import path from 'node:path'

import type { IpcMain } from 'electron'

import type { PullRequestTextRequest, PullRequestTextResult } from '../../shared/text-generation/contract'
import { writeDiagnosticLog } from '../diagnostics-service'
import { createPullRequestCreator, type PullRequestCreator } from '../pull-request-create'
import { generatePullRequestText } from '../text-generation/text-generation-service'

// The chat's "Create PR" button (owner ruling 2026-10-04), in the shell: the
// checkout is on this computer, and so are git, `gh` and the agent CLI that
// drafts the text. Four channels, one per step, so the window can say which
// step it is on: whether the button may show, the draft, the push, the
// creation. None of them throws: a failure is `{ ok: false, message }`, which
// the strip shows as it is.

export type PullRequestCreateIpcDeps = {
  creator?: PullRequestCreator
  generate?: (request: PullRequestTextRequest) => Promise<PullRequestTextResult>
}

export function registerPullRequestCreateIpc(ipcMain: IpcMain, deps: PullRequestCreateIpcDeps = {}): void {
  const creator = deps.creator ?? createPullRequestCreator()
  const generate = deps.generate ?? generatePullRequestText

  ipcMain.handle('pull-request-create:state', async (_, cwd: unknown) => {
    const folder = folderOf(cwd)
    if (!folder) return null
    return creator.state(folder).catch(() => null)
  })

  ipcMain.handle('pull-request-create:draft', async (_, input: unknown): Promise<PullRequestTextResult> => {
    const request = readDraftRequest(input)
    if (!request) return { ok: false, code: 'unsupported', message: 'Malformed pull request draft request.' }
    const gathered = await creator.draftInput(request.cwd)
    if (!gathered.ok) return { ok: false, code: 'unsupported', message: gathered.message }
    const result = await generate({
      input: gathered.input,
      engine: request.engine,
      ...(request.cliRuntimes ? { cliRuntimes: request.cliRuntimes } : {}),
    })
    if (!result.ok) {
      await writeDiagnosticLog({
        level: 'info',
        source: 'agents',
        title: 'Pull request text not drafted',
        message: `${request.engine.cli}: ${result.code} — ${result.message}`,
      }).catch(() => undefined)
    }
    return result
  })

  ipcMain.handle('pull-request-create:push', async (_, cwd: unknown) => {
    const folder = folderOf(cwd)
    if (!folder) return { ok: false, message: 'No checkout to push.' }
    return creator.push(folder).catch((error: unknown) => ({ ok: false, message: describe(error) }))
  })

  ipcMain.handle('pull-request-create:create', async (_, input: unknown) => {
    const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
    const folder = folderOf(record.cwd)
    if (!folder || typeof record.title !== 'string' || typeof record.body !== 'string') {
      return { ok: false, message: 'Malformed pull request.' }
    }
    return creator
      .create(folder, { title: record.title.slice(0, 300), body: record.body.slice(0, 65_000) })
      .catch((error: unknown) => ({ ok: false, message: describe(error) }))
  })
}

/** An absolute folder, or nothing: a relative one would resolve against main's own. */
function folderOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) return null
  return path.isAbsolute(value) ? value : null
}

function readDraftRequest(input: unknown): (Omit<PullRequestTextRequest, 'input'> & { cwd: string }) | null {
  if (!input || typeof input !== 'object') return null
  const { cwd, engine, cliRuntimes } = input as Record<string, unknown>
  const folder = folderOf(cwd)
  if (!folder || !engine || typeof engine !== 'object') return null
  const { cli, model, reasoning } = engine as Record<string, unknown>
  if (typeof cli !== 'string' || typeof model !== 'string') return null
  return {
    cwd: folder,
    engine: { cli, model, ...(typeof reasoning === 'string' && reasoning ? { reasoning } : {}) },
    ...(cliRuntimes && typeof cliRuntimes === 'object'
      ? { cliRuntimes: cliRuntimes as PullRequestTextRequest['cliRuntimes'] }
      : {}),
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

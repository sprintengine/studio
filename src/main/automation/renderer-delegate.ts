import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import {
  AUTOMATION_REQUEST_CHANNEL,
  type AutomationRendererRequest,
  type AutomationRendererResponse,
} from '../../shared/automation'

// Routes automation mutations to the primary window's renderer, which executes
// the same store actions the UI uses (workspace construction and agent
// spawning are renderer-owned domain logic — building them in main would be a
// second source of truth). Each request gets a correlation id; the renderer
// answers over the automation:respond IPC channel, wired to handleResponse by
// registerAutomationIpc. Missing window and timeout are explicit failures.

const RESPONSE_TIMEOUT_MS = 15_000
// Sprint creation spawns the one-shot Python state init inside the renderer
// round-trip; a cold managed-runtime start can blow the default budget.
const SPRINT_CREATE_TIMEOUT_MS = 60_000

export type RendererAutomationDelegate = {
  request(request: AutomationRendererRequest): Promise<AutomationRendererResponse>
  handleResponse(requestId: unknown, response: unknown): void
}

type FindPrimaryWindow = () => Pick<BrowserWindow, 'webContents'> | null

export function createRendererAutomationDelegate(
  findPrimaryWindow: FindPrimaryWindow = defaultFindPrimaryWindow,
  responseTimeoutMs = RESPONSE_TIMEOUT_MS
): RendererAutomationDelegate {
  const pending = new Map<string, { resolve: (response: AutomationRendererResponse) => void; timer: NodeJS.Timeout }>()

  function request(payload: AutomationRendererRequest): Promise<AutomationRendererResponse> {
    const window = findPrimaryWindow()
    if (!window) {
      return Promise.resolve({
        ok: false,
        code: 'no_primary_window',
        message: 'No primary Multicode window is available to perform this operation.',
      })
    }
    const timeoutMs = payload.kind === 'sprint.create' ? Math.max(responseTimeoutMs, SPRINT_CREATE_TIMEOUT_MS) : responseTimeoutMs
    const requestId = randomUUID()
    return new Promise<AutomationRendererResponse>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({
          ok: false,
          code: 'renderer_timeout',
          message: `The renderer did not answer the automation request within ${timeoutMs}ms.`,
        })
      }, timeoutMs)
      pending.set(requestId, { resolve, timer })
      window.webContents.send(AUTOMATION_REQUEST_CHANNEL, requestId, payload)
    })
  }

  function handleResponse(requestId: unknown, response: unknown): void {
    if (typeof requestId !== 'string') return
    const entry = pending.get(requestId)
    if (!entry) return
    pending.delete(requestId)
    clearTimeout(entry.timer)
    entry.resolve(normalizeResponse(response))
  }

  return { request, handleResponse }
}

function normalizeResponse(value: unknown): AutomationRendererResponse {
  if (typeof value === 'object' && value !== null) {
    const candidate = value as Partial<AutomationRendererResponse> & { ok?: unknown }
    if (candidate.ok === true && typeof (candidate as { workspaceId?: unknown }).workspaceId === 'string') {
      const agentId = (candidate as { agentId?: unknown }).agentId
      return {
        ok: true,
        workspaceId: (candidate as { workspaceId: string }).workspaceId,
        ...(typeof agentId === 'string' ? { agentId } : {}),
      }
    }
    if (candidate.ok === false) {
      const code = (candidate as { code?: unknown }).code
      const message = (candidate as { message?: unknown }).message
      return {
        ok: false,
        code: typeof code === 'string' ? code : 'renderer_error',
        message: typeof message === 'string' ? message : 'The renderer reported an unspecified failure.',
      }
    }
  }
  return {
    ok: false,
    code: 'renderer_protocol_error',
    message: 'The renderer returned a malformed automation response.',
  }
}

// The primary window carries no windowId query param (or windowId=primary);
// detached workspace windows always carry their own id. Mirrors the source
// window resolution in src/main/ipc/workspace-sync-ipc.ts.
function defaultFindPrimaryWindow(): Pick<BrowserWindow, 'webContents'> | null {
  return (
    BrowserWindow.getAllWindows().find((window) => {
      if (window.isDestroyed() || window.webContents.isDestroyed()) return false
      return windowIdFromUrl(window.webContents.getURL()) === 'primary'
    }) ?? null
  )
}

function windowIdFromUrl(rawUrl: string): string {
  try {
    return new URL(rawUrl).searchParams.get('windowId')?.trim() || 'primary'
  } catch {
    return 'primary'
  }
}

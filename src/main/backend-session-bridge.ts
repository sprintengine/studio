import * as http from 'http'
import type { IncomingMessage } from 'http'
import { ipcMain, type IpcMain, type WebContents } from 'electron'

import { readSwitchboardServerDescriptor, type SwitchboardServerDescriptor } from './switchboard-python'
import type { BackendSessionSignal } from '../shared/electron-api'

type AttachInstance = {
  instanceKey: string
  executionId: string
  workspaceRoot: string
  sender: WebContents
  request: http.ClientRequest
  closed: boolean
}

const INSTANCES = new Map<string, AttachInstance>()
const KNOWN_WORKSPACE_ROOTS = new Set<string>()

export function rememberBackendWorkspace(workspaceRoot: string): void {
  if (workspaceRoot) KNOWN_WORKSPACE_ROOTS.add(workspaceRoot)
}

export function knownBackendWorkspaces(): string[] {
  return Array.from(KNOWN_WORKSPACE_ROOTS)
}

function rememberWorkspace(workspaceRoot: string): void {
  rememberBackendWorkspace(workspaceRoot)
}

export type BackendSessionAttachResult =
  | { ok: true; instanceKey: string }
  | { ok: false; message: string }

export type BackendSessionListEntry = {
  executionId: string
  role: string
  kind: string
  cols: number
  rows: number
  startedAt: string
  exitedAt: string | null
  exitCode: number | null
  status: 'active' | 'exited'
  pid: number
}

export type BackendSessionListResult =
  | { ok: true; sessions: BackendSessionListEntry[] }
  | { ok: false; message: string }

const REQUEST_TIMEOUT_MS = 5_000

async function requestJson(
  descriptor: SwitchboardServerDescriptor,
  pathName: string,
  body?: Record<string, unknown>,
): Promise<{ ok: true; payload: Record<string, unknown> } | { ok: false; message: string }> {
  const options: http.RequestOptions = {
    host: descriptor.host,
    port: descriptor.port,
    path: pathName,
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    timeout: REQUEST_TIMEOUT_MS,
  }
  return new Promise((resolvePromise) => {
    let settled = false
    const settle = (result: { ok: true; payload: Record<string, unknown> } | { ok: false; message: string }): void => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }
    const req = http.request(options, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        raw += chunk
      })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && parsed.ok !== false) {
            settle({ ok: true, payload: parsed })
          } else {
            const message = typeof parsed.message === 'string' ? parsed.message : `HTTP ${res.statusCode}`
            settle({ ok: false, message })
          }
        } catch (error) {
          settle({ ok: false, message: error instanceof Error ? error.message : 'Invalid response.' })
        }
      })
    })
    req.on('error', (error) => settle({ ok: false, message: error.message }))
    req.on('timeout', () => {
      req.destroy()
      settle({ ok: false, message: `Request timed out after ${REQUEST_TIMEOUT_MS}ms.` })
    })
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

function descriptorFor(workspaceRoot: string): SwitchboardServerDescriptor | null {
  return readSwitchboardServerDescriptor(workspaceRoot)
}

export async function listBackendSessions(workspaceRoot: string): Promise<BackendSessionListResult> {
  rememberWorkspace(workspaceRoot)
  const descriptor = descriptorFor(workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }
  const result = await requestJson(descriptor, '/sessions')
  if (!result.ok) return { ok: false, message: result.message }
  const sessions = Array.isArray(result.payload.sessions) ? (result.payload.sessions as BackendSessionListEntry[]) : []
  return { ok: true, sessions }
}

export async function writeBackendSession(
  workspaceRoot: string,
  executionId: string,
  base64Data: string,
): Promise<{ ok: boolean; message?: string }> {
  const descriptor = descriptorFor(workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }
  const res = await requestJson(descriptor, `/execution/${executionId}/write`, { data: base64Data })
  return res.ok ? { ok: true } : { ok: false, message: res.message }
}

export async function resizeBackendSession(
  workspaceRoot: string,
  executionId: string,
  cols: number,
  rows: number,
): Promise<{ ok: boolean; message?: string }> {
  const descriptor = descriptorFor(workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }
  const res = await requestJson(descriptor, `/execution/${executionId}/resize`, { cols, rows })
  return res.ok ? { ok: true } : { ok: false, message: res.message }
}

export async function signalBackendSession(
  workspaceRoot: string,
  executionId: string,
  signal: BackendSessionSignal,
): Promise<{ ok: boolean; message?: string }> {
  const descriptor = descriptorFor(workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }
  const res = await requestJson(descriptor, `/execution/${executionId}/signal`, { signal })
  return res.ok ? { ok: true } : { ok: false, message: res.message }
}

export async function stopAllBackendSessions(
  workspaceRoot: string,
  graceSeconds = 3,
): Promise<{ ok: boolean; message?: string }> {
  rememberWorkspace(workspaceRoot)
  const descriptor = descriptorFor(workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }
  const res = await requestJson(descriptor, '/runner/stop', { graceSeconds })
  return res.ok ? { ok: true } : { ok: false, message: res.message }
}

export async function stopAllKnownBackendRunners(graceSeconds = 3): Promise<void> {
  const roots = Array.from(KNOWN_WORKSPACE_ROOTS)
  await Promise.all(
    roots.map(async (root) => {
      try {
        await stopAllBackendSessions(root, graceSeconds)
      } catch {
        /* best effort */
      }
    }),
  )
}

export function attachBackendSession(
  sender: WebContents,
  args: { workspaceRoot: string; executionId: string; instanceKey: string },
): BackendSessionAttachResult {
  rememberWorkspace(args.workspaceRoot)
  const descriptor = descriptorFor(args.workspaceRoot)
  if (!descriptor) return { ok: false, message: 'Switchboard backend is not running.' }

  if (INSTANCES.has(args.instanceKey)) {
    detachInstance(args.instanceKey)
  }

  const options: http.RequestOptions = {
    host: descriptor.host,
    port: descriptor.port,
    path: `/execution/${args.executionId}/stream`,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${descriptor.token}`,
      Accept: 'text/event-stream',
    },
  }

  const instance: AttachInstance = {
    instanceKey: args.instanceKey,
    executionId: args.executionId,
    workspaceRoot: args.workspaceRoot,
    sender,
    request: http.request(options),
    closed: false,
  }

  let buffer = ''

  const onEnd = (): void => {
    if (instance.closed) return
    instance.closed = true
    INSTANCES.delete(instance.instanceKey)
    if (!sender.isDestroyed()) {
      sender.send(`backend-session:exit:${instance.instanceKey}`, { reason: 'stream-ended' })
    }
  }

  const onError = (message: string): void => {
    if (instance.closed) return
    instance.closed = true
    INSTANCES.delete(instance.instanceKey)
    if (!sender.isDestroyed()) {
      sender.send(`backend-session:error:${instance.instanceKey}`, { message })
    }
  }

  instance.request.on('error', (error) => onError(error.message))

  instance.request.on('response', (response: IncomingMessage) => {
    if (response.statusCode !== 200) {
      let raw = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        raw += chunk
      })
      response.on('end', () => onError(`HTTP ${response.statusCode}: ${raw.slice(0, 200)}`))
      return
    }
    response.setEncoding('utf8')
    response.on('data', (chunk: string) => {
      buffer += chunk
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        dispatchEvent(instance, rawEvent)
        boundary = buffer.indexOf('\n\n')
      }
    })
    response.on('end', onEnd)
    response.on('close', onEnd)
  })

  sender.once('destroyed', () => detachInstance(args.instanceKey))

  instance.request.end()
  INSTANCES.set(args.instanceKey, instance)
  return { ok: true, instanceKey: args.instanceKey }
}

function dispatchEvent(instance: AttachInstance, rawEvent: string): void {
  if (!rawEvent || rawEvent.startsWith(':')) return
  let eventName = 'message'
  let data = ''
  for (const line of rawEvent.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      data += data ? '\n' : ''
      data += line.slice(5).trim()
    }
  }
  if (instance.sender.isDestroyed()) return
  if (eventName === 'replay') {
    instance.sender.send(`backend-session:replay:${instance.instanceKey}`, { data })
  } else if (eventName === 'data') {
    instance.sender.send(`backend-session:data:${instance.instanceKey}`, { data })
  } else if (eventName === 'exit') {
    try {
      const parsed = JSON.parse(data) as { exitCode: number | null; exitedAt: string | null }
      instance.sender.send(`backend-session:exit:${instance.instanceKey}`, parsed)
    } catch {
      instance.sender.send(`backend-session:exit:${instance.instanceKey}`, { exitCode: null, exitedAt: null })
    }
  }
}

export function detachInstance(instanceKey: string): void {
  const instance = INSTANCES.get(instanceKey)
  if (!instance) return
  instance.closed = true
  INSTANCES.delete(instanceKey)
  try {
    instance.request.destroy()
  } catch {
    /* ignore */
  }
}

export function detachAllForSender(sender: WebContents): void {
  for (const [key, instance] of INSTANCES) {
    if (instance.sender === sender) detachInstance(key)
  }
}

export function registerBackendSessionIpc(ipc: IpcMain = ipcMain): void {
  ipc.handle(
    'backend-session:list',
    async (_, workspaceRoot: string): Promise<BackendSessionListResult> => listBackendSessions(workspaceRoot),
  )

  ipc.handle(
    'backend-session:attach',
    (event, args: { workspaceRoot: string; executionId: string; instanceKey: string }): BackendSessionAttachResult => {
      return attachBackendSession(event.sender, args)
    },
  )

  ipc.handle('backend-session:detach', (_, instanceKey: string): void => {
    detachInstance(instanceKey)
  })

  ipc.handle(
    'backend-session:write',
    async (
      _,
      args: { workspaceRoot: string; executionId: string; data: string },
    ): Promise<{ ok: boolean; message?: string }> => writeBackendSession(args.workspaceRoot, args.executionId, args.data),
  )

  ipc.handle(
    'backend-session:resize',
    async (
      _,
      args: { workspaceRoot: string; executionId: string; cols: number; rows: number },
    ): Promise<{ ok: boolean; message?: string }> =>
      resizeBackendSession(args.workspaceRoot, args.executionId, args.cols, args.rows),
  )

  ipc.handle(
    'backend-session:signal',
    async (
      _,
      args: { workspaceRoot: string; executionId: string; signal: BackendSessionSignal },
    ): Promise<{ ok: boolean; message?: string }> => signalBackendSession(args.workspaceRoot, args.executionId, args.signal),
  )

  ipc.handle(
    'backend-session:stop-all',
    async (_, args: { workspaceRoot: string; graceSeconds?: number }): Promise<{ ok: boolean; message?: string }> =>
      stopAllBackendSessions(args.workspaceRoot, args.graceSeconds ?? 3),
  )
}

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { inferConversationToolKind } from '../../shared/conversation/toolKind'
import type { ConversationJsonValue } from '../../shared/conversation-runtime'
import { asRecord } from '../../shared/records'
import { ImportedTranscriptBuilder, recordTime, type ImportedConversation } from './imported-transcript'
import { readJsonLines, readJsonLinesWindow, stringField, type ScannedSession } from './session-files'

// Codex saves each session as `<home>/sessions/YYYY/MM/DD/rollout-*.jsonl`.
// Its first record (`session_meta`) names the session, the folder it ran in
// and what started it; after that, `response_item` records are what the model
// was sent and said (messages, reasoning summaries, tool calls and their
// output) and `event_msg` records are the session's own events. The person's
// messages are both: the model's copy is padded with the context Codex
// injects (the environment, AGENTS.md), so the event is the one read whenever
// the file has it. Session titles live apart, in `session_index.jsonl`.

/** Where Codex keeps its state on this machine. */
export function codexHomeDir(homeDir: string, env: NodeJS.ProcessEnv): string {
  return env.CODEX_HOME?.trim() || join(homeDir, '.codex')
}

// The session meta carries Codex's whole system prompt, so the opening read
// is long enough for it and the first message after it.
const HEAD_BYTES = [256 * 1024, 2 * 1024 * 1024]

/** Every session Codex saved that a person typed into, newest first. */
export async function scanCodexSessions(codexHome: string): Promise<ScannedSession[]> {
  const files = await rolloutFiles(join(codexHome, 'sessions'))
  if (files.length === 0) return []
  const titles = await readSessionTitles(join(codexHome, 'session_index.jsonl'))
  const sessions: ScannedSession[] = []
  for (const path of files) {
    const scanned = await scanRollout(path).catch(() => null)
    if (scanned) sessions.push({ ...scanned, title: titles.get(scanned.sessionId) ?? scanned.title })
  }
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
}

async function rolloutFiles(root: string, depth = 0): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  const files: string[] = []
  for (const name of names) {
    const path = join(root, name)
    if (depth < 3) files.push(...(await rolloutFiles(path, depth + 1)))
    else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) files.push(path)
  }
  return files
}

async function readSessionTitles(path: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  try {
    for await (const record of readJsonLines(path)) {
      const id = stringField(record.id)
      const name = stringField(record.thread_name)
      if (id && name) titles.set(id, name)
    }
  } catch {
    // No index yet: a session without one is titled by its first message.
  }
  return titles
}

async function scanRollout(path: string): Promise<ScannedSession | null> {
  const info = await stat(path)
  if (!info.isFile() || info.size === 0) return null
  for (const bytes of HEAD_BYTES) {
    const records = await readJsonLinesWindow(path, 0, bytes)
    const meta = asRecord(records[0]?.type === 'session_meta' ? records[0].payload : null)
    if (!meta || !isPersonsSession(meta)) return null
    const sessionId = stringField(meta.id) ?? stringField(meta.session_id)
    const folderPath = stringField(meta.cwd)
    if (!sessionId || !folderPath) return null
    const prompts = promptsOf(records)
    const firstPrompt = prompts.events[0] ?? prompts.model[0] ?? null
    if (!firstPrompt && info.size > bytes) continue
    if (!firstPrompt) return null
    return {
      source: 'codex',
      sessionId,
      path,
      folderPath,
      title: null,
      firstPrompt,
      startedAt: recordTime(meta.timestamp) ?? recordTime(records[0]?.timestamp) ?? info.mtimeMs,
      updatedAt: info.mtimeMs,
    }
  }
  return null
}

/**
 * Whether a person ran the session in Codex: not one this app's chat started
 * (it is a chat here already), a subagent Codex spawned (its parent holds
 * its work), or a non-interactive `codex exec`.
 */
function isPersonsSession(meta: Record<string, unknown>): boolean {
  if (meta.originator === 'sprintengine_studio') return false
  if (meta.source === 'exec' || asRecord(meta.source)?.subagent) return false
  return true
}

function promptsOf(records: Array<Record<string, unknown>>): { events: string[]; model: string[] } {
  const events: string[] = []
  const model: string[] = []
  for (const record of records) {
    const fromEvent = eventPrompt(record)
    if (fromEvent) events.push(fromEvent)
    const fromModel = modelPrompt(record)
    if (fromModel) model.push(fromModel)
  }
  return { events, model }
}

/** The person's message as Codex's own event recorded it: `user_message`, or a completed `UserMessage` item. */
function eventPrompt(record: Record<string, unknown>): string | null {
  if (record.type !== 'event_msg') return null
  const payload = asRecord(record.payload)
  if (payload?.type === 'user_message') return stringField(payload.message)
  const item = asRecord(payload?.item)
  if (payload?.type !== 'item_completed' || item?.type !== 'UserMessage') return null
  return joinText(item.content, ['text'])
}

/** The person's message as the model was sent it, without what Codex injects ahead of it. */
function modelPrompt(record: Record<string, unknown>): string | null {
  const payload = asRecord(record.payload)
  if (record.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user') return null
  const text = joinText(payload.content, ['input_text'])
  if (!text || /^<[a-z_ ]+>/i.test(text) || text.startsWith('# AGENTS.md instructions')) return null
  return text
}

function joinText(content: unknown, types: string[]): string | null {
  if (!Array.isArray(content)) return null
  const text = content
    .map((entry) => {
      const block = asRecord(entry)
      return block && types.includes(String(block.type)) && typeof block.text === 'string' ? block.text : ''
    })
    .filter(Boolean)
    .join('\n\n')
    .trim()
  return text || null
}

/** A session's whole history, in the chat's vocabulary. */
export async function readCodexSession(path: string, fallbackAt: number): Promise<ImportedConversation> {
  // Which copy of the person's messages to read is a property of the file:
  // a Codex that records the event records it for every message.
  let hasPromptEvents = false
  for await (const record of readJsonLines(path))
    if (eventPrompt(record)) {
      hasPromptEvents = true
      break
    }
  const builder = new ImportedTranscriptBuilder(fallbackAt)
  for await (const record of readJsonLines(path)) {
    const at = recordTime(record.timestamp)
    const payload = asRecord(record.payload)
    if (record.type === 'compacted') {
      builder.compacted(at)
      continue
    }
    const prompt = hasPromptEvents ? eventPrompt(record) : modelPrompt(record)
    if (prompt) {
      builder.userMessage(prompt, at)
      continue
    }
    if (record.type !== 'response_item' || !payload) continue
    switch (payload.type) {
      case 'message':
        if (payload.role === 'assistant') builder.assistantText(joinText(payload.content, ['output_text']) ?? '', at)
        break
      case 'reasoning': {
        const summary = joinText(payload.summary, ['summary_text'])
        if (summary) builder.reasoning(summary, at)
        break
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call': {
        const callId = stringField(payload.call_id) ?? stringField(payload.id)
        if (!callId) break
        const tool = codexToolCall(payload)
        builder.toolStarted({ toolUseId: callId, toolCallId: callId, tool: tool.name, ...tool }, at)
        break
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = stringField(payload.call_id)
        if (!callId) break
        builder.toolOutput({ toolUseId: callId, toolCallId: callId, ...codexToolOutput(payload.output) }, at)
        break
      }
      default:
        break
    }
  }
  return builder.finish(null)
}

const SHELL_TOOLS = new Set(['shell', 'shell_command', 'exec_command', 'local_shell', 'container.exec'])

/** A tool call as the step row draws it: a shell command as a command, a patch as the files it edits. */
export function codexToolCall(payload: Record<string, unknown>): {
  name: string
  kind: ReturnType<typeof inferConversationToolKind>
  input: ConversationJsonValue
} {
  const name = stringField(payload.name) ?? (payload.type === 'local_shell_call' ? 'local_shell' : 'tool')
  const raw = payload.arguments ?? payload.input ?? asRecord(payload.action) ?? {}
  const args = typeof raw === 'string' ? (parseJson(raw) ?? raw) : raw
  const record = asRecord(args)
  if (SHELL_TOOLS.has(name)) {
    const command = record?.cmd ?? record?.command
    return {
      name: 'Bash',
      kind: 'command',
      input: {
        command: Array.isArray(command) ? command.map(String).join(' ') : String(command ?? ''),
        ...(typeof record?.workdir === 'string' ? { cwd: record.workdir } : {}),
      },
    }
  }
  if (name === 'apply_patch') {
    const patch = typeof args === 'string' ? args : String(record?.input ?? record?.patch ?? '')
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim())
    return { name: 'apply_patch', kind: 'file_edit', input: { ...(paths[0] ? { path: paths[0] } : {}), patch } }
  }
  return {
    name,
    kind: inferConversationToolKind(name),
    input: (record ?? (typeof args === 'string' ? { input: args } : {})) as ConversationJsonValue,
  }
}

/** What a tool call returned. Codex wraps a command's output with its exit code when it knows one. */
export function codexToolOutput(output: unknown): {
  output: string
  status: 'ok' | 'error'
  isError: boolean
  exitCode?: number
} {
  const record = asRecord(typeof output === 'string' ? parseJson(output) : output)
  const text =
    typeof record?.output === 'string'
      ? record.output
      : typeof output === 'string'
        ? output
        : Array.isArray(output)
          ? (joinText(output, ['input_text', 'output_text', 'text']) ?? '')
          : JSON.stringify(output ?? '')
  const exitCode = asRecord(record?.metadata)?.exit_code
  const failed = (typeof exitCode === 'number' && exitCode !== 0) || record?.success === false
  return {
    output: text,
    status: failed ? 'error' : 'ok',
    isError: failed,
    ...(typeof exitCode === 'number' ? { exitCode } : {}),
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

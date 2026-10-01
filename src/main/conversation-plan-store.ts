import { createHash } from 'crypto'
import { lstat, mkdir, readFile, rm, writeFile } from 'fs/promises'
import { extname, isAbsolute, join } from 'path'
import type {
  ConversationKey,
  ConversationPlanDocumentInput,
  ConversationPlanDocumentResult,
} from '../shared/conversation-runtime'
import { slugify } from '../shared/paths'
import { ConversationAttachmentStore } from './conversation-attachment-store'

// The plans an agent proposed, as files the workspace pane opens. The
// transcript holds every plan's text; this turns one into a path.
//
// The agent's own file wins when it still holds this plan: Claude Code keeps
// the plan it is working on in a file and names it on the approval request.
// That file is rewritten as planning goes on, so an earlier plan in the same
// conversation is no longer in it; that plan, and every plan from an agent
// that keeps no file (or keeps it on another machine), is written here from
// the transcript's text instead.
//
// The copy lives in app data, beside the conversation's attachments and under
// the same per-conversation folder, so deleting the conversation removes it.
// Its name is derived from the plan's text, so asking twice for one plan
// opens one file.

const STORE_DIRECTORY = 'conversation-plans'
export const MAX_PLAN_DOCUMENT_BYTES = 1024 * 1024
const MAX_STEM_LENGTH = 48

function sameText(a: string, b: string): boolean {
  const normal = (text: string) => text.replace(/\r\n?/gu, '\n').trim()
  return normal(a) === normal(b)
}

function fileStem(title: string | undefined): string {
  return slugify(title).slice(0, MAX_STEM_LENGTH).replace(/-+$/u, '') || 'plan'
}

export class ConversationPlanStore {
  /** Without a directory no copy can be written; the agent's own file is still used. What tests construct. */
  constructor(private readonly userDataDir?: string) {}

  private get root(): string | null {
    return this.userDataDir ? join(this.userDataDir, STORE_DIRECTORY) : null
  }

  async document(input: ConversationPlanDocumentInput): Promise<ConversationPlanDocumentResult> {
    const plan = input.plan
    if (!plan.trim()) return { ok: false, message: 'The plan is empty.' }
    if (Buffer.byteLength(plan) > MAX_PLAN_DOCUMENT_BYTES) return { ok: false, message: 'The plan is too large.' }

    const own = await this.agentFileHolding(input.planFilePath, plan)
    if (own) return { ok: true, path: own }

    const root = this.root
    if (!root) return { ok: false, message: 'Plans cannot be kept on this machine.' }
    const folder = join(root, ConversationAttachmentStore.folderFor(input))
    const hash = createHash('sha256').update(plan).digest('hex').slice(0, 12)
    const path = join(folder, `${fileStem(input.title)}-${hash}.md`)
    try {
      await mkdir(folder, { recursive: true })
      await writeFile(path, `${plan.trim()}\n`, { flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        return { ok: false, message: error instanceof Error ? error.message : 'The plan could not be saved.' }
      }
    }
    return { ok: true, path }
  }

  /**
   * The agent's plan file, when it is a markdown file on this machine that
   * still holds exactly this plan. Only ever answers with the path it was
   * given, and only a plain file is read.
   */
  private async agentFileHolding(path: string | undefined, plan: string): Promise<string | null> {
    if (!path || !isAbsolute(path) || extname(path).toLowerCase() !== '.md') return null
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.size > MAX_PLAN_DOCUMENT_BYTES) return null
      return sameText(await readFile(path, 'utf8'), plan) ? path : null
    } catch {
      return null
    }
  }

  /** Removes every plan copy a conversation kept; called when the conversation itself is deleted. */
  async deleteConversation(key: ConversationKey): Promise<void> {
    const root = this.root
    if (!root) return
    await rm(join(root, ConversationAttachmentStore.folderFor(key)), { recursive: true, force: true })
  }
}

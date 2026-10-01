import type { ConversationCommand } from '../../shared/conversation/commands'

/**
 * Commands an ACP agent advertises that a chat must not offer. Each is dropped
 * for what it does, not for how it is spelled in one CLI:
 * - `exit`, `quit`: end the terminal session. Over ACP the agent process is
 *   Studio's to start and stop, and a chat has no terminal session to leave.
 * - `always-approve`: switches the agent's own approval mode mid-session. In a
 *   chat the approval mode is the permission preset, a launch flag Studio sets
 *   and shows in the composer's permission pill; toggling it from inside would
 *   leave the pill claiming one thing while the agent does another.
 */
const NOT_FOR_CHAT = new Set(['exit', 'quit', 'always-approve'])

// Cursor tags a command's description with where it came from: `(global)` for
// the person's own command files, `(builtin skill)` / `(user skill)` for a
// skill it exposes as a command. The tag becomes the row's source, and is
// taken off the description so the row does not say it twice. An untagged
// command is the CLI's own, which is also all OpenCode and Grok send today.
const SKILL_TAG = /\s*\((?:(?:builtin|user|project|plugin|team|global)\s+)?skill\)\s*$/i
const CUSTOM_TAG = /\s*\((?:global|project|user|team|plugin)\)\s*$/i

/**
 * The composer's command list from an ACP `available_commands_update` (or the
 * same list in an `initialize` response's metadata). The payload arrives from
 * the agent process, so every field is checked rather than trusted.
 */
export function acpConversationCommands(available: unknown): ConversationCommand[] {
  if (!Array.isArray(available)) return []
  const commands: ConversationCommand[] = []
  const seen = new Set<string>()
  for (const entry of available) {
    if (!entry || typeof entry !== 'object') continue
    const { name, description, input } = entry as { name?: unknown; description?: unknown; input?: unknown }
    if (typeof name !== 'string') continue
    const bare = name.replace(/^\//, '')
    // The composer inserts `/name ` and the agent reads up to the first space,
    // so a name with whitespace in it could never be typed back.
    if (!bare || /\s/.test(bare) || NOT_FOR_CHAT.has(bare.toLowerCase()) || seen.has(bare)) continue
    seen.add(bare)
    let text = typeof description === 'string' ? description.trim() : ''
    let source: ConversationCommand['source'] = 'cli'
    if (SKILL_TAG.test(text)) {
      source = 'skill'
      text = text.replace(SKILL_TAG, '')
    } else if (CUSTOM_TAG.test(text)) {
      source = 'custom'
      text = text.replace(CUSTOM_TAG, '')
    }
    const hint =
      input && typeof input === 'object' && typeof (input as { hint?: unknown }).hint === 'string'
        ? (input as { hint: string }).hint.trim()
        : ''
    commands.push({
      name: bare,
      ...(text ? { description: text } : {}),
      ...(hint ? { argumentHint: hint } : {}),
      source,
    })
  }
  return commands
}

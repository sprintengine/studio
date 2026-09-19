import type { TailnetScope } from '../../../shared/tailnet'

// Mapping the gateway's tool surface onto the shared scope vocabulary
// (src/shared/tailnet.ts). The vocabulary is shared because Settings shows it;
// this mapping is not, because it is about gateway tool NAMES, which only the
// gateway knows.

/**
 * Tools that exist on the local socket only and are never served to a paired
 * device, whatever its scopes.
 *
 * The `tailnet.*` family configures who may drive this machine. A device that
 * could call it could mint a pairing code granting scopes wider than its own,
 * and revoking the device it came in on would not take those away — one grant
 * manufacturing the next is not something a scope can express, so the family
 * sits outside the scope vocabulary entirely rather than behind a very wide one.
 *
 * A prefix rule rather than a list: a tool added to the family later is
 * local-only by default, which is the direction a mistake here should fail.
 */
export function isLocalOnlyGatewayTool(toolName: string): boolean {
  return toolName.startsWith('tailnet.')
}

/**
 * The scope a tool call requires.
 *
 * Family comes from the tool's dot-namespace (the gateway's naming rule,
 * Decision 8); read-vs-operate comes from the gateway's own mutation
 * classification, so the two lists cannot drift — a tool newly classified as a
 * mutation immediately needs the operate grant here too.
 *
 * `workspace` is the deliberate catch-all for the app-wide families
 * (`workspace.*`, `agent.*`, `cli.*`, `module.*`, `marketplace.*`,
 * `automation.*`, `review_*`) and for any tool this mapping has not been taught.
 * Unknown does not mean unrestricted: an unmapped mutation still requires
 * `workspace:operate`, so a device without it is refused rather than served.
 *
 * `terminal.*` is the one family whose scopes are not named read/operate — the
 * tier is about watching versus typing, not reading versus mutating — so it is
 * mapped by name rather than by the suffix rule.
 *
 * `tailnet.*` never reaches this function: it is refused as local-only first.
 */
export function requiredScopeForTool(toolName: string, isMutation: boolean): TailnetScope {
  if (toolName.startsWith('terminal.')) return isMutation ? 'terminal:control' : 'terminal:observe'
  return `${toolFamily(toolName)}:${isMutation ? 'operate' : 'read'}` as TailnetScope
}

function toolFamily(toolName: string): 'workspace' | 'backlog' {
  if (toolName.startsWith('backlog.')) return 'backlog'
  return 'workspace'
}

// Part of the IPC contract: running a card and what it hands back.
// ../electron-api.ts re-exports everything here.

import type { CardAction, CardActionVerb, CardSurfaceView } from '../hosted-card-feed'
import type { CliPermissionPreset } from './agent-runtime'
import type { McpServerConfig } from './mcp'

// Running a card's actions — `cards:run`, the one press the Extensions home
// offers (backlog/2026-09-06-go-runs-a-cards-actions.md, item 2469). The
// executor is `src/main/cards/run-card.ts`; these are the envelopes.
//
// Nothing in the request comes from the feed except `actions` and `slug`. The
// workspace, the place clones go and the MCP servers this machine has
// configured are all the app's own facts, sent in because a card carries no
// workspace by design and because MCP settings live in the renderer's store
// rather than on disk in main.
export type CardRunInput = {
  /** The card's slug, for the messages. Never used as a path or an id. */
  slug: string
  actions: CardAction[]
  /** The workspace the person is in; null when none is open. */
  workspaceRoot: string | null
  /** Where this app puts projects — `clone.repo`'s parent directory. */
  cloneParentDir: string | null
  mcpServers: McpServerConfig[]
  /**
   * The app's MCP sync switch as it currently stands. Carried rather than
   * assumed: the executor used to sync with `syncEnabled: true` hardcoded,
   * which turned a setting back on for somebody who had turned it off. It flips
   * to true only when a card ADDS a server, because that is what the settings
   * store does with that same server (`upsertMcpServer`).
   */
  mcpSyncEnabled: boolean
  /**
   * The model row the person chose in the picker `Go` opens (owner ruling R4b,
   * 2026-09-06, item 2473). Choosing a row is what starts the run, so the row's
   * own axes travel with it: the model id (null is the runtime's own default
   * model), the reasoning effort where the CLI declares one, and the permission
   * preset stored against that row (`modelFavouriteKey`, falling back to
   * `appSettings.lastAgentSpawnPermissionPreset`).
   *
   * They are carried here rather than kept in a renderer closure so that ONE
   * object describes the launch on the way back: `CardChatHandoff` already
   * carries the cli a `require.cli` verified, and a launch whose runtime came
   * from the hand-off while its model came from a variable captured minutes
   * earlier is a pair that drifts. Main does not interpret any of the three; it
   * checks their shape and hands them back on the chat.
   *
   * All three are optional because a caller that has not opened a picker (a
   * test, a future headless run) is a caller with no row to describe, and an
   * absent field must mean "the app's own default" rather than "no model".
   */
  model?: string | null
  reasoning?: string | null
  permissionPreset?: CliPermissionPreset
}

/** `already` is a no-op that succeeded; `skipped` is an action a failure before it stopped. */
export type CardActionStatus = 'done' | 'already' | 'failed' | 'skipped'

export type CardActionOutcome = {
  index: number
  verb: CardActionVerb
  status: CardActionStatus
  /** One sentence, in the words a toast can show. */
  message: string
}

/**
 * What the renderer must do once every install before it has succeeded. Main
 * can neither open a chat nor move a door, so both verbs are validated in the
 * executor's switch and performed on the other side of the wire.
 */
export type CardChatHandoff = {
  prompt: string
  send: boolean
  /** Installed skill directory names. */
  skills: string[]
  /**
   * The agent CLI a `require.cli` in the same card verified, or null when it
   * required none. The chat launches on this one so the harness the card's
   * skills were installed into is the harness the chat runs in.
   *
   * There is no `mcpServers` here. The first cut carried one and neither
   * renderer path read it: for a server the card installed it worked by
   * accident, because the CLI reads the `.mcp.json` the install just wrote, and
   * for one the card only named it silently attached nothing. The invariant is
   * now real instead — `refuseCardActions` refuses a card whose chat names a
   * server no earlier action installs — so the field had nothing left to say.
   */
  cli: string | null
  /**
   * The rest of the row the person chose in the picker (item 2473), echoed back
   * beside the cli so the hand-off describes the WHOLE launch rather than half
   * of it. `model` is null for the runtime's own default model, `reasoning` is
   * null where the CLI declares no effort axis, and `permissionPreset` is null
   * when the request carried none — the spawn then resolves the row's preset
   * itself, exactly as every other spawn in the app does.
   */
  model: string | null
  reasoning: string | null
  permissionPreset: CliPermissionPreset | null
}

export type CardSurfaceHandoff = { view: CardSurfaceView; installed: boolean }

export type CardRunResult = {
  ok: boolean
  /** One entry per action, in the card's own order. */
  outcomes: CardActionOutcome[]
  /** The workspace the run ended in — `clone.repo` moves it. */
  workspaceRoot: string | null
  /**
   * The servers this run ADDED, for the surface to write back — not the merged
   * list. `upsertMcpServer` turns MCP sync on for every server it is handed,
   * and handing it servers the person already had would flip that switch on
   * their behalf for a server they did not just install.
   */
  mcpServers: McpServerConfig[]
  chat: CardChatHandoff | null
  surface: CardSurfaceHandoff | null
  /** The sentence a failure toast leads with; absent on success. */
  message?: string
}

// SSH machines as environments (phase 8): what the renderer and main say to
// each other about them. An SSH machine is not an execution host
// (`execution-host.ts`): it is a whole other Studio server, reached over an
// SSH session main holds, and on it every process is that server's `local`.
//
// Pure and shared: no fs, no electron.

/** The channels, all owned by main (it holds the SSH sessions and their prompts). */
export const SSH_ENV_CHANNELS = {
  /** renderer → main: the saved SSH machines with their state. */
  list: 'environments:ssh:list',
  /** renderer → main: what `ssh -G` resolves a destination to, before it is saved. */
  resolve: 'environments:ssh:resolve',
  /** renderer → main: the `Host` names in the person's SSH config, as suggestions. */
  suggestions: 'environments:ssh:suggestions',
  /** renderer → main: save a machine `{ destination, label? }`. */
  add: 'environments:ssh:add',
  /** renderer → main: change a machine's settings `{ id, patch }`. */
  update: 'environments:ssh:update',
  /** renderer → main: connect now `{ id }` (the person's own click: prompts may be shown). */
  connect: 'environments:ssh:connect',
  /** renderer → main: let the session go `{ id }`; the managed server keeps running (decision R32). */
  disconnect: 'environments:ssh:disconnect',
  /** renderer → main: drain and stop a managed server `{ id }`. */
  stopServer: 'environments:ssh:stop-server',
  /** renderer → main: an older external server, upgraded in place once the person said so `{ id }`. */
  upgradeServer: 'environments:ssh:upgrade-server',
  /** renderer → main: forget a machine `{ id, stopServer?, clearBrowsingData? }`. */
  forget: 'environments:ssh:forget',
  /** renderer → main: sign a chat's CLI in on the machine `{ id, providerId }` (decision R34). */
  signIn: 'environments:ssh:sign-in',
  /** renderer → main: the diagnostics for one machine `{ id }`, redacted for copying. */
  diagnostics: 'environments:ssh:diagnostics',
  /** main → renderer: the list changed; carries nothing, a window asks again. */
  changed: 'environments:ssh:changed',
  /** main → renderer: ssh asks something (`SshPromptRequest`). */
  prompt: 'environments:ssh:prompt',
  /** main → renderer: a prompt is over (answered elsewhere, timed out, ssh gave up) `{ id }`. */
  promptClosed: 'environments:ssh:prompt-closed',
  /** renderer → main: the answer `{ id, answer }`, null to cancel. */
  answer: 'environments:ssh:prompt-answer',
} as const

/** What goes through the remote from that machine's browser pane tabs (decision R76). */
export type SshPaneTraffic = 'all' | 'loopback' | 'off'

export type SshEnvironmentSettings = {
  /** Leave the managed server up when the last client goes (no idle stop). */
  keepRunning: boolean
  paneTraffic: SshPaneTraffic
  /** For a home mounted `noexec`: where the runtime and the server tree go instead. */
  installDir: string | null
  /** Install the pinned Node by having the remote download it (digest checked there), not by streaming it. */
  remoteDownload: boolean
}

export const DEFAULT_SSH_ENVIRONMENT_SETTINGS: SshEnvironmentSettings = {
  keepRunning: false,
  paneTraffic: 'all',
  installDir: null,
  remoteDownload: false,
}

/** A saved SSH machine, as the desktop keeps it in userData (client-owned; it holds no credential). */
export type SavedSshEnvironment = {
  id: string
  label: string
  /** What the person typed: an alias, or `user@host[:port]`. */
  destination: string
  /** What `ssh -G` resolved it to when it was saved; shown, never used to connect. */
  resolved: { hostname: string; user: string; port: number; proxyJump: string | null } | null
  /** The server's environment id, once one has been reached (its pane partition is keyed by it). */
  environmentId: string | null
  settings: SshEnvironmentSettings
  addedAt: number
}

export type SshEnvironmentState =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'asking'
  | 'probing'
  | 'installing'
  | 'starting'
  | 'upgrading'
  | 'connected'
  | 'reconnecting'
  | 'needs-sign-in'
  | 'version-blocked'
  | 'unsupported'
  | 'failed'
  | 'disconnected'

export type SshEnvironmentSummary = SavedSshEnvironment & {
  state: SshEnvironmentState
  /** The state in words: "Connected", "Installing Studio server 0.4.0 (34 MB)", "Reconnecting — last reached 2 min ago". */
  stateText: string
  /** Whether a step is running now (the working mark shows only then). */
  working: boolean
  /** What can be done about it, when something can: Connect, Update, Use another folder. */
  action: 'connect' | 'upgrade' | null
  server: { version: string; origin: string; startedBy: string | null } | null
  /** Facts about the machine for Settings: its OS, and what keeps the server running. */
  notes: string[]
}

export type SshPromptKind = 'host-key' | 'passphrase' | 'password' | 'confirm' | 'touch' | 'remote' | 'sign-in'

/** Something ssh asks, shown in a Studio dialog (phase 8 spec, 5.5). */
export type SshPromptRequest = {
  id: string
  /** The machine it is for, by its label. */
  label: string
  kind: SshPromptKind
  /**
   * The text: for `remote`, exactly what the remote sent, shown verbatim
   * inside a frame that says which machine asks, so it cannot pass for a
   * Studio prompt. For the others, ssh's own words.
   */
  text: string
  /** `host-key` only, from ssh's fixed question. */
  hostKey?: { host: string; keyType: string; fingerprint: string }
  /**
   * `passphrase` or `password` from an ssh older than OpenSSH 8.4, which does
   * not mark the remote's own questions: the remote could have written the
   * same words, so the dialog shows them verbatim and says it cannot tell.
   */
  unverified?: boolean
  /**
   * `sign-in` only: a CLI's login running on the machine. The link opens in
   * this computer's browser; a device code is typed there; a pasted code is
   * this dialog's answer. The dialog closes itself when the login finishes.
   */
  signIn?: { cli: string; url: string; code: string | null; paste: boolean }
  /** When the dialog gives up and answers nothing. */
  expiresAt: number
}

export type SshResolveResult =
  | { ok: true; destination: string; resolved: NonNullable<SavedSshEnvironment['resolved']> & { notes: string[] } }
  | { ok: false; message: string }

export type SshEnvironmentResult = { ok: true } | { ok: false; message: string }

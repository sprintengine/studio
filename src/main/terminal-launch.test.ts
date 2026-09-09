import assert from 'node:assert/strict'

import { buildHostContextDocument } from '../shared/host-context/document'
import {
  OSC7_BASH_PROMPT_COMMAND,
  applyAgentIdentityEnv,
  buildOsc7ShellSetup,
  buildOsc7ZshShim,
  applyHostContextToPrompt,
  hostContextRenderInputs,
  mergeProviderLaunchEnv,
  type HostContextDelivery,
} from './terminal-launch'

async function main(): Promise<void> {
  testNoOpWithoutProviderEnv()
  testProviderEnvWinsOnCollision()
  testStripsApiKeyOnBaseUrlRedirectWithoutToken()
  testStripsApiKeyWhenTokenSet()
  testKeepsApiKeyWhenNoAnthropicRedirect()
  testNeverOverridesProtectedKeys()
  testStripsInheritedAgentStateSocket()
  testSocketNeverClobberedByProviderEnv()
  testJsonEnvValuesMergeInsteadOfClobbering()
  testNothingIsDeliveredWhenTheHostHasNothingToSay()
  testArgvModeCarriesTheFileAndTheText()
  testPromptModeWritesNoFileAndWrapsTheRequest()
  testPromptModeLeavesAnEmptyComposerAlone()
  testWslAndWindowsNormalizeTheContextPaths()
  testOsc7ReportsAnEmptyHostAndEscapesWhatWouldChangeTheMeaning()
  testTheZshShimHandsEveryStageBackToTheUsersOwnFiles()
  testOnlyTheShellsWeCanReachThroughEnvAreArmed()
  console.log('terminal-launch tests passed')
}

// A manifest with no launch.env must not touch the base env at all.
function testNoOpWithoutProviderEnv(): void {
  const base = { PATH: '/bin', ANTHROPIC_API_KEY: 'real-key' }
  assert.equal(mergeProviderLaunchEnv(base, undefined), base, 'undefined provider env returns base by reference')
  assert.equal(mergeProviderLaunchEnv(base, {}), base, 'empty provider env returns base by reference')
}

function testProviderEnvWinsOnCollision(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', FOO: 'base' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', FOO: 'provider' }
  )
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(out.FOO, 'provider')
}

// The critical leak case: endpoint redirected but NO token configured, while a
// real ANTHROPIC_API_KEY is inherited. It must be stripped so the real key is
// never sent to the redirect target (the launch fails closed instead).
function testStripsApiKeyOnBaseUrlRedirectWithoutToken(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key', PATH: '/bin' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2' }
  )
  assert.equal('ANTHROPIC_API_KEY' in out, false, 'inherited real key must not survive an endpoint redirect')
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic')
  assert.equal(out.PATH, '/bin')
}

function testStripsApiKeyWhenTokenSet(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key' },
    { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'zai-token' }
  )
  assert.equal('ANTHROPIC_API_KEY' in out, false)
  assert.equal(out.ANTHROPIC_AUTH_TOKEN, 'zai-token')
}

// A provider env that does not touch the Anthropic endpoint must leave an
// inherited ANTHROPIC_API_KEY alone (no over-stripping).
function testKeepsApiKeyWhenNoAnthropicRedirect(): void {
  const out = mergeProviderLaunchEnv(
    { ANTHROPIC_API_KEY: 'real-anthropic-key' },
    { SOME_OTHER_VAR: 'x' }
  )
  assert.equal(out.ANTHROPIC_API_KEY, 'real-anthropic-key')
  assert.equal(out.SOME_OTHER_VAR, 'x')
}

// Identity/terminal keys are owned by the host and must never be clobbered by a
// manifest's launch.env, even a malicious one.
function testNeverOverridesProtectedKeys(): void {
  const out = mergeProviderLaunchEnv(
    { TERM: 'xterm-256color', FORCE_HYPERLINK: '1', MULTICODE_AGENT_ID: 'agent-1', PATH: '/bin' },
    {
      TERM: 'evil',
      FORCE_HYPERLINK: '0',
      MULTICODE_AGENT_ID: 'spoofed',
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
    }
  )
  assert.equal(out.TERM, 'xterm-256color', 'TERM is protected')
  assert.equal(out.FORCE_HYPERLINK, '1', 'the hyperlink capability is the pane\'s to declare, not a manifest\'s')
  assert.equal(out.MULTICODE_AGENT_ID, 'agent-1', 'agent identity is protected')
  assert.equal(out.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic', 'non-protected keys still apply')
}

// A stale MULTICODE_AGENT_STATE_SOCKET inherited by the app's own process (the
// app launched from inside an agent shell) must never leak into a launched
// session: an identity-less launch carries none, and an agent launch replaces
// it with this instance's own address (unresolvable outside Electron, where it
// is simply omitted — never the inherited value).
function testStripsInheritedAgentStateSocket(): void {
  const base = {
    PATH: '/bin',
    MULTICODE_AGENT_STATE_SOCKET: '/tmp/other-instance.sock',
    MULTICODE_AGENT_ID: 'stale-agent',
  }
  const plain = applyAgentIdentityEnv(base, {})
  assert.equal('MULTICODE_AGENT_STATE_SOCKET' in plain, false, 'identity-less launch drops inherited socket')
  assert.equal('MULTICODE_AGENT_ID' in plain, false, 'identity-less launch drops inherited agent id')

  const agent = applyAgentIdentityEnv(base, { workspaceId: 'ws-1', agentId: 'agent-1' })
  assert.equal(agent.MULTICODE_AGENT_ID, 'agent-1')
  assert.notEqual(
    agent.MULTICODE_AGENT_STATE_SOCKET,
    '/tmp/other-instance.sock',
    'inherited socket address must never survive onto an agent launch'
  )
}

// The socket address is app-owned launch identity: a CLI manifest's launch.env
// must not be able to redirect agent-state reporting to another socket.
function testSocketNeverClobberedByProviderEnv(): void {
  const out = mergeProviderLaunchEnv(
    { MULTICODE_AGENT_STATE_SOCKET: '/tmp/ours.sock', PATH: '/bin' },
    { MULTICODE_AGENT_STATE_SOCKET: '/tmp/theirs.sock' }
  )
  assert.equal(out.MULTICODE_AGENT_STATE_SOCKET, '/tmp/ours.sock', 'socket address is protected')
}

// ── Host context ────────────────────────────────────────────────────────────
//
// The delivery decision and the path normalisation over it are what this file
// owns. Which flags each CLI actually ends up with is proved against the bundled
// manifests in agent-launch-render.test.ts, through the same renderer the spawn
// uses.

const DESIGN_SYSTEM_DOCUMENT = buildHostContextDocument({
  designSystem: { bundlePath: 'C:/repo/design-system' },
}) as string

function delivery(overrides: Partial<HostContextDelivery> = {}): HostContextDelivery {
  return {
    mode: 'argv',
    document: DESIGN_SYSTEM_DOCUMENT,
    filePath: 'C:/Users/me/AppData/Roaming/Studio/host-context/s1.md',
    ...overrides,
  }
}

// The host-context env channel carries a whole JSON config document (OpenCode's
// OPENCODE_CONFIG_CONTENT). A user who exports their own must not lose it
// because we wanted to add one instructions entry — and must not lose ours.
function testJsonEnvValuesMergeInsteadOfClobbering(): void {
  const out = mergeProviderLaunchEnv(
    { OPENCODE_CONFIG_CONTENT: '{"theme":"tokyonight","instructions":["AGENTS.md"]}' },
    { OPENCODE_CONFIG_CONTENT: '{"instructions":["/ctx/s1.md"]}' }
  )
  const merged = JSON.parse(out.OPENCODE_CONFIG_CONTENT) as { theme: string; instructions: string[] }
  assert.equal(merged.theme, 'tokyonight', "the user's own keys survive")
  assert.deepEqual(merged.instructions, ['AGENTS.md', '/ctx/s1.md'], 'lists concatenate')

  // Everything that is not a JSON object still takes the plain replacement path,
  // so no other manifest's env changes behaviour.
  const plain = mergeProviderLaunchEnv({ ANTHROPIC_BASE_URL: 'https://a' }, { ANTHROPIC_BASE_URL: 'https://b' })
  assert.equal(plain.ANTHROPIC_BASE_URL, 'https://b')
}

// A plain repo — no design system, no knowledge graph — launches exactly as it
// did: no flag, no env, no wrapping.
function testNothingIsDeliveredWhenTheHostHasNothingToSay(): void {
  assert.equal(buildHostContextDocument({}), null)
  const empty = delivery({ document: null, filePath: null })
  assert.deepEqual(hostContextRenderInputs(empty, null, []), {})
  assert.equal(applyHostContextToPrompt(empty, 'Build it.'), 'Build it.')
}

function testArgvModeCarriesTheFileAndTheText(): void {
  const inputs = hostContextRenderInputs(delivery(), null, [])
  assert.equal(inputs.contextFile, 'C:/Users/me/AppData/Roaming/Studio/host-context/s1.md')
  assert.ok(inputs.contextText?.includes('design system is attached'))
  // The user's prompt is untouched: that is the whole point of the channel.
  assert.equal(applyHostContextToPrompt(delivery(), 'Build it.'), 'Build it.')

  // A write that failed withholds BOTH, so a manifest spending {{contextFile}}
  // renders no flag rather than a flag with an empty value.
  assert.deepEqual(hostContextRenderInputs(delivery({ filePath: null }), null, []), {})
}

function testPromptModeWritesNoFileAndWrapsTheRequest(): void {
  const prompt = delivery({ mode: 'prompt', filePath: null })
  assert.deepEqual(hostContextRenderInputs(prompt, null, []), {}, 'no flag, no env')
  const wrapped = applyHostContextToPrompt(prompt, 'Build the settings page.')
  assert.ok(wrapped?.startsWith('<host-context>'))
  assert.ok(
    (wrapped ?? '').indexOf('</host-context>') < (wrapped ?? '').indexOf('Build the settings page.'),
    'the request is the last thing the model reads',
  )
}

// A CLI launched with nothing typed is meant to sit at its prompt. Handing it a
// host-context block as its first message would start it working on our words.
function testPromptModeLeavesAnEmptyComposerAlone(): void {
  const prompt = delivery({ mode: 'prompt', filePath: null })
  assert.equal(applyHostContextToPrompt(prompt, undefined), undefined)
  assert.equal(applyHostContextToPrompt(prompt, '   '), '   ')
}

// The document names the design-system folder absolutely and the file itself is
// under the app's own userData. A Windows path handed to a CLI running under WSL
// points at nothing, so both are rewritten for the shell that will read them.
function testWslAndWindowsNormalizeTheContextPaths(): void {
  const wsl = hostContextRenderInputs(delivery(), 'wsl', ['C:/repo'])
  assert.equal(wsl.contextFile, '/mnt/c/Users/me/AppData/Roaming/Studio/host-context/s1.md')
  assert.ok(wsl.contextText?.includes('/mnt/c/repo/design-system'), wsl.contextText)
  assert.ok(!wsl.contextText?.includes('C:/repo'), 'no Windows path survives into a WSL document')

  const windows = hostContextRenderInputs(
    { mode: 'argv', document: buildHostContextDocument({ designSystem: { bundlePath: '/mnt/c/repo/design-system' } }), filePath: '/mnt/c/ctx/s1.md' },
    'windows',
    ['/mnt/c/repo'],
  )
  assert.equal(windows.contextFile, 'C:\\ctx\\s1.md')
  // Prefix rewriting, not a full re-separation: the known roots become Windows
  // paths and whatever hangs off them keeps its slashes, which is exactly what
  // the initial prompt has always done here (and what Windows accepts).
  assert.ok(windows.contextText?.includes('C:\\repo/design-system'), windows.contextText)
  assert.ok(!windows.contextText?.includes('/mnt/c/'), 'no WSL path survives into a native-Windows document')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

// ── OSC 7 ───────────────────────────────────────────────────────────────────

// The renderer refuses any `file:` URI that names a host — a pane attached to
// another machine must never resolve a local path, and this machine's hostname
// is indistinguishable from someone else's once it is on the wire. So the
// emitter's half of that contract is: never send one.
function testOsc7ReportsAnEmptyHostAndEscapesWhatWouldChangeTheMeaning(): void {
  assert.match(
    OSC7_BASH_PROMPT_COMMAND,
    /printf '\\033\]7;file:\/\/%s\\033\\\\' "\$__multicode_osc7"/u,
    'an empty host, and $PWD (already absolute) supplies the leading slash',
  )
  assert.ok(
    !/file:\/\/\$\{?HOST/u.test(OSC7_BASH_PROMPT_COMMAND),
    'never the hostname form other terminals emit',
  )

  const escapes = [...OSC7_BASH_PROMPT_COMMAND.matchAll(/%([0-9A-F]{2})\}/gu)].map((match) => match[1])
  assert.deepEqual(
    escapes,
    ['25', '23', '3F', '5C'],
    '% is escaped FIRST — every later replacement introduces one, and a second pass would turn %5C into %255C',
  )

  const zshrc = buildOsc7ZshShim('.zshrc')
  const zshEscapes = [...zshrc.matchAll(/%([0-9A-F]{2})\}/gu)].map((match) => match[1])
  assert.deepEqual(zshEscapes, ['25', '23', '3F', '5C'], 'both shells escape the same set in the same order')
  assert.match(zshrc, /printf '\\033\]7;file:\/\/%s\\033\\\\' \$d/u)
}

// The shim stands in front of the user's $ZDOTDIR, so the one thing it must
// never do is cost them a startup file or leave $ZDOTDIR pointing at us.
function testTheZshShimHandsEveryStageBackToTheUsersOwnFiles(): void {
  for (const fileName of ['.zshenv', '.zprofile', '.zshrc', '.zlogin'] as const) {
    const shim = buildOsc7ZshShim(fileName)
    assert.ok(
      shim.includes(`if [[ -f $ZDOTDIR/${fileName} ]]; then source $ZDOTDIR/${fileName}; fi`),
      `${fileName} sources the user's own copy — zsh takes the WHOLE set from $ZDOTDIR, so a missing shim silently drops that file`,
    )
    assert.ok(shim.includes('ZDOTDIR=${MULTICODE_USER_ZDOTDIR:-$HOME}'), `${fileName} runs it with their own $ZDOTDIR`)
    assert.ok(
      shim.includes('if [[ $ZDOTDIR == $MULTICODE_ZDOTDIR_SELF ]]; then ZDOTDIR=$HOME; fi'),
      `${fileName} refuses to source itself if a relaunch pointed us at ourselves`,
    )
  }

  // Only the interactive stage installs the hook, and it is the stage that
  // hands $ZDOTDIR back for good.
  const zshrc = buildOsc7ZshShim('.zshrc')
  assert.ok(zshrc.includes('precmd_functions+=(__multicode_osc7_cwd)'))
  assert.ok(
    zshrc.includes('if (( ! ${precmd_functions[(I)__multicode_osc7_cwd]} )); then'),
    'a nested zsh reads this file again and must not stack a second hook',
  )
  assert.ok(zshrc.trimEnd().endsWith('__multicode_osc7_cwd'), 'the launch directory is reported before the first prompt')
  assert.ok(zshrc.includes('ZDOTDIR=$MULTICODE_USER_ZDOTDIR'), 'the shell is left holding its own $ZDOTDIR')
  for (const fileName of ['.zshenv', '.zprofile', '.zlogin'] as const) {
    assert.ok(
      !buildOsc7ZshShim(fileName).includes('precmd_functions'),
      `${fileName} installs no hook — the interactive stage owns it`,
    )
  }
}

// Only the environment survives the `exec` into the user's real shell, so a
// shell with no env-only hook gets nothing rather than a broken approximation.
function testOnlyTheShellsWeCanReachThroughEnvAreArmed(): void {
  const bash = buildOsc7ShellSetup('bash', null)
  assert.ok(bash?.startsWith('export PROMPT_COMMAND='), 'bash imports PROMPT_COMMAND from env')
  assert.ok(bash.includes(`'"'"'`), 'the emitter is quoted for the startup script, not pasted raw')

  const zsh = buildOsc7ShellSetup('zsh', '/profile/shell-integration/zsh')
  assert.equal(
    zsh,
    'if [ "${ZDOTDIR:-}" != \'/profile/shell-integration/zsh\' ]; then export MULTICODE_USER_ZDOTDIR="${ZDOTDIR:-$HOME}"; fi; '
    + "export ZDOTDIR='/profile/shell-integration/zsh'",
  )

  assert.equal(buildOsc7ShellSetup('zsh', null), null, 'no shim directory (unwritable profile) means no OSC 7, not a broken $ZDOTDIR')
  assert.equal(buildOsc7ShellSetup('sh', '/profile/shell-integration/zsh'), null)
  assert.equal(buildOsc7ShellSetup('fish', '/profile/shell-integration/zsh'), null)
  assert.equal(buildOsc7ShellSetup(undefined, '/profile/shell-integration/zsh'), null)
}

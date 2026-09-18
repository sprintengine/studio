// `${CLAUDE_PLUGIN_ROOT}`: what counts as a reference to the plugin's own
// directory, and what resolving one leaves behind
// (backlog/2026-09-06-a-plugins-own-files-must-land-before-its-server-can-start.md).

import assert from 'node:assert/strict'

import type { ScannedMcpServer } from '../skills'
import {
  PLUGIN_ROOT_VARIABLE,
  pluginNeedsOwnFiles,
  referencesPluginRoot,
  resolvePluginRoot,
  textReferencesPluginRoot,
} from './plugin-root'

function server(over: Partial<ScannedMcpServer> = {}): ScannedMcpServer {
  return {
    id: 'telegram',
    name: 'telegram',
    description: '',
    transport: 'stdio',
    command: 'bun',
    args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}', '--shell=bun', '--silent', 'start'],
    url: '',
    env: {},
    envVarNames: ['CLAUDE_PLUGIN_ROOT'],
    headers: {},
    declaredIn: 'external_plugins/telegram/.mcp.json',
    declaredBy: 'telegram',
    ...over,
  }
}

/** Telegram's real declaration, byte for byte, is the case this exists for. */
function theOfficialRepositorysFourServersAreRecognised(): void {
  assert.equal(referencesPluginRoot(server()), true)
  assert.equal(pluginNeedsOwnFiles({ components: { mcpServers: [server()] } }), true)
  assert.equal(pluginNeedsOwnFiles({ components: { mcpServers: [] } }), false)
}

/** Every spelling a shell would expand, and nothing that merely looks like one. */
function theSpellingsAreExact(): void {
  assert.equal(textReferencesPluginRoot('${CLAUDE_PLUGIN_ROOT}'), true)
  assert.equal(textReferencesPluginRoot('$CLAUDE_PLUGIN_ROOT/server.ts'), true)
  assert.equal(textReferencesPluginRoot('${CLAUDE_PLUGIN_ROOT:-/tmp}'), true)
  assert.equal(
    textReferencesPluginRoot('$CLAUDE_PLUGIN_ROOTS'),
    false,
    'a longer variable name is a different variable, not this one with a suffix',
  )
  assert.equal(textReferencesPluginRoot('${CONTEXT7_API_KEY:-}'), false, "somebody's secret is not the plugin root")
  assert.equal(textReferencesPluginRoot('npx'), false)
}

/** A second call must answer the same: the pattern is global and stateful. */
function askingTwiceAnswersTheSame(): void {
  const text = '${CLAUDE_PLUGIN_ROOT}'
  assert.equal(textReferencesPluginRoot(text), true)
  assert.equal(textReferencesPluginRoot(text), true, 'a global regexp remembers where it stopped unless it is reset')
  assert.equal(referencesPluginRoot(server()), true)
  assert.equal(referencesPluginRoot(server()), true)
}

/** The variable is found wherever a declaration can hide it, not only in args. */
function everyFieldIsSearched(): void {
  assert.equal(referencesPluginRoot(server({ args: [], command: '${CLAUDE_PLUGIN_ROOT}/bin/serve' })), true)
  assert.equal(referencesPluginRoot(server({ args: [], env: { CONFIG: '$CLAUDE_PLUGIN_ROOT/config.json' } })), true)
  assert.equal(
    referencesPluginRoot(
      server({ args: [], transport: 'http', command: '', url: 'http://localhost/${CLAUDE_PLUGIN_ROOT}' }),
    ),
    true,
  )
  assert.equal(
    referencesPluginRoot(
      server({
        args: [],
        headers: { 'X-Root': '${CLAUDE_PLUGIN_ROOT}' },
        transport: 'http',
        command: '',
        url: 'http://x',
      }),
    ),
    true,
  )
  assert.equal(referencesPluginRoot(server({ args: ['run', 'start'], envVarNames: [] })), false)
}

/**
 * Resolving does three things, and the third is the one a reader forgets: the
 * variable stops being something the person is asked to fill in.
 */
function resolvingSubstitutesExportsAndStopsAsking(): void {
  const resolved = resolvePluginRoot(server(), '/w/.multicode/claude-plugins/telegram')
  assert.deepEqual(resolved.args, [
    'run',
    '--cwd',
    '/w/.multicode/claude-plugins/telegram',
    '--shell=bun',
    '--silent',
    'start',
  ])
  assert.equal(resolved.command, 'bun', 'the runtime is untouched — it is looked up on PATH, not in the plugin')
  assert.equal(
    resolved.env[PLUGIN_ROOT_VARIABLE],
    '/w/.multicode/claude-plugins/telegram',
    'exported too, so a package.json script that reads it gets the right answer',
  )
  assert.deepEqual(resolved.envVarNames, [], 'nothing is still waiting for a value it has been given')
}

/** A secret the source only names survives resolution untouched. */
function somebodyElsesVariablesAreLeftAlone(): void {
  const resolved = resolvePluginRoot(
    server({
      args: ['--cwd', '${CLAUDE_PLUGIN_ROOT}'],
      env: { TOKEN: '${TELEGRAM_TOKEN}' },
      envVarNames: ['CLAUDE_PLUGIN_ROOT', 'TELEGRAM_TOKEN'],
    }),
    '/w/p',
  )
  assert.deepEqual(resolved.args, ['--cwd', '/w/p'])
  assert.equal(resolved.env.TOKEN, '${TELEGRAM_TOKEN}')
  assert.deepEqual(resolved.envVarNames, ['TELEGRAM_TOKEN'])
}

function main(): void {
  theOfficialRepositorysFourServersAreRecognised()
  theSpellingsAreExact()
  askingTwiceAnswersTheSame()
  everyFieldIsSearched()
  resolvingSubstitutesExportsAndStopsAsking()
  somebodyElsesVariablesAreLeftAlone()
  console.log('mcp plugin-root tests passed')
}

main()

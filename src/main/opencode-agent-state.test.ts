// The OpenCode agent-state PLUGIN, driven end to end.
//
// Unlike every other CLI's reporter, this one is not a stdin filter — it is an
// in-process OpenCode plugin, so it cannot be spawned with a payload on stdin.
// The test therefore does what the installer does (render the bundled template
// with `renderAgentStatePluginTemplate`, the same call agent-state-service
// makes for a `plugin-file` registration) and then loads the rendered module in
// a child Node process that calls its `tool.execute.after` hook by hand. A
// child rather than an in-process import because this test is bundled to CJS
// and the plugin is ESM.
//
// The payloads below are the REAL shapes, captured live from opencode 1.18.30
// (the latest release) on 2026-09-09 by installing a dump plugin into
// .opencode/plugin/ and running `opencode run`. Only the capture directory is
// rewritten, to keep the assertions readable; every hunk header, context line
// and count is byte-identical to what OpenCode sent.
//
// Every frame is put through `parseAgentStateFrame` — main's own door — so the
// test proves not just "the plugin emitted something" but "main accepts it".

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:net'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseAgentStateFrame, renderAgentStatePluginTemplate, type AgentStateFrame } from './agent-state'
import { compatStudioEnvEntry } from '../shared/studio-env'
import { test } from 'vitest'

test('opencode-agent-state', async () => {
  type ToolCall = { input: unknown; output: unknown }

  const DIRECTORY = '/repo/work'
  const SAMPLE = '/repo/work/sample.txt'
  const FRESH = '/repo/work/fresh.txt'

  // The captured `edit` diff: jsdiff formatPatch — an Index:/===/---/+++ preamble
  // and four lines of context on each side of the change.
  const EDIT_PATCH = [
    `Index: ${SAMPLE}`,
    '===================================================================',
    `--- ${SAMPLE}`,
    `+++ ${SAMPLE}`,
    '@@ -3,9 +3,9 @@',
    ' line 3',
    ' line 4',
    ' line 5',
    ' line 6',
    '-line 7',
    '+row 7',
    ' line 8',
    ' line 9',
    ' line 10',
    ' line 11',
    '',
  ].join('\n')

  // The captured PURE DELETION: two `-` lines and nothing added, so the new side
  // of the region is an anchor (`+11,0` — "removed after new line 11").
  const DELETE_PATCH = [
    `Index: ${SAMPLE}`,
    '===================================================================',
    `--- ${SAMPLE}`,
    `+++ ${SAMPLE}`,
    '@@ -8,10 +8,8 @@',
    ' line 8',
    ' line 9',
    ' line 10',
    ' line 11',
    '-line 12',
    '-line 13',
    ' line 14',
    ' line 15',
    ' line 16',
    ' line 17',
    '',
  ].join('\n')

  const editCall = (patch: string, additions: number, deletions: number, file: string = SAMPLE): ToolCall => ({
    input: {
      tool: 'edit',
      sessionID: 'ses_opencode_1',
      callID: 'call_1',
      args: { filePath: file, oldString: 'line 7', newString: 'row 7' },
    },
    output: {
      title: 'sample.txt',
      output: 'Edit applied successfully.',
      metadata: { diagnostics: {}, diff: patch, filediff: { file, patch, additions, deletions }, truncated: false },
    },
  })

  async function run(): Promise<void> {
    const workDir = await mkdtemp(join(tmpdir(), 'multicode-opencode-plugin-'))
    const socketPath = join(workDir, 'agent-state.sock')

    // Rendered exactly the way installAgentStateReporter renders a plugin-file
    // registration. `.mjs` rather than the installed `.js` only because the temp
    // dir has no package.json to declare the module type.
    const template = await readFile(join(process.cwd(), 'resources', 'hooks', 'opencode-agent-state.mjs'), 'utf8')
    const pluginPath = join(workDir, 'multicode-agent-state.mjs')
    const rendered = renderAgentStatePluginTemplate(template, socketPath)
    assert.ok(rendered.includes(JSON.stringify(socketPath)), 'the socket path must be baked into the rendered plugin')
    assert.ok(
      !rendered.includes("'__SPRINTENGINE_AGENT_STATE_SOCKET__'"),
      'the socket token must not survive rendering',
    )
    await writeFile(pluginPath, rendered, 'utf8')
    console.log('ok - the bundled OpenCode template renders with the live socket path baked in')

    const driverPath = join(workDir, 'driver.mjs')
    await writeFile(
      driverPath,
      [
        "import { readFile } from 'node:fs/promises'",
        `import { MulticodeAgentState } from ${JSON.stringify(pluginPath)}`,
        'const spec = JSON.parse(await readFile(process.argv[2], "utf8"))',
        'const hooks = await MulticodeAgentState({ directory: spec.directory })',
        'for (const call of spec.calls) await hooks["tool.execute.after"](call.input, call.output)',
        '',
      ].join('\n'),
      'utf8',
    )

    const frames: string[] = []
    const server: Server = await new Promise((resolve, reject) => {
      const created = createServer((socket) => {
        socket.setEncoding('utf8')
        socket.on('data', (chunk: string) => frames.push(...chunk.split('\n').filter(Boolean)))
      })
      created.on('error', reject)
      created.listen(socketPath, () => resolve(created))
    })

    const drive = (calls: ToolCall[]): Promise<number> =>
      new Promise((resolve, reject) => {
        const specPath = join(workDir, 'spec.json')
        writeFile(specPath, JSON.stringify({ directory: DIRECTORY, calls }), 'utf8')
          .then(() => {
            const child = spawn(process.execPath, [driverPath, specPath], {
              env: {
                ...process.env,
                // Always overridden: when this test runs inside a studio agent
                // session the launch env carries the LIVE app's socket, and
                // inheriting it would send these frames to the real app. Both
                // spellings: the plugin reads SPRINTENGINE_* first.
                ...compatStudioEnvEntry('SPRINTENGINE_AGENT_STATE_SOCKET', socketPath),
                ...compatStudioEnvEntry('SPRINTENGINE_AGENT_ID', 'oc-agent'),
                ...compatStudioEnvEntry('SPRINTENGINE_WORKSPACE_ID', 'oc-ws'),
              },
              stdio: ['ignore', 'inherit', 'inherit'],
            })
            child.on('error', reject)
            child.on('close', (code) => resolve(code ?? 0))
          })
          .catch(reject)
      })

    // One driver run for the whole battery: the plugin's own dedup suppresses a
    // repeated event NAME, and the fact that every file-change frame below still
    // arrives is itself the proof that a frame carrying a ledger entry is exempt
    // from it (two edits in a row share `tool.execute.after`).
    const calls: ToolCall[] = [
      // 0. A tool that writes nothing. First, so the dedup has not yet latched:
      //    it must still report the PHASE, and must claim no file.
      {
        input: { tool: 'read', sessionID: 'ses_opencode_1', callID: 'c0', args: { filePath: SAMPLE } },
        output: { title: 'sample.txt', output: '…', metadata: { preview: 'line 1' } },
      },
      // 1. edit, with context lines on both sides of a one-line replacement.
      editCall(EDIT_PATCH, 1, 1),
      // 2. edit, a pure deletion.
      editCall(DELETE_PATCH, 0, 2),
      // 3. write that CREATED the file — no diff anywhere in the payload.
      {
        input: {
          tool: 'write',
          sessionID: 'ses_opencode_1',
          callID: 'c3',
          args: { filePath: FRESH, content: 'alpha\nbeta\ngamma\n' },
        },
        output: {
          title: 'fresh.txt',
          output: 'Wrote file successfully.',
          metadata: { diagnostics: {}, filepath: FRESH, exists: false, truncated: false },
        },
      },
      // 4. write that OVERWROTE an existing file: nothing in the payload says
      //    what changed, so the claim is the file and no line of it.
      {
        input: {
          tool: 'write',
          sessionID: 'ses_opencode_1',
          callID: 'c4',
          args: { filePath: SAMPLE, content: 'whatever\n' },
        },
        output: {
          title: 'sample.txt',
          output: 'Wrote file successfully.',
          metadata: { filepath: SAMPLE, exists: true },
        },
      },
      // 5. The same edit delivered with CRLF line separators.
      editCall(EDIT_PATCH.split('\n').join('\r\n'), 1, 1),
      // 6. Malformed metadata — `filediff` is a string, not an object. The tool's
      //    own input still names the file, so the file is still claimed.
      {
        input: { tool: 'edit', sessionID: 'ses_opencode_1', callID: 'c6', args: { filePath: SAMPLE } },
        output: {
          title: 'sample.txt',
          output: 'Edit applied successfully.',
          metadata: { filediff: 'nonsense', diff: 42 },
        },
      },
      // 7. A relative `filediff.file`, resolved against the session directory.
      editCall(EDIT_PATCH, 1, 1, 'sample.txt'),
      // 8. A binary file: git's stub carries no hunk, so there is nothing to walk
      //    and the counts are the ones the tool reported.
      {
        input: { tool: 'edit', sessionID: 'ses_opencode_1', callID: 'c8', args: { filePath: '/repo/work/logo.png' } },
        output: {
          metadata: {
            filediff: {
              file: '/repo/work/logo.png',
              patch:
                'Index: logo.png\n===================================================================\nBinary files logo.png and logo.png differ\n',
            },
          },
        },
      },
      // 9. apply_patch across two files, one of them created — ONE FRAME PER FILE.
      {
        input: { tool: 'apply_patch', sessionID: 'ses_opencode_1', callID: 'c9', args: { patchText: '…' } },
        output: {
          title: 'Success. Updated the following files:',
          output: '…',
          metadata: {
            diff: 'ignored — the per-file patches are what is read',
            files: [
              {
                filePath: SAMPLE,
                relativePath: 'sample.txt',
                type: 'update',
                // No `additions`/`deletions` at all: the counts come from the walk.
                patch: DELETE_PATCH,
              },
              {
                filePath: '/repo/work/two.txt',
                relativePath: 'two.txt',
                type: 'add',
                patch: '--- /repo/work/two.txt\n+++ /repo/work/two.txt\n@@ -0,0 +1,2 @@\n+two\n+three\n',
                additions: 2,
                deletions: 0,
              },
            ],
          },
        },
      },
      // 10. Nothing readable at all — no metadata, no args. Last, so the absence
      //     of a further frame is what proves it claimed nothing.
      { input: { tool: 'edit', sessionID: 'ses_opencode_1', callID: 'c10' }, output: null },
      // 11. Total garbage in both positions: must not throw into OpenCode.
      { input: null, output: 'a string where the result object should be' },
      // === Pull request capture (epic `pull-request-marks`, decision 8b) =====
      // 12. `gh pr view` prints a pull request URL and opens nothing. It emits no
      //     frame at all (the dedup eats a `tool.execute.after` that carries
      //     neither a file change nor a capture), which is the point.
      {
        input: {
          tool: 'bash',
          sessionID: 'ses_opencode_1',
          callID: 'c12',
          args: { command: 'gh pr view 12 --json url' },
        },
        output: { title: 'gh pr view', output: '{"url":"https://github.com/acme/app/pull/12"}', metadata: { exit: 0 } },
      },
      // 13. The creation itself: `gh` prints the URL on the LAST line of output.
      {
        input: {
          tool: 'bash',
          sessionID: 'ses_opencode_1',
          callID: 'c13',
          args: { command: 'cd ../website && gh pr create --fill', description: 'Open the pull request' },
        },
        output: {
          title: 'gh pr create',
          output: 'remote: Resolving deltas: 100% (12/12)\nhttps://github.com/acme/website/pull/9/files?w=1\n',
          metadata: { exit: 0 },
        },
      },
      // 14. A creation that FAILED with no URL anywhere: nothing to capture, and
      //     the dedup then eats the frame — so the count below is what proves it.
      {
        input: { tool: 'bash', sessionID: 'ses_opencode_1', callID: 'c14', args: { command: 'gh pr create --fill' } },
        output: {
          title: 'gh pr create',
          output: 'pull request create failed: No commits between main and feature',
          metadata: { exit: 1 },
        },
      },
    ]

    const exitCode = await drive(calls)
    assert.equal(exitCode, 0, 'the plugin must never throw into OpenCode, whatever the payload')
    console.log('ok - the plugin survives a null input, a string result and unreadable metadata without throwing')

    // Every frame main will ever see, through main's own parser.
    const parsed = frames.map((line) => {
      const frame = parseAgentStateFrame(JSON.parse(line) as unknown, Date.now() + 60_000)
      assert.ok(frame, `main rejected a frame the plugin sent: ${line}`)
      return frame as AgentStateFrame
    })
    for (const frame of parsed) {
      assert.equal(frame.event, 'tool.execute.after')
      assert.equal(frame.phase, 'thinking')
      assert.equal(frame.agentId, 'oc-agent')
      assert.equal(frame.sessionId, 'ses_opencode_1', 'the first session id seen is locked onto every frame')
      assert.equal(frame.cwd, DIRECTORY, "the plugin context's directory rides every frame")
    }
    console.log('ok - every emitted frame parses as an agent-state frame main accepts')

    // OpenCode's own id for the tool call rides every frame as `toolUseId` — the
    // key main's duplicate guard uses to tell a second REGISTRATION of a reporter
    // apart from a second edit. Asserted here in the same shape main reads it,
    // through main's own parser.
    assert.deepEqual(
      parsed.map((frame) => frame.toolUseId),
      // c0 read nothing but still carries its id; the three `editCall` helpers
      // share one canned callID; c9's apply_patch rewrote TWO files and so sent
      // TWO frames under ONE id — which is exactly the case main's ring keys on
      // (id, path) to survive. The calls with no frame here (c10 onward, bar the
      // capture) were eaten by the plugin's own repeated-event dedup, not by this.
      ['c0', 'call_1', 'call_1', 'c3', 'c4', 'call_1', 'c6', 'call_1', 'c8', 'c9', 'c9', 'c13'],
      'every frame carries the callID of the tool call that produced it',
    )
    assert.equal(parsed[0].toolUseId, 'c0', 'a frame that claims no file carries the id too')
    assert.equal(
      parsed[9].toolUseId,
      parsed[10].toolUseId,
      'a multi-file apply_patch sends one frame per file under a single call id — the PATH is what separates them',
    )
    console.log('ok - OpenCode`s callID rides every frame as toolUseId, one id across a multi-file patch')
    console.log('ok - OpenCode`s callID rides every frame as toolUseId, one id across a multi-file patch')

    const changes = parsed.map((frame) => frame.fileChange)
    assert.equal(changes[0], undefined, 'a tool that writes nothing claims no file')
    console.log('ok - a non-writing tool reports the phase and claims no file')

    // The line RANGES are the CHANGED lines, never the hunk bounds: `@@ -3,9 +3,9
    // @@` spans nine lines, of which the agent wrote exactly one.
    assert.deepEqual(
      changes[1],
      { path: SAMPLE, additions: 1, deletions: 1, edits: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 1 }] },
      'context advances both cursors and never enters an edit',
    )
    console.log('ok - edit: a one-line change inside four lines of context claims one line')

    // A zero-length side is an ANCHOR: the two removed lines are old 12-13, and
    // the new side is "after new line 11".
    assert.deepEqual(
      changes[2],
      { path: SAMPLE, additions: 0, deletions: 2, edits: [{ oldStart: 12, oldLines: 2, newStart: 11, newLines: 0 }] },
      'a pure deletion anchors its empty new side after the preceding line',
    )
    console.log('ok - edit: a pure deletion reports -12,2 +11,0 in git hunk convention')

    // A created file: git spells a whole-file creation `@@ -0,0 +1,N @@`, and a
    // trailing newline does not make a last empty line.
    assert.deepEqual(
      changes[3],
      { path: FRESH, additions: 3, deletions: 0, edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }] },
      'a write with exists:false is counted from the content it was given',
    )
    console.log('ok - write: a created file is one -0,0 +1,N region counted from args.content')

    assert.deepEqual(
      changes[4],
      { path: SAMPLE, additions: 0, deletions: 0 },
      'an overwrite has no diff in the payload, so it claims the file and no line of it',
    )
    console.log('ok - write: an overwrite degrades to a file-level claim rather than a guessed count')

    assert.deepEqual(changes[5], changes[1], 'a CRLF-separated patch reads exactly like an LF one')
    console.log('ok - a patch delivered with CRLF separators produces identical edits')

    assert.deepEqual(
      changes[6],
      { path: SAMPLE, additions: 0, deletions: 0 },
      'unreadable metadata falls back to the path the tool was given',
    )
    console.log('ok - malformed metadata degrades to a path-only claim instead of dropping the file')

    assert.deepEqual(changes[7], changes[1], 'a relative filediff.file resolves against the session directory')
    console.log('ok - a relative filediff.file is resolved absolute against the plugin context directory')

    assert.deepEqual(
      changes[8],
      { path: '/repo/work/logo.png', additions: 0, deletions: 0 },
      'a binary stub has no hunk to walk and no counts to read',
    )
    console.log('ok - a binary-file diff claims the file with no invented line ranges')

    assert.deepEqual(
      changes[9],
      { path: SAMPLE, additions: 0, deletions: 2, edits: [{ oldStart: 12, oldLines: 2, newStart: 11, newLines: 0 }] },
      'missing additions/deletions are walked out of the patch itself',
    )
    assert.deepEqual(
      changes[10],
      {
        path: '/repo/work/two.txt',
        additions: 2,
        deletions: 0,
        edits: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 }],
      },
      'a file created inside a patch is the whole-file `-0,0 +1,N` region',
    )
    console.log(
      'ok - apply_patch sends one frame per file, counting from the per-file patch when the tool omits the numbers',
    )

    assert.equal(changes.length, 12, 'a payload naming no file at all claims nothing and adds no frame')
    console.log('ok - a payload with no path anywhere adds no ledger entry')

    // The pull request capture: the bash tool's own output, read the same way the
    // command-hook reporter reads a `gh pr create` result. Twelve frames in total
    // — the eleven above plus ONE for the creation — so the two bash calls that
    // opened nothing are proved to have captured nothing by their absence: a
    // `tool.execute.after` carrying neither a file change nor a capture is eaten
    // by the plugin's own dedup, and a capture is exempt from it precisely so the
    // one frame that matters cannot be dropped.
    const captures = parsed.map((frame) => frame.pullRequest)
    assert.deepEqual(
      captures.filter(Boolean),
      [{ url: 'https://github.com/acme/website/pull/9' }],
      'exactly one call opened a pull request, and the capture stops at its number — a tab and a query are not part of it',
    )
    assert.deepEqual(
      captures.slice(0, 11),
      new Array(11).fill(undefined),
      'every frame before it carries no capture: editing a file opens no pull request',
    )
    assert.deepEqual(
      captures[11],
      { url: 'https://github.com/acme/website/pull/9' },
      'the capture rides the frame of the call that made it',
    )
    assert.equal(parsed.length, 12, 'a bash call that captured nothing and edited nothing adds no frame')
    console.log('ok - `gh pr create` captures its URL, while `gh pr view` and a failed creation capture nothing')

    // The patch text and the file content are not ours to forward: the frame line
    // cap is 64KB, and a person's source is not a line range.
    const wire = frames.join('\n')
    for (const secret of ['line 7', 'row 7', 'alpha', '@@', 'Index:', 'Resolving deltas', 'gh pr create']) {
      assert.equal(wire.includes(secret), false, `the frame must never carry patch or file content (${secret})`)
    }
    console.log('ok - no patch text or file content ever rides the socket')

    server.close()
    console.log('opencode-agent-state.test.ts: all assertions passed')
  }

  const suiteRun = run().catch((error) => {
    console.error(error)
    process.exit(1)
  })

  await suiteRun
})

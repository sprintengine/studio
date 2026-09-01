// Manual end-to-end harness (not part of verify:app): drives the REAL
// ConversationRuntime + claude-agent provider + installed Claude CLI on
// subscription auth through a full turn, then a second runtime instance to
// prove restart-resume via the JSONL cursor. Run with:
//   npx esbuild src/main/providers/claude-agent-e2e.harness.ts --bundle \
//     --platform=node --format=cjs --packages=external \
//     --outfile=node_modules/.cache/multicode/claude-agent-e2e.cjs \
//   && node node_modules/.cache/multicode/claude-agent-e2e.cjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRuntime } from '../conversation-runtime';
import { createClaudeAgentProvider, stripAnthropicAuthEnv } from './claude-agent-provider';
// Electron-free seams: env passthrough + login-shell PATH resolution stand in
// for getTerminalEnv/detectCli (which pull Electron into the bundle). Auth env
// goes through the same strip production `defaultBuildEnv` applies, so the
// harness proves the subscription-auth guarantee against the real CLI.
function createProvider() {
    return createClaudeAgentProvider({
        resolveExecutable: async () => execSync('bash -lc "command -v claude"').toString().trim(),
        buildEnv: (input) => {
            const passthrough = {};
            for (const [key, value] of Object.entries(process.env)) {
                if (typeof value === 'string' && key !== 'ELECTRON_RUN_AS_NODE')
                    passthrough[key] = value;
            }
            const env = stripAnthropicAuthEnv(passthrough);
            env.MULTICODE_CONVERSATION_SESSION_ID = input.sessionId;
            return env;
        },
    });
}
function createRuntime() {
    return new ConversationRuntime({
        getProviderById: () => undefined,
        secretStore: { getStatus: async () => ({ ok: false, message: 'no secrets in harness' }) },
        adapters: [createProvider()],
    });
}
async function main() {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'mc-claude-e2e-'));
    try {
        // ── Session 1: full streamed turn ────────────────────────────────────
        const runtime = createRuntime();
        const eventTypes = [];
        let streamedText = '';
        let apiKeySource = null;
        runtime.onEvent((event) => {
            eventTypes.push(event.type);
            if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
                streamedText += event.payload.text;
            }
            if (event.type === 'session_updated' && typeof event.payload?.apiKeySource === 'string') {
                apiKeySource = event.payload.apiKeySource;
            }
        });
        const started = await runtime.startSession({
            workspaceRoot,
            workspaceId: 'harness-ws',
            agentId: 'harness-agent',
            providerId: 'claude-agent',
            modelId: 'haiku',
        });
        assert.equal(started.ok, true, 'start session');
        if (!started.ok)
            return;
        const sent = await runtime.sendTurn({
            sessionId: started.session.sessionId,
            message: 'Remember the codeword LANTERN-9. Reply with exactly: stored',
        });
        assert.equal(sent.ok, true, 'send turn');
        if (!sent.ok)
            return;
        assert.equal(sent.session.status, 'ready', 'turn completed cleanly');
        assert.equal(eventTypes.includes('content_delta'), true, 'streamed deltas');
        assert.equal(eventTypes.includes('usage_updated'), true, 'usage reported');
        assert.equal(eventTypes.includes('turn_completed'), true, 'turn completed');
        assert.equal(eventTypes.includes('session_updated'), true, 'resume cursor recorded');
        assert.equal(apiKeySource, 'none', 'CLI bound subscription auth, not an API key');
        assert.match(streamedText, /stored/i);
        console.log('session 1 OK:', JSON.stringify(streamedText.trim()));
        // Live inventory + disposal-by-stop (quit parity).
        const roots = runtime.listLiveConversationRoots();
        assert.equal(roots.length, 1, 'live child inventoried');
        assert.equal(typeof roots[0]?.rootPid, 'number');
        console.log('live child pid:', roots[0]?.rootPid);
        await runtime.shutdown();
        assert.equal(runtime.listLiveConversationRoots().length, 0, 'shutdown disposed the child');
        const orphans = execSync(`ps ax -o pid=,command= | grep -F 'MULTICODE_CONVERSATION_SESSION_ID' | grep -v grep || true`).toString().trim();
        assert.equal(orphans, '', 'no orphaned claude children after shutdown');
        // ── Session 2 (fresh runtime = app restart): native resume ───────────
        const runtime2 = createRuntime();
        let recallText = '';
        runtime2.onEvent((event) => {
            if (event.type === 'content_delta' && typeof event.payload?.text === 'string') {
                recallText += event.payload.text;
            }
        });
        const restarted = await runtime2.startSession({
            workspaceRoot,
            workspaceId: 'harness-ws',
            agentId: 'harness-agent',
            providerId: 'claude-agent',
            modelId: 'haiku',
        });
        assert.equal(restarted.ok, true, 'restart session');
        if (!restarted.ok)
            return;
        const recalled = await runtime2.sendTurn({
            sessionId: restarted.session.sessionId,
            message: 'What is the codeword? Reply with only the codeword.',
        });
        assert.equal(recalled.ok, true, 'resume turn');
        assert.match(recallText, /LANTERN-9/, 'resumed session recalled prior context');
        console.log('session 2 OK (resumed):', JSON.stringify(recallText.trim()));
        // Transcript replay reads back the full conversation.
        const transcript = await runtime2.readTranscript({
            workspaceRoot,
            workspaceId: 'harness-ws',
            agentId: 'harness-agent',
        });
        assert.equal(transcript.ok, true);
        if (transcript.ok) {
            assert.equal(transcript.events.filter((event) => event.type === 'user_message').length, 2);
            assert.equal(transcript.events.some((event) => event.type === 'session_updated'), true);
        }
        await runtime2.shutdown();
        console.log('CLAUDE-AGENT E2E HARNESS OK');
    }
    finally {
        await rm(workspaceRoot, { recursive: true, force: true });
    }
}
main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});

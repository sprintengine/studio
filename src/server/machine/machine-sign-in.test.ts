import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, test, vi } from 'vitest'

import { createSignIns, readSignInOutput, resolveOnPath } from './machine-sign-in'

// CLI sign-ins on a server's machine with no terminal (decision R34), with
// stand-ins that print what each CLI printed when it ran with no terminal
// (codex's device code, cursor-agent's link, claude's link and paste prompt).

let dir = ''
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'se-sign-in-'))
  const script = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(dir, name), 0o755)
  }
  script(
    'codex',
    `printf 'Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-EFGHI\\033[0m\\n'\nsleep 0.5\nexit 0`,
  )
  script(
    'claude',
    `printf 'If the browser did not open, visit: \\033]8;;https://claude.com/cai/oauth/authorize?code=true&state=x\\007https://claude.com/cai/oauth/authorize?code=true&state=x\\033]8;;\\007\\nPaste code here if prompted > '\nread code\n[ "$code" = "the-code" ] && exit 0\necho "wrong code: $code"\nexit 1`,
  )
  script(
    'cursor-agent',
    `echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=c"\nsleep 30`,
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const resolve = async (binary: string) => join(dir, binary)

test("each CLI's output is read for its link, its code and its paste prompt", () => {
  assert.deepEqual(
    readSignInOutput(
      'visit \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n code \u001b[94mABCD-EFGHI\u001b[0m',
    ),
    {
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-EFGHI',
      paste: false,
    },
  )
  assert.equal(readSignInOutput('Paste code here if prompted >').paste, true)
  assert.equal(readSignInOutput('nothing yet').url, null)
})

test('a device code: the link and the code, and it finishes on its own', async () => {
  const signIns = createSignIns({ resolve })
  const started = await signIns.start('codex')
  assert.ok(started.ok)
  if (!started.ok) return
  assert.equal(started.url, 'https://auth.openai.com/codex/device')
  assert.equal(started.code, 'ABCD-EFGHI')
  assert.equal(started.paste, false)
  assert.deepEqual(await signIns.wait(started.id), { ok: true })
})

test('a paste-back: the code typed in the dialog goes to the login, which finishes', async () => {
  const signIns = createSignIns({ resolve })
  const started = await signIns.start('claude-code')
  assert.ok(started.ok && started.paste)
  if (!started.ok) return
  assert.match(started.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize/u)
  assert.deepEqual(signIns.paste(started.id, 'the-code'), { ok: true })
  assert.deepEqual(await signIns.wait(started.id), { ok: true })
  const again = await signIns.start('claude-code')
  if (!again.ok) return
  signIns.paste(again.id, 'not-it')
  const failed = await signIns.wait(again.id)
  assert.equal(failed.ok, false)
  assert.match(failed.ok ? '' : failed.message, /claude did not sign in: .*wrong code: not-it/u)
})

test('a browser link that is cancelled; a CLI that is missing; a CLI with no flow', async () => {
  const signIns = createSignIns({ resolve })
  const started = await signIns.start('cursor')
  assert.ok(started.ok)
  if (!started.ok) return
  signIns.cancel(started.id)
  assert.equal((await signIns.wait(started.id)).ok, false)
  const missing = await createSignIns({ resolve: async () => null }).start('codex')
  assert.deepEqual(missing, { ok: false, message: 'codex is not installed on this machine.' })
  assert.equal((await signIns.start('opencode')).ok, false)
  assert.equal(await resolveOnPath('sh'), (await resolveOnPath('sh')) ?? null)
  assert.equal(await resolveOnPath('no-such-cli-here'), null)
  assert.equal(await resolveOnPath('a;b'), null)
})

test.skipIf(process.platform === 'win32')(
  'a login that ignores being asked to end, and what it started, are gone once it is cancelled or its server stops',
  async () => {
    // A stand-in that shrugs off SIGTERM and leaves a helper of its own running.
    const stubborn = (name: string) => {
      writeFileSync(
        join(dir, name),
        `#!/bin/sh\ntrap '' TERM\nsleep 60 &\necho $! > '${join(dir, `${name}.helper`)}'\necho "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=c"\nwhile :; do sleep 1; done\n`,
      )
      chmodSync(join(dir, name), 0o755)
    }
    stubborn('stubborn-cancel')
    stubborn('stubborn-stop')
    for (const [binary, finish] of [
      ['stubborn-cancel', (signIns: ReturnType<typeof createSignIns>, id: string) => signIns.cancel(id)],
      ['stubborn-stop', (signIns: ReturnType<typeof createSignIns>) => signIns.stopAll()],
    ] as const) {
      const signIns = createSignIns({ resolve: async () => join(dir, binary), killGraceMs: 200 })
      const started = await signIns.start('cursor')
      assert.ok(started.ok)
      if (!started.ok) return
      const helper = Number(readFileSync(join(dir, `${binary}.helper`), 'utf8'))
      assert.ok(alive(helper))
      finish(signIns, started.id)
      assert.equal((await signIns.wait(started.id)).ok, false)
      await vi.waitFor(() => assert.equal(alive(helper), false, `${binary}'s helper is gone`), { timeout: 5_000 })
    }
  },
)

// Start a chat in a workspace and follow its first turn, answering what it asks.
//
// Pair the script once: Studio → Settings → Agents → Local apps → Pair an app,
// with "Read chats", "Drive chats" and "Start chats". Then:
//
//   STUDIO_PAIRING_CODE=sepair_… node start-and-follow.mjs <workspace id> "Summarise the README"
//
// The code is exchanged for a token the first time and kept, 0600, in the
// token file below; later runs need no code.
import { homedir } from 'node:os'
import { join } from 'node:path'

import { approvalRequestOf } from '@sprintengine/agent-sdk'
import { connectToStudio } from '@sprintengine/agent-sdk/node'

const [workspaceId, prompt = 'Say hello, and name the files in this folder.'] = process.argv.slice(2)
if (!workspaceId) {
  console.error('usage: node start-and-follow.mjs <workspace id> [prompt]')
  process.exit(2)
}

const studio = await connectToStudio({
  name: 'start-and-follow',
  tokenFile: join(homedir(), '.config', 'sprintengine-agent-sdk', 'start-and-follow.token'),
  pairingCode: process.env.STUDIO_PAIRING_CODE,
})

// Manual asks before every edit and command; this script says no to all of them.
const chat = await studio.createConversation({ workspaceId, prompt, permissionPreset: 'manual' })
console.log(`Started "${chat.info.name}" on ${chat.info.cli}.`)

for await (const frame of chat.events()) {
  if (frame.type !== 'event') continue
  const { event } = frame
  if (event.type === 'content_delta') process.stdout.write(String(event.payload?.text ?? ''))
  const asked = approvalRequestOf(event)
  if (asked?.kind === 'tool') {
    console.log(`\n[declined: ${asked.summary ?? asked.action ?? 'a tool call'}]`)
    await chat.respondToApproval({ requestId: asked.requestId, decision: 'deny' })
  } else if (asked?.kind === 'question') {
    // The first option of every question.
    const answers = Object.fromEntries(
      asked.questions.map((question) => [question.question, question.options[0]?.label ?? '']),
    )
    await chat.answerQuestion({ requestId: asked.requestId, answers })
  } else if (asked?.kind === 'plan') {
    await chat.resolvePlan({ requestId: asked.requestId, decision: 'reject' })
  }
  if (event.type === 'turn_completed' || event.type === 'turn_failed') break
}

console.log()
studio.close()

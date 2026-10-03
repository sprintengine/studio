// Give Studio's agents tools that run in this program, then start a chat that
// uses them.
//
// Pair the script once: Studio → Settings → Agents → Local apps → Pair an app,
// with "Start chats" and "Give agents tools from this app". Then:
//
//   STUDIO_PAIRING_CODE=sepair_… node offer-tools.mjs <workspace id>
//
// The tools reach the chats this app starts (and any chat the person opens to
// it from the chat tab's menu). Every call still asks as the chat's own
// permissions say.
import { homedir } from 'node:os'
import { join } from 'node:path'

import { StudioToolError, toolResult } from '@sprintengine/agent-sdk'
import { connectToStudio } from '@sprintengine/agent-sdk/node'

const [workspaceId] = process.argv.slice(2)
if (!workspaceId) {
  console.error('usage: node offer-tools.mjs <workspace id>')
  process.exit(2)
}

const studio = await connectToStudio({
  name: 'Dice',
  tokenFile: join(homedir(), '.config', 'sprintengine-agent-sdk', 'offer-tools.token'),
  pairingCode: process.env.STUDIO_PAIRING_CODE,
})

const rolls = []
const dice = await studio.tools.offer({
  name: 'dice',
  title: 'Dice',
  description: 'Rolls dice in the Dice script running on this machine.',
  tools: [
    {
      name: 'roll',
      description: 'Roll `count` dice with `sides` sides each. Answers the faces and their total.',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'integer', minimum: 1, maximum: 20 },
          sides: { type: 'integer', minimum: 2, maximum: 100 },
        },
        required: ['count', 'sides'],
        additionalProperties: false,
      },
      timeoutMs: 5_000,
      handler({ count, sides }, call) {
        if (call.signal.aborted) throw new StudioToolError('cancelled', 'The roll was cancelled.')
        const faces = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
        rolls.push(faces)
        return toolResult.text(`Rolled ${faces.join(', ')}.`, { faces, total: faces.reduce((a, b) => a + b, 0) })
      },
    },
    {
      name: 'history',
      description: 'Every roll made so far, oldest first.',
      inputSchema: { type: 'object', properties: {} },
      mutates: false,
      handler: () => toolResult.text(JSON.stringify(rolls), { rolls }),
    },
  ],
})
console.log(`Offered ${dice.wireNames.join(', ')}.`)

const chat = await studio.createConversation({
  workspaceId,
  prompt: 'Roll three six-sided dice with the dice tools, then tell me the total.',
  permissionPreset: 'auto',
})
console.log(`Started "${chat.info.name}". Watch it in Studio; press Ctrl+C to stop.`)

process.on('SIGINT', async () => {
  await dice.withdraw()
  studio.close()
  process.exit(0)
})

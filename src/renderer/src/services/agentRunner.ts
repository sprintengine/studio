import Anthropic from '@anthropic-ai/sdk'
import type { AgentConfig, AgentMessage } from '../types/workspace'

export type StreamCallbacks = {
  onChunk: (text: string) => void
  onDone: () => void
  onError: (err: Error) => void
}

// Each agent gets an AbortController so its stream can be cancelled independently.
const controllers = new Map<string, AbortController>()

export function cancelAgent(agentId: string): void {
  controllers.get(agentId)?.abort()
  controllers.delete(agentId)
}

export async function runAgent(
  agentId: string,
  apiKey: string,
  config: AgentConfig,
  history: AgentMessage[],
  userMessage: string,
  callbacks: StreamCallbacks
): Promise<void> {
  cancelAgent(agentId)
  const controller = new AbortController()
  controllers.set(agentId, controller)

  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true })

  const messages: Anthropic.MessageParam[] = [
    ...history
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    { role: 'user', content: userMessage },
  ]

  try {
    const stream = await client.messages.stream(
      {
        model: config.model,
        max_tokens: config.maxTokens,
        system: config.systemPrompt,
        messages,
      },
      { signal: controller.signal }
    )

    for await (const event of stream) {
      if (controller.signal.aborted) break
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        callbacks.onChunk(event.delta.text)
      }
    }

    if (!controller.signal.aborted) {
      callbacks.onDone()
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    callbacks.onError(err instanceof Error ? err : new Error(String(err)))
  } finally {
    controllers.delete(agentId)
  }
}

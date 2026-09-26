import type { ConversationTurnDiffInput, ConversationKey } from '../../../../shared/conversation-runtime'
import { readAuxWindowBounds } from './auxWindowPlacement'

export type ToolDiffWindowInput = { key: ConversationKey; toolUseId: string; editIndex: number; path: string }
export async function openCheckpointDiffWindow(input: ConversationTurnDiffInput | ToolDiffWindowInput): Promise<void> {
  await window.api.openAuxWindow({
    kind: 'diff',
    singletonKey: 'conversation-diff',
    params: { checkpoint: JSON.stringify(input) },
    bounds: readAuxWindowBounds('diff'),
  })
}

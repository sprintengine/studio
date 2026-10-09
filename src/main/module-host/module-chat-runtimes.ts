// The chat runtimes a module's main half can start a chat on
// (`MainHost.listChatRuntimes`): the same rows the renderer's
// `listChatRuntimes` gives a module's window half, built in main from the same
// sources the shell's chat picker reads — the plugin registry, this machine's
// CLI availability, the model catalog a chat's picker offers (manifest seed,
// discovered models, the ids the person added) and the CLI the person last
// chose. One id space: a row's `id` is what a conversation's `cli`, a
// scheduled agent's `cli` and a companion's `engine.cli` take.
//
// Unlike the window's list, a runtime this machine does not have is listed
// too, `available: false`, so a module's settings can say why a choice is not
// offered rather than leave it out.

import { conversationProviderForCli } from '../../shared/conversation-harness'
import type { ModuleChatRuntimeOption } from '../../shared/modules/conversation-service'

export type ChatRuntimeListerDeps = {
  /** The registered agent CLIs, in the order the pickers list them. */
  listClis: () => ReadonlyArray<{ id: string; displayName: string }>
  /** Whether each CLI is installed; a CLI the probe could not answer for is absent. */
  availability: () => Promise<Record<string, { installed: boolean } | undefined>>
  /** The models a chat on the provider can run, as its picker lists them; null for none. */
  modelCatalog: (providerId: string) => Promise<{ options: ReadonlyArray<{ id: string; label?: string }> } | null>
  /** The CLI the person last chose. */
  lastSelectedCli: () => string | null | undefined
}

export function createChatRuntimeLister(deps: ChatRuntimeListerDeps): () => Promise<ModuleChatRuntimeOption[]> {
  return async () => {
    const availability = await deps.availability().catch(() => ({}) as Record<string, undefined>)
    const lastSelected = deps.lastSelectedCli() ?? null
    const rows: ModuleChatRuntimeOption[] = []
    for (const cli of deps.listClis()) {
      const providerId = conversationProviderForCli(cli.id)
      if (!providerId) continue
      const catalog = await deps.modelCatalog(providerId).catch(() => null)
      rows.push({
        id: cli.id,
        label: cli.displayName,
        // Installed unless the probe said otherwise, as the window's list reads it.
        available: availability[cli.id]?.installed !== false,
        models: (catalog?.options ?? []).map((model) => ({ id: model.id, label: model.label ?? model.id })),
        lastSelected: cli.id === lastSelected,
      })
    }
    return rows
  }
}

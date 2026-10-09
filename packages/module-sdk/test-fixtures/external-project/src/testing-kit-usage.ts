// A module's own test, compiled against the packed tarball only: the fake
// hosts and the pass-through kit, typed as an author writes against them.

import { createElement } from 'react'

import {
  getConversationService,
  getModuleStorage,
  type RegisterMain,
  type RegisterRenderer,
} from '@sprintengine/module-sdk'
import {
  createFakeMainHost,
  createFakeRendererHost,
  installTestingKit,
  renderToHtml,
  type FakeMainHost,
  type FakeRendererHost,
} from '@sprintengine/module-sdk/testing'
import { EmptyState, GlobalSurfaceShell } from '@sprintengine/module-sdk/testing/kit'

export async function exerciseModule(registerMain: RegisterMain, registerRenderer: RegisterRenderer): Promise<string> {
  installTestingKit()
  const main: FakeMainHost = createFakeMainHost({
    moduleId: 'tide-tables',
    permissions: ['storage', 'conversation:operate', 'module:bridge'],
    storage: { global: { 'last-port': 'Galway' } },
  })
  await registerMain(main.host)
  await main.startup()
  const stored = await getModuleStorage(main.host).get({ key: 'last-port' })
  const created = await getConversationService(main.host).create({ workspaceId: 'ws-app', prompt: 'Tides?' })
  if (created.ok) {
    main.services.conversations.emitEvent(created.conversation, { type: 'turn_completed' })
  }

  const renderer: FakeRendererHost = createFakeRendererHost({ main })
  await registerRenderer(renderer.host)
  const door = renderer.registrations.globalSurfaces[0]
  const html = door ? await renderer.render.surface(door.id) : ''
  const kitHtml = await renderToHtml(
    createElement(GlobalSurfaceShell, {
      ariaLabel: 'Tides',
      children: createElement(EmptyState, { title: 'No tides' }),
    }),
  )
  return `${String(stored.ok)}${html}${kitHtml}${main.undeclared.length}${renderer.undeclared.length}`
}

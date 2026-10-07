// @vitest-environment jsdom
import assert from 'node:assert/strict'
import React, { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, test } from 'vitest'

import type { ProjectRepositories } from '../../../../../shared/project-repositories'
import { clearProjectRepositoriesAnswers } from '../../../hooks/useProjectRepositories'
import { clearChosenProjectRepositories, ProjectRepositoriesGitPanel, type GitPanelTarget } from './ProjectRepositories'

const ACME = '/Users/dev/acme'
const acme: ProjectRepositories = {
  root: ACME,
  source: { kind: 'children' },
  repositories: [
    { path: `${ACME}/api`, relativePath: 'api', name: 'api' },
    { path: `${ACME}/web`, relativePath: 'web', name: 'web' },
  ],
  truncated: false,
}

let container: HTMLDivElement
let root: Root
let answers: Record<string, ProjectRepositories | null>
let asks: Array<{ folderPath: string; refresh: boolean }>
let targets: GitPanelTarget[]
let mounts: string[]

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom lays nothing out; the list scrolls its active option into view.
  HTMLElement.prototype.scrollIntoView = function scrollIntoView(): void {}
  clearProjectRepositoriesAnswers()
  clearChosenProjectRepositories()
  answers = { [ACME]: acme, '/Users/dev/app': null }
  asks = []
  targets = []
  mounts = []
  ;(window as unknown as { api: unknown }).api = {
    getProjectRepositories: async (folderPath: string, options?: { refresh?: boolean }) => {
      asks.push({ folderPath, refresh: options?.refresh === true })
      return answers[folderPath] ?? null
    },
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

/** Stands in for the panel body: says what it was opened on, and when it mounted. */
function Body(target: GitPanelTarget) {
  targets.push(target)
  const opened = target.repository ?? '(workspace folder)'
  useEffect(() => {
    mounts.push(opened)
  }, [opened])
  return (
    <div data-body={target.repository ?? ''} data-resolving={String(target.projectResolving === true)}>
      {target.switcher}
    </div>
  )
}

async function render(workspaceId: string, folderPath: string | null): Promise<void> {
  await act(async () => {
    root.render(
      <ProjectRepositoriesGitPanel
        workspaceId={workspaceId}
        folderPath={folderPath}
        renderBody={(target) => <Body {...target} />}
      />,
    )
  })
  // The hook's ask resolves after the first render.
  await act(async () => {})
}

async function pick(label: string): Promise<void> {
  const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Repository"]')
  assert.ok(trigger, 'the Repository row is drawn')
  await act(async () => trigger.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (candidate) => candidate.textContent?.trim() === label,
  )
  assert.ok(option, `the list offers ${label}`)
  await act(async () => {
    option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    option.click()
  })
}

test('a folder of several repositories opens on its first member, under a Repository row', async () => {
  await render('ws-acme', ACME)
  const body = container.querySelector('[data-body]')
  assert.equal(body?.getAttribute('data-body'), `${ACME}/api`)
  const last = targets.at(-1)!
  assert.equal(last.repository, `${ACME}/api`)
  assert.equal(last.draftPrefix, 'repository:api:', 'drafts are kept per member')
  assert.equal(
    container.querySelector('[role="combobox"][aria-label="Repository"]')?.textContent?.includes('api'),
    true,
  )
})

test('picking another member reopens the panel on it, and the pick is remembered for the workspace', async () => {
  await render('ws-acme', ACME)
  await pick('web')
  assert.equal(container.querySelector('[data-body]')?.getAttribute('data-body'), `${ACME}/web`)
  assert.equal(targets.at(-1)?.draftPrefix, 'repository:web:')
  // Remounted, not re-rendered: nothing of api's panel state carries into web's.
  assert.deepEqual(mounts.slice(-2), [`${ACME}/api`, `${ACME}/web`])

  await act(async () => root.unmount())
  root = createRoot(container)
  await render('ws-acme', ACME)
  assert.equal(container.querySelector('[data-body]')?.getAttribute('data-body'), `${ACME}/web`, 'still web')
  await render('ws-other', ACME)
  assert.equal(
    container.querySelector('[data-body]')?.getAttribute('data-body'),
    `${ACME}/api`,
    'another workspace has its own pick',
  )
})

test('a fetch asks main to read the project folder again', async () => {
  await render('ws-acme', ACME)
  const before = asks.length
  await act(async () => targets.at(-1)?.onFetch?.())
  await act(async () => {})
  assert.deepEqual(asks.slice(before), [{ folderPath: ACME, refresh: true }])
})

test('a repository workspace gets the panel as always: its own folder, no row', async () => {
  await render('ws-app', '/Users/dev/app')
  const last = targets.at(-1)!
  assert.equal(last.repository, undefined)
  assert.equal(last.switcher, undefined)
  assert.equal(last.projectResolving, false)
  assert.equal(container.querySelector('[aria-label="Repository"]'), null)
})

test('until the folder has been read, the panel holds its "not a repository" verdict', async () => {
  let release!: () => void
  ;(window as unknown as { api: unknown }).api = {
    getProjectRepositories: () => new Promise((resolve) => (release = () => resolve(acme))),
  }
  await act(async () => {
    root.render(
      <ProjectRepositoriesGitPanel
        workspaceId="ws-acme"
        folderPath={ACME}
        renderBody={(target) => <Body {...target} />}
      />,
    )
  })
  assert.equal(container.querySelector('[data-body]')?.getAttribute('data-resolving'), 'true')
  await act(async () => release())
  assert.equal(container.querySelector('[data-body]')?.getAttribute('data-body'), `${ACME}/api`)
})

test('a window whose preload cannot ask reads the folder as a single one', async () => {
  ;(window as unknown as { api: unknown }).api = {}
  await render('ws-acme', ACME)
  const last = targets.at(-1)!
  assert.equal(last.repository, undefined)
  assert.equal(last.projectResolving, false)
})

test('past the cap the list says only the first ones are shown', async () => {
  answers[ACME] = { ...acme, truncated: true }
  await render('ws-acme', ACME)
  const trigger = container.querySelector<HTMLElement>('[role="combobox"][aria-label="Repository"]')
  await act(async () => trigger!.click())
  const note = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) =>
    /Only the first 20 repositories are listed/u.test(option.textContent ?? ''),
  )
  assert.ok(note)
  assert.equal(note.getAttribute('aria-disabled'), 'true')
})

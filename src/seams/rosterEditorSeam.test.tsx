import assert from 'node:assert/strict'

import { installJsdomEnvironment } from './jsdomEnvironment'

// ── Seam: one roster editor, two surfaces (MC-1879 → MC-1880) ────────────────
//
// MC-1879 lifted the roster editor's state out of the sprint wizard into
// `useRosterEditor` so MC-1880's Horizon roster manager could drive the SAME
// `SprintEngineRosterPanel` instead of a rebuilt lookalike. Each item's own
// suite proves its half in isolation: the wizard suites prove the wizard still
// behaves, and the Horizon suite proves the picker renders. Neither can catch
// this seam failing, because the failure only appears when BOTH consumers are
// alive at once:
//
//   - cross-talk: the modal's edits leaking into the wizard's rows before save
//     (or vice versa), which would make a cancelled edit destructive;
//   - divergence: the two surfaces reading a roster differently, which is the
//     exact "rebuilt lookalike" outcome the extraction exists to prevent;
//   - a save in one surface never reaching the other, which would make
//     "editing is global" — the sentence the manager modal shows the user —
//     a lie.
//
// So this suite mounts the hook TWICE against the real store, drives one
// instance, and asserts on the other. It also mounts the real panel with each
// instance's returned props to prove they are genuinely interchangeable.
//
// Labelled SEAM: per the run-A convention.

const dom = installJsdomEnvironment()
void dom

async function main(): Promise<void> {
  const React = (await import('react')).default
  // Mounted for real with createRoot + act, NOT renderToStaticMarkup. The
  // server renderer hands zustand its INITIAL snapshot, so every instance would
  // read an empty store and this suite would pass while proving nothing — the
  // first version of it did exactly that. A live client mount is what makes
  // "one surface's save reaches the other" a real assertion.
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const { useWorkspaceStore } = await import('../renderer/src/store/workspaceStore')
  const { useRosterEditor } = await import(
    '../renderer/src/components/workspace/newWorkspace/useRosterEditor'
  )
  const { SprintEngineRosterPanel } = await import(
    '../renderer/src/components/workspace/newWorkspace/SprintEngineRosterPanel'
  )
  const { NO_ROLES_ROSTER_ID, NO_ROLES_ROSTER_NAME } = await import(
    '../renderer/src/components/workspace/newWorkspace/savedRosters'
  )

  let failures = 0
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn()
      console.log(`ok - ${name}`)
    } catch (error) {
      failures += 1
      console.error(`not ok - ${name}`)
      console.error(error)
    }
  }

  // Two independent hook instances, captured out of a render. `renderToStaticMarkup`
  // runs the hook body for real (state initialisers included), which is all this
  // seam needs — the questions are about what each instance READS from the shared
  // store and whether one instance's writes reach the other.
  type Editor = ReturnType<typeof useRosterEditor>
  const mounted: Array<() => void> = []
  // Returns a LIVE accessor, not a snapshot: the captured object is replaced on
  // every render, so reading through the accessor is how one instance observes
  // another instance's store write.
  async function captureEditor(options: Parameters<typeof useRosterEditor>[0]): Promise<() => Editor> {
    let captured: Editor | null = null
    function Probe(): JSX.Element {
      const editor = useRosterEditor(options)
      captured = editor
      // Mount the REAL panel with this instance's props: if the hook's returned
      // shape ever stops satisfying the panel, this render throws and the seam
      // fails here rather than in production.
      return (
        <SprintEngineRosterPanel
          rosterMode={editor.rosterMode}
          onChangeRosterMode={editor.onChangeRosterMode}
          roleCounts={editor.roleCounts}
          roleCliDefaults={editor.roleCliDefaults}
          roleModelOverrides={editor.roleModelOverrides}
          onSetRoleCount={editor.onSetRoleCount}
          onSetRoleCli={editor.onSetRoleCli}
          onSetRoleModel={editor.onSetRoleModel}
          cliOptions={editor.cliOptions}
          registry={editor.registry}
          registryStatus={editor.registryStatus}
          disabledRoleIds={editor.disabledRoleIds}
          rosterDisabled={editor.rosterDisabled}
          hasExistingTeam={false}
          rosters={editor.rosters}
          selectedRosterId={editor.selectedRosterId}
          selectedRosterDirty={editor.selectedRosterDirty}
          onSelectRoster={editor.onSelectRoster}
          onSaveRoster={editor.onSaveRoster}
          onUpdateRoster={editor.onUpdateRoster}
          onRenameRoster={editor.onRenameRoster}
          onDeleteRoster={editor.onDeleteRoster}
          poolAgentCount={editor.poolAgentCount}
          onChangePoolAgentCount={editor.onChangePoolAgentCount}
        />
      )
    }
    const container = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => {
      root.render(<Probe />)
    })
    // Kept mounted for the life of the suite: a live subscription is the whole
    // point — an instance that unmounts stops seeing the other's writes.
    mounted.push(() => root.unmount())
    if (!captured) throw new Error('the roster editor never rendered')
    return () => {
      if (!captured) throw new Error('the roster editor unmounted')
      return captured
    }
  }

  // Re-read an instance's latest value after a store write. The captured object
  // is a snapshot per render, so a subscription-driven update lands in a NEW
  // one; this waits for the re-render and hands back the current snapshot.
  async function settle(): Promise<void> {
    await act(async () => { await Promise.resolve() })
  }

  const wizardOptions: Parameters<typeof useRosterEditor>[0] = {
    cliOptions: [],
    cliAvailabilityStatus: 'idle',
    workspaceRoot: null,
  }

  await check('SEAM: both surfaces drive the real SprintEngineRosterPanel from the hook alone', async () => {
    // The mount inside captureEditor IS the assertion: it renders the real panel
    // with exactly what the hook returns, from two independently-configured call
    // sites, with no surface-local roster state to fill any gap.
    const wizard = await captureEditor(wizardOptions)
    const manager = await captureEditor({ ...wizardOptions, rosterDisabled: false })
    assert.ok(wizard().onSaveRoster, 'the wizard instance exposes the save action')
    assert.ok(manager().onSaveRoster, 'so does the manager instance')
  })

  await check('SEAM: a fresh install opens BOTH surfaces on No roles, identically', async () => {
    const wizard = await captureEditor(wizardOptions)
    const manager = await captureEditor(wizardOptions)
    assert.equal(wizard().selectedRosterId, NO_ROLES_ROSTER_ID)
    assert.equal(manager().selectedRosterId, NO_ROLES_ROSTER_ID)
    // Divergence is the failure this guards: two surfaces reading the same store
    // into different formations is the rebuilt-lookalike outcome.
    assert.equal(wizard().rosterMode, 'pool')
    assert.equal(wizard().rosterMode, manager().rosterMode)
    assert.deepEqual(wizard().roleCounts, manager().roleCounts)
  })

  await check('SEAM: the architect switches off — no role is floored on', async () => {
    const wizard = await captureEditor(wizardOptions)
    // Precondition: the specialist roster held behind the pool segment staffs it.
    assert.equal(wizard().roleCounts.architect, 1, 'precondition: the architect starts on')

    await act(async () => { wizard().onSetRoleCount('architect', 0) })
    await settle()

    // MC-2055 deleted `sprintEngineRosterRoleFloor`, which pinned this to 1 and
    // made the switch inert. A roster staffing nothing is a roleless sprint, not
    // an invalid one, so the count must actually reach 0 — the source-absence
    // pin in sprintengine.test.ts cannot show that the switch now works.
    assert.equal(wizard().roleCounts.architect, 0, 'the architect can be switched off')
  })

  await check('SEAM: a roster saved in one surface reaches the other, live', async () => {
    const author = await captureEditor(wizardOptions)
    const reader = await captureEditor(wizardOptions)
    assert.ok(
      !reader().rosters.some((entry) => entry.name === 'Frontend pair'),
      'precondition: the reader does not have it yet',
    )

    await act(async () => { author().onSaveRoster('Frontend pair') })
    await settle()

    // The reader was mounted BEFORE the save and never re-created: this is a
    // live subscription through the store, which is what makes the manager
    // modal's "editing is global" sentence true rather than aspirational.
    assert.ok(
      reader().rosters.some((entry) => entry.name === 'Frontend pair'),
      'the other surface sees the saved roster without being remounted',
    )
  })

  await check('SEAM: the two instances do NOT share editing state', async () => {
    const a = await captureEditor(wizardOptions)
    const b = await captureEditor(wizardOptions)
    // Independent state is deliberate, not accidental: a modal edit must not
    // mutate the rows the wizard is showing until it is SAVED. Sharing the
    // registry fetch would be an optimisation; sharing this would be a bug.
    assert.notEqual(a().setRoleCounts, b().setRoleCounts, 'each instance owns its own state')

    await act(async () => { a().onChangeRosterMode('roles') })
    await settle()
    assert.equal(a().rosterMode, 'roles', 'the edited instance changed')
    assert.equal(b().rosterMode, 'pool', 'the other instance did NOT — no cross-talk')
  })

  await check('SEAM: an EXPLICIT roster ref beats a stale last-used selection', async () => {
    const author = await captureEditor(wizardOptions)
    await act(async () => { author().onSaveRoster('Reviewers') })
    await settle()
    const saved = useWorkspaceStore.getState().appSettings.sprintEngineRoleSettings
      .savedRosters?.find((entry) => entry.name === 'Reviewers')
    assert.ok(saved, 'the roster was saved')

    // Last-used is the BUILT-IN, and the manager is opened on a real roster.
    // The explicit reference must win: otherwise unrelated wizard state decides
    // what a horizon staffs, which is the class of bug MC-1876 set out to kill.
    // (The first version of the resolver OR-ed these two and failed here.)
    await act(async () => {
      useWorkspaceStore.getState().setSprintEngineLastSelectedRoster(NO_ROLES_ROSTER_ID)
    })
    const manager = await captureEditor({ ...wizardOptions, initialRosterId: saved!.id })
    assert.equal(
      manager().selectedRosterId,
      saved!.id,
      'the manager opens on the roster it was given, not on the last-used No roles',
    )

    // And with NO explicit ref, last-used still decides — the fallback is intact.
    const wizard = await captureEditor(wizardOptions)
    assert.equal(
      wizard().selectedRosterId,
      NO_ROLES_ROSTER_ID,
      'without an explicit ref, the stored selection still applies',
    )
  })

  await check('SEAM: the built-in is never a saved roster on either surface', async () => {
    const wizard = await captureEditor(wizardOptions)
    const manager = await captureEditor(wizardOptions)
    for (const [label, editor] of [['wizard', wizard], ['manager', manager]] as const) {
      assert.ok(
        !editor().rosters.some((entry) => entry.name === NO_ROLES_ROSTER_NAME),
        `${label}: No roles is synthetic, never a row in savedRosters`,
      )
    }
  })

  for (const unmount of mounted) unmount()

  if (failures > 0) {
    console.error(`\n${failures} roster-editor seam checks failed`)
    process.exit(1)
  }
  console.log('rosterEditorSeam.test.tsx: ok')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})

import { expect, test } from 'vitest'

import type { MarketplaceUpdateStatesResult } from '../../../../shared/electron-api'
import { HOST_API_VERSION } from '../../../../shared/modules/host-api'
import type {
  CapabilityManifest,
  ThirdPartyModuleLaunchView,
  ThirdPartyModuleView,
} from '../../../../shared/modules/manifest'
import {
  accessItems,
  builtInMatchesFilter,
  marketplaceUpdateFor,
  moduleMatchesFilter,
  moduleMatchesQuery,
  moduleMeta,
  moduleProblem,
  modulesAwaitingRestart,
  problemText,
  resolveModuleEnabled,
  restartBannerTitle,
  runState,
} from './extensionsModel'

function view(
  overrides: Partial<Omit<ThirdPartyModuleView, 'manifest' | 'launch'>> & {
    manifest?: Partial<CapabilityManifest>
    launch?: Partial<ThirdPartyModuleLaunchView>
  } = {},
): ThirdPartyModuleView {
  const { manifest, launch, ...rest } = overrides
  return {
    trust: 'trusted',
    ...rest,
    manifest: {
      id: 'radar',
      displayName: 'PR Radar',
      version: 1,
      defaultEnabled: true,
      engines: { hostApi: HOST_API_VERSION },
      ...manifest,
    },
    launch: { status: 'trusted_executable', hasMainEntry: true, expectedToLoad: true, mainLoaded: true, ...launch },
  }
}

test('a running main entry reads Running; one turned on since launch waits on a restart', () => {
  expect(runState(view(), true, undefined)).toBe('running')
  expect(runState(view({ launch: { mainLoaded: false } }), true, undefined)).toBe('pending')
})

test('turning a loaded main entry off says it stops at the next restart; an unloaded one is just Off', () => {
  expect(runState(view(), false, undefined)).toBe('stopping')
  expect(runState(view({ launch: { mainLoaded: false } }), false, undefined)).toBe('off')
})

test('a renderer-only module runs as soon as its window code has loaded', () => {
  const rendererOnly = view({
    launch: { status: 'trusted_manifest_only', hasMainEntry: false, rendererEntry: { availability: 'available' } },
  })
  expect(runState(rendererOnly, true, { status: 'loaded' })).toBe('running')
  expect(runState(rendererOnly, true, undefined)).toBe('pending')
  expect(runState(rendererOnly, false, { status: 'loaded' })).toBe('off')
})

test('a module with no code of its own is On, never Running', () => {
  const manifestOnly = view({ launch: { status: 'trusted_manifest_only', hasMainEntry: false } })
  expect(runState(manifestOnly, true, undefined)).toBe('on')
})

test('failures say Couldn’t start with the reason, whatever the switch says', () => {
  const failed = view({ launch: { status: 'launch_error', message: 'registerMain threw: boom' } })
  expect(runState(failed, true, undefined)).toBe('failed')
  expect(problemText(moduleProblem(failed, undefined)!)).toBe('registerMain threw: boom')
  expect(runState(view(), true, { status: 'error', message: 'bad bundle' })).toBe('failed')
  expect(problemText(moduleProblem(view(), undefined, 'crashed while rendering')!)).toBe('crashed while rendering')
})

test('a module built for another host API says which way, in words', () => {
  const newer = view({
    manifest: { engines: { hostApi: HOST_API_VERSION + 1 } },
    launch: { status: 'blocked_host_api' },
  })
  expect(problemText(moduleProblem(newer, undefined)!)).toBe('Built for a newer version of Studio.')
  // It says so before trust: trusting it would not make it run.
  expect(moduleProblem({ ...newer, trust: 'unsigned' }, undefined)).toEqual({ kind: 'host-api', direction: 'newer' })
  const older = view({ manifest: { engines: { hostApi: 0 } }, launch: { status: 'blocked_host_api' } })
  expect(problemText(moduleProblem(older, undefined)!)).toBe('Built for an older version of Studio.')
})

test('an invalid signature can never be trusted, and the row says so', () => {
  const invalid = view({ trust: 'invalid', launch: { status: 'blocked_invalid' } })
  expect(moduleProblem(invalid, undefined)).toEqual({ kind: 'invalid' })
  expect(problemText({ kind: 'invalid' })).toMatch(/can’t be trusted/)
})

test('the restart line counts trusted, enabled main entries that did not load this session', () => {
  const waiting = view({ manifest: { id: 'radar', displayName: 'PR Radar' }, launch: { mainLoaded: false } })
  const running = view({ manifest: { id: 'log', displayName: 'Decision Log' } })
  const untrusted = view({
    trust: 'unsigned',
    manifest: { id: 'u' },
    launch: { status: 'blocked_unsigned', mainLoaded: false },
  })
  const failed = view({ manifest: { id: 'f' }, launch: { status: 'launch_error', mainLoaded: false } })
  const off = view({ manifest: { id: 'off', defaultEnabled: false }, launch: { mainLoaded: false } })
  const all = [waiting, running, untrusted, failed, off]
  const enabledFor = (module: ThirdPartyModuleView) => resolveModuleEnabled({}, module)

  const one = modulesAwaitingRestart(all, enabledFor)
  expect(one.map((module) => module.manifest.id)).toEqual(['radar'])
  expect(restartBannerTitle(one)).toBe('Restart Studio to start PR Radar')

  const two = modulesAwaitingRestart(all, (module) => module.manifest.id === 'off' || enabledFor(module))
  expect(restartBannerTitle(two)).toBe('Restart Studio to start 2 extensions')
  expect(restartBannerTitle([])).toBeNull()
})

function states(entries: Array<[string, number, number]>): MarketplaceUpdateStatesResult {
  return {
    ok: true,
    checked: true,
    registryState: 'ok',
    registrySource: 'network',
    stale: false,
    fetchedAt: '2026-10-09T00:00:00.000Z',
    entries: entries.map(([id, installed, latest]) => ({
      id,
      displayName: id,
      availability: {
        state: installed < latest ? 'update-available' : installed > latest ? 'ahead-of-registry' : 'current',
        installedVersion: installed,
        latestVersion: latest,
      },
    })),
  } as MarketplaceUpdateStatesResult
}

test('Update is offered only for a marketplace install whose registry lists a newer version', () => {
  const registry = states([
    ['weather', 3, 4],
    ['current', 2, 2],
  ])
  expect(marketplaceUpdateFor({ origin: { kind: 'marketplace', pluginId: 'weather' } }, registry)).toEqual({
    pluginId: 'weather',
    latestVersion: 4,
  })
  expect(marketplaceUpdateFor({ origin: { kind: 'marketplace', pluginId: 'current' } }, registry)).toBeNull()
  // GitHub and folder installs have no registry update path.
  expect(marketplaceUpdateFor({ origin: { kind: 'github', pluginId: 'weather', repo: 'acme/w' } }, registry)).toBeNull()
  expect(marketplaceUpdateFor({ origin: { kind: 'folder' } }, registry)).toBeNull()
  expect(marketplaceUpdateFor({}, registry)).toBeNull()
  // A registry that could not be read claims nothing.
  expect(marketplaceUpdateFor({ origin: { kind: 'marketplace', pluginId: 'weather' } }, null)).toBeNull()
  expect(
    marketplaceUpdateFor({ origin: { kind: 'marketplace', pluginId: 'weather' } }, { ok: false, message: 'offline' }),
  ).toBeNull()
})

test('the meta line is publisher · source · signature, and the scaffold placeholder is no publisher', () => {
  expect(
    moduleMeta(
      view({
        manifest: { publisher: 'acme', signature: { algorithm: 'ed25519', publicKey: 'k', signature: 's' } },
        origin: { kind: 'github', pluginId: 'radar', repo: 'acme/pr-radar' },
      }),
    ),
  ).toBe('acme · GitHub · Signed')
  expect(
    moduleMeta(view({ trust: 'unsigned', manifest: { publisher: 'Local developer' }, origin: { kind: 'folder' } })),
  ).toBe('Local build · Unsigned')
  expect(moduleMeta(view({ trust: 'signed', origin: { kind: 'marketplace', pluginId: 'x' } }))).toBe(
    'Marketplace · Signed',
  )
})

test('access splits into what needs care and the rest, with short titles', () => {
  const { care, standard } = accessItems(['storage', 'github', 'network'])
  expect(care.map((item) => item.title)).toEqual(['Uses your GitHub sign-in', 'Uses the network'])
  expect(care.every((item) => item.why)).toBe(true)
  expect(standard).toEqual([{ id: 'storage', title: 'Saves its own data' }])
})

test('filters: review is the untrusted, on/off the trusted by their switch, and built-ins never need review', () => {
  const trusted = view()
  const untrusted = view({ trust: 'signed' })
  expect(moduleMatchesFilter(untrusted, 'review', false)).toBe(true)
  expect(moduleMatchesFilter(trusted, 'review', true)).toBe(false)
  expect(moduleMatchesFilter(trusted, 'on', true)).toBe(true)
  expect(moduleMatchesFilter(trusted, 'off', true)).toBe(false)
  expect(moduleMatchesFilter(untrusted, 'off', false)).toBe(false)
  expect(builtInMatchesFilter('review', true)).toBe(false)
  expect(builtInMatchesFilter('off', false)).toBe(true)
  expect(moduleMatchesQuery(view({ manifest: { summary: 'Open pull requests' } }), 'PULL')).toBe(true)
  expect(moduleMatchesQuery(view(), 'weather')).toBe(false)
})

import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ScanResult, ScannedSkill, SkillSource } from '../../../../../../../shared/skills'
import { AddSkillSourceModal } from './AddSkillSourceModal'
import { SkillSourceCanvas, type SkillSourceCanvasProps } from './SkillSourceCanvas'
import { SkillsSurface } from './SkillsSurface'

// What the rendered surface owes: two separate targets on a skill row (never a
// button inside a button), an Install that states why it is unavailable rather
// than doing nothing, and a search-first source that renders no rows until it
// is asked.

function run(name: string, body: () => void): void {
  try {
    body()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

function skill(id: string, over: Partial<ScannedSkill> = {}): ScannedSkill {
  const name = id.split('/').slice(-1)[0]
  return {
    id,
    name,
    description: `${name} does something`,
    group: '',
    files: [{ path: 'SKILL.md', size: 900, blobSha: '', isEntry: true }],
    allowedTools: [],
    hasExecutables: false,
    ...over,
  }
}

function scanOf(skills: ScannedSkill[], over: Partial<ScanResult> = {}): ScanResult {
  return {
    skills,
    groups: [],
    groupingSignal: 'none',
    fileCount: skills.length,
    commitSha: '7a30f5200000',
    ...over,
  }
}

const SOURCE: SkillSource = {
  id: 'github:mattpocock/skills',
  kind: 'github',
  name: 'Matt Pocock',
  repo: 'mattpocock/skills',
  monogram: 'MP',
  blurb: 'Engineering and writing skills.',
  commitSha: '4f2a91c0000',
  scannedAt: '2026-07-28T09:00:00Z',
}

function canvas(over: Partial<SkillSourceCanvasProps> = {}): string {
  const scan = over.scan ?? scanOf([skill('skills/tdd'), skill('skills/triage')])
  return renderToStaticMarkup(
    <SkillSourceCanvas
      source={SOURCE}
      scan={scan}
      scanLoad={{ status: 'ready', scan }}
      installedDirNames={new Set()}
      installedError={null}
      activeGroup={null}
      onActiveGroupChange={() => {}}
      query=""
      onQueryChange={() => {}}
      selected={new Set()}
      onToggleSelect={() => {}}
      onSelectAll={() => {}}
      onClearSelection={() => {}}
      onOpenSkill={() => {}}
      availability={{ enabled: true, reason: null }}
      installing={null}
      onInstallSelected={() => {}}
      onBrowseMcpServers={() => {}}
      renderSkillPage={(skillId) => <div data-skill-page={skillId} />}
      {...over}
    />,
  )
}

/** A `<button>` inside another `<button>` — invalid, and one target where the
 *  design has two. */
function hasNestedButton(markup: string): boolean {
  return /<button(?:(?!<\/button>)[\s\S])*?<button/.test(markup)
}

run('a skill row carries two targets and never nests them', () => {
  const markup = canvas()
  assert.ok(markup.includes('role="checkbox"'), 'the select target is a checkbox')
  assert.ok(markup.includes('aria-label="Select tdd"'), 'the checkbox names the skill it selects')
  assert.ok(markup.includes('aria-checked="false"'))
  assert.ok(markup.includes('>Read<'), 'the row body opens the skill to be read')
  assert.equal(hasNestedButton(markup), false)
})

run('a grouped source renders its group tree and one group of rows', () => {
  const skills = [
    skill('skills/engineering/tdd', { group: 'engineering' }),
    skill('skills/engineering/triage', { group: 'engineering' }),
    skill('skills/writing/teach', { group: 'writing' }),
  ]
  const scan = scanOf(skills, { groups: ['engineering', 'writing'], groupingSignal: 'folders' })
  const markup = canvas({ scan })
  assert.ok(markup.includes('aria-label="Groups"'), 'the groups are a list')
  assert.ok(markup.includes('>Engineering<') && markup.includes('>Writing<'))
  assert.ok(markup.includes('aria-label="Select tdd"'))
  assert.ok(!markup.includes('aria-label="Select teach"'), 'only the active group renders rows')
  assert.equal(hasNestedButton(markup), false)
})

run('a search-first source renders no rows until a category or query is chosen', () => {
  const skills = Array.from({ length: 103 }, (_, index) =>
    skill(`solutions/ecommerce/skill-${index}`, { group: 'ecommerce' }),
  )
  const scan = scanOf(skills, { groups: ['ecommerce'], groupingSignal: 'folders' })
  const markup = canvas({ scan })
  assert.ok(markup.includes('Pick a category, or search.'))
  assert.ok(!markup.includes('role="checkbox"'), 'no rows are rendered yet')
  assert.ok(markup.includes('placeholder="Search 103 skills"'))
})

run('a solo source renders the skill page, not a list of one', () => {
  const markup = canvas({ scan: scanOf([skill('impeccable')]) })
  assert.ok(markup.includes('data-skill-page="impeccable"'))
  assert.ok(!markup.includes('role="checkbox"'))
})

run('the connector skills deflect to MCP servers', () => {
  const skills = Array.from({ length: 194 }, (_, index) => skill(`skills/connector-${index}`))
  const markup = canvas({
    source: { ...SOURCE, id: 'connectors', kind: 'connectors', name: 'Connectors', repo: '' },
    scan: scanOf(skills),
  })
  assert.ok(markup.includes('These 194 skills are paired with their MCP connectors.'))
  assert.ok(markup.includes('Browse MCP servers'))
  assert.ok(!markup.includes('role="checkbox"'), 'none of the 194 are listed here')
})

run('with no workspace the Install affordances are disabled and say why', () => {
  const markup = canvas({
    availability: {
      enabled: false,
      reason: 'Open a workspace to install skills — a skill installs into a workspace, not into the app.',
    },
  })
  assert.ok(markup.includes('Open a workspace to install skills'), 'the reason is visible, not a tooltip')
  const install = markup.slice(markup.lastIndexOf('<button', markup.indexOf('Install')))
  assert.ok(install.includes('disabled'), 'Install is disabled rather than silently doing nothing')
})

run('a failed installed-skills read is disclosed, never rendered as "not installed"', () => {
  const markup = canvas({ installedError: 'Workspace root does not exist.' })
  assert.ok(markup.includes('Installed skills in this workspace could not be read'))
})

run('an installed skill says so on its row', () => {
  const markup = canvas({ installedDirNames: new Set(['tdd']) })
  assert.ok(markup.includes('>Installed<'))
})

run('Add a source is a centred modal with an accessible name', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.ok(markup.includes('role="dialog"') && markup.includes('aria-modal="true"'))
  assert.ok(markup.includes('id="add-skill-source-title"'))
  assert.ok(markup.includes('items-center justify-center'), 'the modal is centred over a scrim')
  assert.ok(markup.includes('Scan and add'))
  assert.equal(hasNestedButton(markup), false)
})

run('the surface opens on a nested source rail that keeps Add and Discover', () => {
  const scan = scanOf([skill('skills/tdd'), skill('skills/triage')])
  const markup = renderToStaticMarkup(
    <SkillsSurface
      workspaceRoot="/proj"
      onBrowseMcpServers={() => {}}
      sources={{
        sources: [
          { ...SOURCE, id: 'builtin', kind: 'builtin', name: 'Multicode', repo: '', monogram: 'MC' },
          SOURCE,
        ],
        sourcesLoad: { status: 'ready' },
        scans: { builtin: { status: 'loading' }, [SOURCE.id]: { status: 'ready', scan } },
        installedDirNames: new Set(),
        installedRead: { status: 'ready' },
        refreshSources: () => {},
        refreshScan: () => {},
        refreshInstalled: () => {},
      }}
    />,
  )
  assert.ok(markup.includes('aria-label="Skill sources"'), 'the sources rail is a nested nav')
  assert.ok(markup.includes('>Add a source<'), 'Add a source belongs to Skills, not the global rail')
  assert.ok(markup.includes('>Discover<'), 'Discover belongs to Skills, at the rail foot')
  assert.ok(markup.includes('>Multicode<') && markup.includes('>mattpocock/skills<'))
  // The rail states each source's own read state; a pending scan is not a zero.
  assert.ok(markup.includes('>Loading…<') && markup.includes('>2 skills<'))
})

run('the closed modal renders nothing', () => {
  const markup = renderToStaticMarkup(
    <AddSkillSourceModal open={false} onClose={() => {}} onAdded={() => {}} onRemoved={() => {}} />,
  )
  assert.equal(markup, '')
})

console.log('skills surface render tests passed')

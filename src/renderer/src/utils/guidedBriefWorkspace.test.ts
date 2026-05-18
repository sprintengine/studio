import assert from 'node:assert/strict'
import {
  buildGuidedBriefBuildHandoffMarkdown,
  scaffoldGuidedBriefWorkspace,
  snapshotGuidedBriefArtifact,
  writeGuidedBriefBuildHandoff,
  type GuidedBriefFilesystem,
} from './guidedBriefWorkspace'

function createMemoryFilesystem(): GuidedBriefFilesystem & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()

  return {
    files,
    dirs,
    async ensureDir(parentDir, name) {
      const path = `${parentDir.replace(/\/+$/, '')}/${name}`
      dirs.add(path)
      return path
    },
    async readFile(path) {
      const content = files.get(path)
      if (content === undefined) throw new Error(`Missing file: ${path}`)
      return content
    },
    async writeFile(path, content) {
      files.set(path, content)
    },
  }
}

const noUiFs = createMemoryFilesystem()
await scaffoldGuidedBriefWorkspace({
  workspaceRoot: '/workspace',
  idea: 'Create a CLI that summarizes invoices.',
  hasUi: 'no',
  filesystem: noUiFs,
})

assert.ok(noUiFs.dirs.has('/workspace/product'), 'scaffold creates product folder')
assert.ok(noUiFs.dirs.has('/workspace/mockups'), 'scaffold creates mockups folder')
assert.ok(noUiFs.dirs.has('/workspace/product/.versions'), 'scaffold creates product versions folder')
assert.ok(noUiFs.dirs.has('/workspace/mockups/.versions'), 'scaffold creates mockup versions folder')
assert.match(
  noUiFs.files.get('/workspace/product/idea-seed.md') ?? '',
  /no visual UI/,
  'idea seed records no-UI decision',
)

noUiFs.files.set('/workspace/product/requirements.md', '# Requirements\n\nSummarize invoices.')
const noUiBrief = await snapshotGuidedBriefArtifact({
  workspaceRoot: '/workspace',
  sourcePath: '/workspace/product/requirements.md',
  kind: 'product',
  filesystem: noUiFs,
})
assert.match(noUiBrief.hash, /^[a-f0-9]{64}$/, 'snapshot returns a sha256 hash')
assert.equal(noUiBrief.path, `product/.versions/${noUiBrief.hash}.md`, 'snapshot returns project-relative path')
assert.equal(
  noUiFs.files.get(`/workspace/product/.versions/${noUiBrief.hash}.md`),
  '# Requirements\n\nSummarize invoices.',
  'snapshot writes content-addressed copy',
)

const noUiHandoff = await writeGuidedBriefBuildHandoff({
  workspaceRoot: '/workspace',
  idea: 'Create a CLI that summarizes invoices.',
  hasUi: 'no',
  productBrief: { title: 'Requirements', ...noUiBrief },
  confirmedDecisions: ['No visual UI is required.'],
  mvpScope: ['Parse invoice text and return a short summary.'],
  validationNotes: ['Run CLI tests against accepted requirements.'],
  filesystem: noUiFs,
})

assert.equal(noUiHandoff.path, 'product/build-handoff.md', 'handoff returns a project-relative path')
assert.match(noUiHandoff.content, /No UI mockups required/, 'no-UI handoff omits mockup requirement')
assert.match(noUiHandoff.content, /product\/\.versions\/[a-f0-9]{64}\.md/, 'handoff records accepted brief hash path')
assert.match(noUiFs.files.get('/workspace/product/build-handoff.md') ?? '', /## Suggested Sprint Engine Goal/)

const uiHandoff = buildGuidedBriefBuildHandoffMarkdown({
  idea: 'Create a dashboard for invoice trends.',
  hasUi: 'yes',
  productBrief: {
    title: 'Requirements',
    hash: 'briefhash',
    path: 'product/.versions/briefhash.md',
  },
  uiDirection: {
    title: 'UI direction',
    hash: 'uihash',
    path: 'product/.versions/uihash.md',
  },
  mockups: [
    {
      title: 'Dashboard mockup',
      hash: 'mockuphash',
      path: 'mockups/.versions/mockuphash.html',
    },
  ],
  confirmedDecisions: ['Application includes a visual UI.'],
  openQuestions: ['Which accounting system should import first?'],
  mvpScope: ['Render trend cards from imported invoice data.'],
  roster: ['product', 'architect', 'frontend', 'developer', 'tester'],
  risks: ['Imported files may have inconsistent formats.'],
  validationNotes: ['Compare UI against the accepted mockup snapshot.'],
})

assert.match(uiHandoff, /Dashboard mockup: `mockups\/\.versions\/mockuphash\.html`/, 'has-UI handoff records mockup snapshot')
assert.match(uiHandoff, /UI direction: `product\/\.versions\/uihash\.md` \(uihash\)/, 'has-UI handoff records UI direction snapshot')
assert.match(uiHandoff, /Which accounting system should import first\?/, 'has-UI handoff records open questions')

assert.throws(
  () => buildGuidedBriefBuildHandoffMarkdown({
    idea: 'Create a dashboard for invoice trends.',
    hasUi: 'yes',
    productBrief: null,
    requireMockups: true,
  }),
  /mockups-required/,
  'UI handoff can explicitly require mockups',
)

const skippedFrontendHandoff = buildGuidedBriefBuildHandoffMarkdown({
  idea: 'Create a dashboard for invoice trends.',
  hasUi: 'yes',
  productBrief: null,
  architecturePlan: {
    title: 'Architecture plan',
    hash: 'planhash',
    path: 'product/.versions/planhash.md',
  },
  requireMockups: false,
})
assert.match(skippedFrontendHandoff, /Product brief: not requested/, 'skipped product handoff is explicit')
assert.match(skippedFrontendHandoff, /No accepted mockups recorded/, 'skipped frontend handoff no longer throws')
assert.match(
  skippedFrontendHandoff,
  /Build the accepted Guided brief artifacts into a production-ready visual application\./,
  'skipped frontend goal does not reference missing mockups',
)

const uiFs = createMemoryFilesystem()
uiFs.files.set('/workspace/mockups/dashboard.html', '<main>Dashboard</main>')
const uiMockup = await snapshotGuidedBriefArtifact({
  workspaceRoot: '/workspace',
  sourcePath: '/workspace/mockups/dashboard.html',
  kind: 'mockup',
  filesystem: uiFs,
})

assert.equal(uiMockup.path, `mockups/.versions/${uiMockup.hash}.html`, 'mockup snapshot returns project-relative path')
assert.equal(
  uiFs.files.get(`/workspace/mockups/.versions/${uiMockup.hash}.html`),
  '<main>Dashboard</main>',
  'mockup snapshot writes content-addressed html copy',
)

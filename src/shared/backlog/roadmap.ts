// What is left of the roadmap object after its door retired (2026-09-05): the
// test that keeps a `backlog/roadmaps/<name>.md` file OUT of the backlog lists.
//
// The retired door planned an ordered run of backlog items in these files, and
// every repo that ever used it still carries them. They are not backlog items — a
// plan is not work — so the main-process listing tags them (`isRoadmap`) and
// every backlog list drops them, exactly as before. The parser, the policy model, the eligibility
// function and the authoring helpers went with the orchestrator; a file that
// wants them back has the deletion commit to revert.
//
// Node-free by construction (tsconfig.web-safe).

// The frontmatter `type:` value that marks a file as a roadmap. Deliberately NOT
// added to the closed `BacklogTypePayload`/`BacklogType` unions: the renderer read
// model keeps roadmap an OKF-tolerated leaf (`rawType`), and the main-process
// listing tags it with an `isRoadmap` flag rather than the closed type field
// (src/main/backlog-service.ts). Roadmaps live only under `ROADMAPS_DIR_PREFIX`.
const ROADMAP_TYPE = 'roadmap'
const ROADMAPS_DIR_PREFIX = 'backlog/roadmaps/'

function normalizeRef(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/').trim()
}

function isRoadmapRelativePath(pathValue: string): boolean {
  return normalizeRef(pathValue).startsWith(ROADMAPS_DIR_PREFIX)
}

// True when a parsed backlog file is a roadmap: either it lives in the roadmaps
// directory or it declares `type: roadmap`. Mirrors the epic dual-signal test in
// backlog-service.ts (path prefix OR frontmatter type).
export function isRoadmapContent(relativePath: string, frontmatterType: string | undefined): boolean {
  return isRoadmapRelativePath(relativePath) || frontmatterType === ROADMAP_TYPE
}

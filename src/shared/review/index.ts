// Shared review contracts: the validated JSON every review surface projects.
// Node-free — importable from renderer, main, and tests; never imports src/main/
// or Electron. See docs/review-brief-schema.md for the shapes in prose.

export * from './anchors'
export * from './changeset'
export * from './brief'
export * from './comments'

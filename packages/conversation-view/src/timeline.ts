// The timeline this view draws, from `@sprintengine/conversation-timeline`.
// In this repository the package's source is re-exported by path; the
// published build replaces this file with a re-export of the dependency
// (build.mjs), so the tarball depends on the timeline package.
export * from '../../conversation-timeline/src/public.js'

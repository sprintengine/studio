// The conversation contract this package reads, from
// `@sprintengine/conversation-protocol`. In this repository the package's
// source is re-exported by path; the published build replaces this one file
// with a re-export of the dependency (build.mjs), so the tarball depends on
// the protocol package rather than carrying a copy of it.
export * from '../../conversation-protocol/src/public.js'

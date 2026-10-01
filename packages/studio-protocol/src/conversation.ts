// The conversation contract this protocol carries, from
// `@sprintengine/conversation-protocol`. In this repository the package's
// source is re-exported by path; the published build replaces this one file
// with a re-export of the dependency (build.mjs), so the tarball depends on
// the conversation package rather than carrying a copy of it. Nothing else in
// this package names the conversation package directly.
export * from '../../conversation-protocol/src/public.js'

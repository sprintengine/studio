// The protocol this client speaks, from `@sprintengine/studio-protocol`. In
// this repository the package's source is re-exported by path; the published
// build replaces this one file with a re-export of the dependency (build.mjs),
// so the tarball depends on the protocol package rather than carrying a copy
// of it. Nothing else in this package names the protocol package directly.
export * from '../../studio-protocol/src/public.js'

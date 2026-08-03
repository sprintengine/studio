// The topic review's `entry.main` emits guide-run progress on, through the
// module-owned event channel (MC-2090). It lives in the shared tree because both
// halves name it: the main module emits, the renderer session subscribes, and
// neither may import the other's tree.
//
// Scoped to the `review` module by the host — the kernel stamps the source
// module id and delivers only to that module's subscribers — so the topic needs
// no prefix of its own.
export const BRIEF_RUN_EVENT_TOPIC = 'brief-run'

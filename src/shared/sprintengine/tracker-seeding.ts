// ---------------------------------------------------------------------------
// Plan-sourced sprint seeding helpers
//
// The one pure, node-testable helper left from the tracker-sprint seam. The
// proxy-identity readers that used to live here went with materialization
// (MC-2359): there are no mirrored tracker items to parse an identity out of,
// and a sprint started from a tracker issue now composes its own seed rather
// than refreshing a file on disk.
// ---------------------------------------------------------------------------

// The run goal for a plan-sourced launch: the first markdown heading of the
// seed (§2 "title-as-goal"), falling back to a humanized filename stem when the
// seed has no heading. Shared by every plan-sourced creation path.
export function derivePlanSourcedGoal(sourceContent: string, sourcePath: string): string {
  const heading = sourceContent
    .split(/\r?\n/u)
    .map((line) => line.match(/^#{1,3}\s+(.+?)\s*$/u)?.[1]?.trim())
    .find((title): title is string => Boolean(title))
  if (heading) return heading

  const filename = sourcePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = filename.replace(/\.[^.]+$/u, '').trim()
  const normalized = stem.replace(/[-_]+/gu, ' ').replace(/\s+/gu, ' ').trim()
  return normalized || 'Sprint handoff'
}

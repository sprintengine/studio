import { newDesignSystemEntryKeys } from './new-entries'

// The Design row's count, OUTSIDE the Design door.
//
// The door already answers "what arrived since you last looked" per bundle, but
// it can only answer it for a bundle it has READ — and a read inlines every
// asset in the system. The Extensions drawer needs the same number for every
// registered bundle, on every frame it draws the row, which is not a price a
// full read can pay.
//
// So the arrival dates travel on their own: a per-bundle `addedAt` map and
// nothing else, listed by main (see `src/main/design-system/arrivals.ts`) and
// summed here. The RULE is not restated — `newDesignSystemEntryKeys` is the one
// definition of new, so the row and the door can never disagree about what
// counts, only about how fresh their data is.

/** One bundle's arrival dates: its registration id, its folder, and entry key → ISO date. */
export type DesignSystemBundleArrivals = {
  /** `designSystemRegistrationId(path)` — the key `appSettings.designSystemSeen` stamps. */
  bundleId: string
  path: string
  addedAt: Record<string, string>
}

/** What the arrivals IPC returns: one row per readable registered bundle. */
export type DesignSystemArrivalsResult = { bundles: DesignSystemBundleArrivals[] }

/**
 * How many entries across the whole library arrived since each bundle was last
 * shown.
 *
 * A SUM over bundles, each measured against its own seen stamp: two systems in
 * the library are two separate visits, and one opened this morning must not
 * silence the one nobody has opened in a year.
 *
 * A bundle with no arrival dates contributes nothing, exactly as the door draws
 * no markers for it — an unknown date is never a badge.
 */
export function designSystemNewEntryCount(input: {
  bundles: readonly DesignSystemBundleArrivals[]
  /** `appSettings.designSystemSeen`: bundle id → ISO of the last visit. */
  seen: Readonly<Record<string, string>>
  now: Date
}): number {
  let count = 0
  for (const bundle of input.bundles) {
    count += newDesignSystemEntryKeys({
      addedAt: bundle.addedAt,
      seenAt: input.seen[bundle.bundleId] ?? null,
      now: input.now,
    }).size
  }
  return count
}

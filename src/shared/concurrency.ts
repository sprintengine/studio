/**
 * Run `work` over every item, never more than `limit` at once, and resolve with
 * the results in the items' order.
 *
 * A fixed number of lanes each pull the next unclaimed index until none is
 * left, so a slow item holds up one lane rather than a whole batch. The first
 * rejection rejects the call, and no lane starts another item after it; work
 * already running is not cancelled.
 */
export async function mapWithLimit<In, Out>(
  items: readonly In[],
  limit: number,
  work: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length)
  let next = 0
  let failed = false
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; !failed && index < items.length; index = next++) {
      try {
        results[index] = await work(items[index])
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  await Promise.all(lanes)
  return results
}

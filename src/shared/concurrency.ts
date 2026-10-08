/**
 * Run `work` over every item, never more than `limit` at once, and resolve with
 * the results in the items' order.
 *
 * A fixed number of lanes each pull the next unclaimed index until none is
 * left, so a slow item holds up one lane rather than a whole batch. The first
 * rejection rejects the call; lanes already running are not cancelled.
 */
export async function mapWithLimit<In, Out>(
  items: readonly In[],
  limit: number,
  work: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(items.length)
  let next = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await work(items[index])
    }
  })
  await Promise.all(lanes)
  return results
}

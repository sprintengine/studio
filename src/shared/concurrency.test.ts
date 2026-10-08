import { describe, expect, test } from 'vitest'
import { mapWithLimit } from './concurrency'

describe('mapWithLimit', () => {
  test('resolves with the results in the items order, whatever order they finish in', async () => {
    const delays = [30, 5, 20, 1, 10]
    const results = await mapWithLimit(delays, 2, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return delay * 2
    })
    expect(results).toEqual([60, 10, 40, 2, 20])
  })

  test('never runs more than the limit at once', async () => {
    let running = 0
    let peak = 0
    await mapWithLimit(
      Array.from({ length: 12 }, (_, index) => index),
      3,
      async () => {
        running += 1
        peak = Math.max(peak, running)
        await new Promise((resolve) => setTimeout(resolve, 2))
        running -= 1
      },
    )
    expect(peak).toBe(3)
  })

  test('an empty list resolves at once without calling the work', async () => {
    let calls = 0
    expect(
      await mapWithLimit([], 4, async () => {
        calls += 1
      }),
    ).toEqual([])
    expect(calls).toBe(0)
  })

  test('the first rejection rejects the call', async () => {
    await expect(
      mapWithLimit([1, 2, 3], 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      }),
    ).rejects.toThrow('boom')
  })

  test('no item starts after one has failed', async () => {
    const started: number[] = []
    await expect(
      mapWithLimit([1, 2, 3, 4, 5, 6], 2, async (item) => {
        started.push(item)
        if (item === 1) throw new Error('boom')
        await new Promise((resolve) => setTimeout(resolve, 5))
        return item
      }),
    ).rejects.toThrow('boom')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(started).toEqual([1, 2])
  })
})

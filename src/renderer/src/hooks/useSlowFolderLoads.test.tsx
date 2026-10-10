// @vitest-environment jsdom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { FOLDER_LOADING_DELAY_MS, useSlowFolderLoads } from './useSlowFolderLoads'

let root: Root | null = null
let host: HTMLElement | null = null
let hook: ReturnType<typeof useSlowFolderLoads>
let renders = 0

function Probe(): null {
  hook = useSlowFolderLoads()
  renders += 1
  return null
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  renders = 0
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => root?.render(<Probe />))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  root = null
  host = null
  vi.useRealTimers()
})

test('a listing that lands inside the hold never marks its folder or renders', async () => {
  const before = renders
  const load = deferred()
  const tracked = hook.track('/Users/dev/app/src', load.promise)
  await act(async () => vi.advanceTimersByTime(FOLDER_LOADING_DELAY_MS - 1))
  await act(async () => {
    load.resolve()
    await tracked
  })
  await act(async () => vi.advanceTimersByTime(FOLDER_LOADING_DELAY_MS))
  expect(hook.slowPaths.size).toBe(0)
  expect(renders).toBe(before)
})

test('a listing that outlasts the hold marks its folder until it lands', async () => {
  const load = deferred()
  const tracked = hook.track('/Users/dev/app/src', load.promise)
  await act(async () => vi.advanceTimersByTime(FOLDER_LOADING_DELAY_MS))
  expect([...hook.slowPaths]).toEqual(['/Users/dev/app/src'])
  await act(async () => {
    load.resolve()
    await tracked
  })
  expect(hook.slowPaths.size).toBe(0)
})

test('a listing that fails clears its mark and hands the error back', async () => {
  const load = deferred()
  const tracked = hook.track('/Users/dev/app/src', load.promise)
  await act(async () => vi.advanceTimersByTime(FOLDER_LOADING_DELAY_MS))
  await act(async () => {
    load.reject(new Error('EACCES'))
    await expect(tracked).rejects.toThrow('EACCES')
  })
  expect(hook.slowPaths.size).toBe(0)
})

test('two opens of one folder keep it marked until the last one lands', async () => {
  const first = deferred()
  const second = deferred()
  const one = hook.track('/Users/dev/app/src', first.promise)
  const two = hook.track('/Users/dev/app/src', second.promise)
  await act(async () => vi.advanceTimersByTime(FOLDER_LOADING_DELAY_MS))
  await act(async () => {
    first.resolve()
    await one
  })
  expect(hook.slowPaths.has('/Users/dev/app/src')).toBe(true)
  await act(async () => {
    second.resolve()
    await two
  })
  expect(hook.slowPaths.size).toBe(0)
})

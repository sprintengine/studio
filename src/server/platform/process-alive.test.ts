import { afterEach, expect, test, vi } from 'vitest'
import { processIsRunning } from './process-alive'

afterEach(() => {
  vi.restoreAllMocks()
})

function failKill(code: string): void {
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error(code), { code })
  })
}

test('this process is running', () => {
  expect(processIsRunning(process.pid)).toBe(true)
})

test('a pid nothing runs under is not', () => {
  failKill('ESRCH')
  expect(processIsRunning(424242)).toBe(false)
})

test("another user's process counts as running", () => {
  failKill('EPERM')
  expect(processIsRunning(1)).toBe(true)
})

test('only a positive whole number names a process', () => {
  const kill = vi.spyOn(process, 'kill')
  for (const pid of [0, -1, -4242, 1.5, Number.NaN]) expect(processIsRunning(pid)).toBe(false)
  expect(kill).not.toHaveBeenCalled()
})

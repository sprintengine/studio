import { runSwitchboardPythonJsonCommand } from './switchboard-python'

export type SwitchboardCoreCommandResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; message: string; stdout?: string; stderr?: string; exitCode?: number | null }

export function workspaceArgs(workspaceRoot: string): string[] {
  return ['--workspace', workspaceRoot]
}

export async function runSwitchboardCore(args: string[]): Promise<SwitchboardCoreCommandResult> {
  return runSwitchboardPythonJsonCommand(args)
}

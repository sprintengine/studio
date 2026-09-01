import { runSwitchboardPythonJsonCommand } from './switchboard-python';
export function workspaceArgs(workspaceRoot) {
    return ['--workspace', workspaceRoot];
}
export async function runSwitchboardCore(args) {
    return runSwitchboardPythonJsonCommand(args);
}

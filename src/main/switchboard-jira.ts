import type { SwitchboardImportResult } from '../shared/switchboard'

export async function importJiraIssuesIntoWatchtower(_input: { workspaceRoot: string }): Promise<SwitchboardImportResult> {
  return {
    ok: false,
    provider: 'jira',
    unavailable: true,
    message: 'Jira import is unavailable because no Jira credentials or configuration model is configured.',
  }
}

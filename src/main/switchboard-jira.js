export async function importJiraIssuesIntoWatchtower(_input) {
    return {
        ok: false,
        provider: 'jira',
        unavailable: true,
        message: 'Jira import is unavailable because no Jira credentials or configuration model is configured.',
    };
}

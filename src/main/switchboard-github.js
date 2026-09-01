import { getGitHubRepoRef } from './git-github';
import { importSwitchboardItems, normalizeSwitchboardImportItem } from './switchboard-imports';
export async function importGitHubIssuesIntoWatchtower(input) {
    try {
        const repo = await getGitHubRepoRef(input.workspaceRoot);
        if (!repo)
            return { ok: false, provider: 'github', message: 'No GitHub origin remote was found for this repository.', unavailable: true };
        const token = await input.tokenStore.resolveToken();
        const issues = await fetchOpenGitHubIssues(repo, token);
        return importSwitchboardItems(input.workspaceRoot, 'github', issues.map((issue) => githubIssueToImportItem(repo, issue)));
    }
    catch (error) {
        return { ok: false, provider: 'github', message: error instanceof Error ? error.message : 'GitHub import failed.' };
    }
}
export function githubIssueToImportItem(repo, issue) {
    const number = typeof issue.number === 'number' ? issue.number : 0;
    const labels = Array.isArray(issue.labels)
        ? issue.labels.flatMap((label) => {
            if (typeof label === 'string')
                return [label];
            if (label && typeof label === 'object' && typeof label.name === 'string') {
                return [label.name];
            }
            return [];
        })
        : [];
    return normalizeSwitchboardImportItem({
        provider: 'github',
        externalId: typeof issue.node_id === 'string' ? issue.node_id : typeof issue.id === 'number' ? String(issue.id) : `${repo.owner}/${repo.repo}#${number}`,
        externalKey: `${repo.owner}/${repo.repo}#${number}`,
        externalUrl: issue.html_url,
        identifier: `${repo.repo}#${number}`,
        title: issue.title,
        description: issue.body,
        labels,
        priority: null,
        updatedAt: issue.updated_at,
    });
}
async function fetchOpenGitHubIssues(repo, token) {
    const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'multicode-watchtower',
        'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token)
        headers.Authorization = `Bearer ${token}`;
    let nextUrl = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/issues?state=open&per_page=100`;
    const records = [];
    for (let page = 0; nextUrl && page < 50; page += 1) {
        const response = await fetch(nextUrl, { headers });
        if (!response.ok) {
            const message = response.status === 401 || response.status === 403
                ? 'GitHub import failed. Check that the token has Issues read access for this repository.'
                : response.status === 404 && !token
                    ? 'GitHub import failed. If this is a private repository, add a GitHub token in Settings.'
                    : `GitHub import failed with HTTP ${response.status}.`;
            throw new Error(message);
        }
        const payload = await response.json();
        if (!Array.isArray(payload))
            throw new Error('GitHub import returned an unexpected response shape.');
        records.push(...payload.filter(isImportableGitHubIssue));
        nextUrl = nextGitHubPageUrl(response.headers.get('link'));
    }
    if (nextUrl)
        throw new Error('GitHub import stopped after 50 pages to avoid an unbounded import.');
    return records;
}
function isImportableGitHubIssue(record) {
    const issue = record;
    return !issue.pull_request
        && typeof issue.number === 'number'
        && typeof issue.title === 'string'
        && typeof issue.html_url === 'string'
        && typeof issue.updated_at === 'string';
}
export function nextGitHubPageUrl(linkHeader) {
    if (!linkHeader)
        return null;
    for (const part of linkHeader.split(',')) {
        const match = part.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
        if (match && match[2] === 'next')
            return match[1];
    }
    return null;
}

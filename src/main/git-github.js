import { runGit } from './git-utils';
export async function getGitHubRepoWebUrl(repoRoot) {
    const repo = await getGitHubRepoRef(repoRoot);
    return repo?.webUrl ?? null;
}
export async function getGitHubRepoRef(repoRoot) {
    try {
        const originUrl = await runGit(repoRoot, ['remote', 'get-url', 'origin']);
        const repo = githubRepoFromRemote(originUrl);
        if (repo)
            return repo;
    }
    catch {
        // Ignore missing origin; fall through to scanning all remotes.
    }
    try {
        const remotes = await runGit(repoRoot, ['remote', '-v']);
        for (const line of remotes.split(/\r?\n/)) {
            const [, remoteUrl = ''] = line.trim().split(/\s+/);
            const repo = githubRepoFromRemote(remoteUrl);
            if (repo)
                return repo;
        }
    }
    catch {
        return null;
    }
    return null;
}
export function githubRepoFromRemote(remoteUrl) {
    const trimmed = remoteUrl.trim();
    if (!trimmed)
        return null;
    const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshMatch)
        return buildGitHubRepoRef(sshMatch[1], sshMatch[2]);
    const sshUrlMatch = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (sshUrlMatch)
        return buildGitHubRepoRef(sshUrlMatch[1], sshUrlMatch[2]);
    const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/);
    if (httpsMatch)
        return buildGitHubRepoRef(httpsMatch[1], httpsMatch[2]);
    return null;
}
function buildGitHubRepoRef(owner, repo) {
    const cleanRepo = repo.replace(/\.git$/u, '');
    return {
        owner,
        repo: cleanRepo,
        webUrl: `https://github.com/${owner}/${cleanRepo}`,
    };
}

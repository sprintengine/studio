import { teamSlugFromStatePath } from '../../../shared/backlog/sprintengine-links';
import { isCanceledSprintEngineRun, isCompletedSprintEngineRun, normalizeSprintEngineProjection } from '../../../shared/sprintengine/state';
import { sprintEngineRunFingerprint } from '../../automations/triggers/sprint-engine-run-events';
export function createRunStateReader(reader) {
    return {
        async readRunFacts({ statePath }) {
            const team = teamSlugFromStatePath(statePath);
            if (!team)
                return null;
            let read;
            try {
                read = await reader.readProjection({ statePath });
            }
            catch {
                return null; // Unreadable ⇒ no facts ⇒ no posts.
            }
            if (!read.ok)
                return null;
            const state = normalizeSprintEngineProjection(read.data, team);
            if (!state)
                return null;
            const canceled = isCanceledSprintEngineRun(state);
            return {
                runId: `${team}:${sprintEngineRunFingerprint(state)}`,
                goal: state.goal,
                // A planned, executing run is the earliest honest "started" signal; a
                // just-created shell with no tasks yet has not started work.
                started: state.tasks.length > 0,
                // The projection-freeze guard: completion is judged from the run store,
                // and a canceled run is decided, not completed.
                completed: !canceled && isCompletedSprintEngineRun(state),
                canceled,
                pullRequestUrls: collectPullRequestUrls(state.vcs),
                taskCount: state.tasks.length,
            };
        },
    };
}
// Every delivered pull request URL across the run's projects, distinct, primary
// project first. Reads both the per-repo list and the flat primary fields so a
// run stored before the multi-repo list still surfaces its one PR.
function collectPullRequestUrls(vcs) {
    if (!vcs)
        return [];
    const urls = [];
    pushUrl(urls, vcs.pullRequestUrl);
    for (const repo of readRepos(vcs))
        pushUrl(urls, repo.pullRequestUrl);
    return urls;
}
function readRepos(vcs) {
    return Array.isArray(vcs.repos) ? vcs.repos : [];
}
function pushUrl(urls, candidate) {
    const url = typeof candidate === 'string' ? candidate.trim() : '';
    if (url && !urls.includes(url))
        urls.push(url);
}

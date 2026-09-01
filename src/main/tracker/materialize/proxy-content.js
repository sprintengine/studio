// Pure composition for tracker proxy items (MC-1637 / plan §3.4). Turns a
// NormalizedIssue into the tracker-owned material the writer lands: the flat
// underscore external-identity frontmatter keys, the markdown body (title
// heading + mirrored state/priority/assignee block + provenance marker + issue
// body + comments), and the one issue-typed sidecar link. Node-free and
// side-effect-free so it is unit-testable on its own; the fs writer lives in
// backlog-service.ts and the fetch/concurrency orchestrator in
// materialize-service.ts.
// Human-facing provider labels — plain names, never "provider"/"baseUrl" jargon.
const PROVIDER_LABEL = {
    github: 'GitHub',
    jira: 'Jira',
    linear: 'Linear',
};
export function trackerProviderLabel(provider) {
    return PROVIDER_LABEL[provider] ?? provider;
}
// Visible line separating the tracker-owned body below it from the heading and
// mirror block above. A refresh regenerates the whole body, so this is a note to
// a human editor, not a machine split point.
export function proxyProvenanceMarker(provider) {
    return `> Synced from ${trackerProviderLabel(provider)} — this item mirrors an external issue. Anything below is replaced when it refreshes.`;
}
// The moduleId the issue sidecar link carries. Informational: the T8 link
// providers match on the target kind, not the module id.
export const TRACKER_LINK_MODULE_ID = 'tracker';
// One issue link per proxy item, replaced (not stacked) on every refresh.
export const TRACKER_ISSUE_LINK_ID = 'tracker:issue';
export function trackerIssueTargetKind(provider) {
    return `${provider}.issue`;
}
export function proxyExternalFields(issue, connection) {
    return {
        external_provider: issue.provider,
        external_connection: connection.id,
        external_id: issue.externalId,
        external_key: issue.nativeKey,
        external_url: issue.url,
    };
}
// The composed markdown body (no frontmatter), starting at the `# heading`. A
// refresh rewrites this whole block; the writer preserves the Multicode-owned
// frontmatter (status/type/triage/epic/dependsOn) and the sidecar around it.
export function composeProxyBody(issue) {
    const title = issue.title.trim() || issue.nativeKey;
    const lines = [`# ${title}`, ''];
    const facts = [`**State:** ${issue.state.nativeName.trim() || defaultStateName(issue)}`];
    if (issue.priority?.trim())
        facts.push(`**Priority:** ${issue.priority.trim()}`);
    const assignee = issue.assignee?.displayName?.trim();
    if (assignee)
        facts.push(`**Assignee:** ${assignee}`);
    lines.push(facts.join(' · '), '');
    if (issue.url.trim()) {
        lines.push(`[View ${issue.nativeKey} in ${trackerProviderLabel(issue.provider)}](${issue.url.trim()})`, '');
    }
    lines.push(proxyProvenanceMarker(issue.provider), '');
    const body = issue.bodyMarkdown.trim();
    lines.push(body || '_No description provided._');
    if (issue.comments.length > 0) {
        lines.push('', '## Comments');
        for (const comment of issue.comments) {
            const header = [comment.author?.trim(), comment.createdAt?.trim()].filter(Boolean).join(' · ');
            lines.push('');
            if (header)
                lines.push(`**${header}**`, '');
            lines.push(comment.body.trim() || '_(empty comment)_');
        }
    }
    return `${lines.join('\n')}\n`;
}
function defaultStateName(issue) {
    return issue.state.category === 'closed' ? 'Closed' : 'Open';
}
// The one issue-typed sidecar link recorded per proxy item (consumed by T8).
// target.id carries the externalId, target.url the tracker link; the link type
// is `issue`, which is lifecycle-neutral by construction (only `execution`
// links move item status).
export function proxyIssueLink(issue) {
    return {
        id: TRACKER_ISSUE_LINK_ID,
        moduleId: TRACKER_LINK_MODULE_ID,
        type: 'issue',
        label: issue.nativeKey,
        target: {
            kind: trackerIssueTargetKind(issue.provider),
            id: issue.externalId,
            url: issue.url,
        },
    };
}

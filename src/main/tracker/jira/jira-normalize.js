import { jiraBodyToMarkdown, jiraCommentBodyToMarkdown } from './jira-markup';
import { normalizeIssueState } from '../../../shared/tracker/state-mapping';
// Maps a Jira issue to the shared NormalizedIssue. State is derived from the
// STRUCTURAL `statusCategory.key`, never the display name (plan §3.1); the body
// converts best-effort to markdown while `rawBody` keeps the original markup.
export function normalizeJiraIssue(record, connection) {
    const fields = record.fields ?? {};
    const nativeKey = typeof record.key === 'string' ? record.key : '';
    const body = jiraBodyToMarkdown(fields.description);
    const statusCategoryKey = typeof fields.status?.statusCategory?.key === 'string' ? fields.status.statusCategory.key : '';
    const statusName = typeof fields.status?.name === 'string' ? fields.status.name : statusCategoryKey;
    const issue = {
        provider: 'jira',
        connectionId: connection.id,
        externalId: coerceExternalId(record.id, nativeKey),
        nativeKey,
        title: typeof fields.summary === 'string' ? fields.summary : nativeKey,
        bodyMarkdown: body.markdown,
        ...(body.raw !== undefined ? { rawBody: body.raw } : {}),
        state: normalizeIssueState({ provider: 'jira', statusCategoryKey, nativeName: statusName }),
        labels: normalizeLabels(fields.labels),
        url: browseUrl(connection.baseUrl, nativeKey),
        comments: normalizeComments(fields.comment?.comments),
    };
    const priority = fields.priority?.name;
    if (typeof priority === 'string' && priority.trim())
        issue.priority = priority;
    const assignee = normalizeAssignee(fields.assignee);
    if (assignee)
        issue.assignee = assignee;
    if (typeof fields.updated === 'string')
        issue.updatedAt = fields.updated;
    return issue;
}
// Stable provider id is the numeric issue id ("10023"); fall back to the key so
// an unexpected payload still yields a usable identifier.
function coerceExternalId(id, nativeKey) {
    if (typeof id === 'string' && id.trim())
        return id;
    if (typeof id === 'number')
        return String(id);
    return nativeKey;
}
function normalizeLabels(labels) {
    return Array.isArray(labels) ? labels.filter((l) => typeof l === 'string') : [];
}
function normalizeAssignee(assignee) {
    if (!assignee)
        return undefined;
    // Cloud identifies a user by accountId; Data Center by name/key. Take whichever
    // the site provides so both self-hosted and cloud carry a stable id.
    const id = firstString(assignee.accountId) ?? firstString(assignee.name) ?? firstString(assignee.key);
    const displayName = firstString(assignee.displayName);
    if (!id && !displayName)
        return undefined;
    return {
        ...(id ? { id } : {}),
        ...(displayName ? { displayName } : {}),
    };
}
function normalizeComments(comments) {
    if (!Array.isArray(comments))
        return [];
    return comments.map((comment) => {
        const c = comment;
        const author = firstString(c.author?.displayName);
        const createdAt = firstString(c.created);
        return {
            ...(author ? { author } : {}),
            body: jiraCommentBodyToMarkdown(c.body),
            ...(createdAt ? { createdAt } : {}),
        };
    });
}
// The human-facing issue URL. Jira payloads carry an API `self` link, not the
// browse URL, so it is composed from the connection's site root + the key.
function browseUrl(baseUrl, nativeKey) {
    if (!baseUrl || !nativeKey)
        return baseUrl ?? '';
    return `${baseUrl.replace(/\/+$/, '')}/browse/${nativeKey}`;
}
function firstString(value) {
    return typeof value === 'string' && value.trim() ? value : undefined;
}

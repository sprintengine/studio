# Jira provider fixtures

Recorded-payload fixtures for the Jira `TrackerProvider` (MC-1635). They stand in
for a live Cloud site and a Data Center instance where a real instance is not
reachable in CI, and are the normalization contract the provider tests assert
against. Issue/comment/transition payloads mirror Jira REST **v2** (identical on
Cloud and DC); search is split — DC keeps offset-paged v2, Cloud rides the
token-paged **v3** `/search/jql` that replaced the retired v2 `/search`.

| File | Endpoint | What it exercises |
|---|---|---|
| `cloud-issue.json` | `GET /rest/api/2/issue/PROJ-17` | Cloud issue; **wiki-markup** description + comments; `statusCategory.key = indeterminate` under a misleading status name (`Ship it`) → `open`. |
| `datacenter-issue.json` | `GET /rest/api/2/issue/OPS-902` | Data Center issue; identical v2 shape, `assignee` by `name`/`key` (no `accountId`); `statusCategory.key = new` → `open`. Proves Cloud/DC parity — only the auth header differs. |
| `adf-issue.json` | `GET /rest/api/2/issue/PROJ-141` | A site returning an **ADF** (JSON) description; `statusCategory.key = done` under name `In Review` → `closed`. |
| `cloud-search-page1.json` / `cloud-search-page2.json` | `GET /rest/api/3/search/jql` | Cloud token pagination: page 1 carries `nextPageToken` + `isLast:false`, page 2 `isLast:true` with no token (no `total`). |
| `search-page1.json` / `search-page2.json` | `GET /rest/api/2/search` | Data Center offset pagination (`total = 3`, `maxResults = 2`) for search + `listAssignedToMe`. |
| `myself.json` | `GET /rest/api/2/myself` | `testConnection` success probe. |
| `transitions.json` | `GET /rest/api/2/issue/{id}/transitions` | `listTransitions` (tier-2 write-back, MC-1640). |
| `error-401.json` / `error-404.json` | any | Jira error-body shape (`errorMessages[]`) used to prove typed-error message preservation. |

## Refreshing against a real instance

Issue/comment/transition endpoints are `/rest/api/2` on both Cloud and DC. Search
differs: DC uses `/rest/api/2/search`; Cloud uses `/rest/api/3/search/jql`. To
re-capture:

### Jira Cloud (Basic — email + API token)

```bash
SITE="https://<your-site>.atlassian.net"
# The connection secret is the email and API token joined by a colon.
AUTH=$(printf '%s' "you@example.com:<api-token>" | base64)

curl -s -H "Authorization: Basic $AUTH" -H 'Accept: application/json' \
  "$SITE/rest/api/2/issue/PROJ-17?fields=summary,description,status,priority,labels,assignee,updated,comment" \
  | python3 -m json.tool > cloud-issue.json

curl -s -H "Authorization: Basic $AUTH" -H 'Accept: application/json' \
  "$SITE/rest/api/3/search/jql?jql=assignee%20%3D%20currentUser()%20AND%20resolution%20%3D%20EMPTY&maxResults=2&fields=summary,description,status,priority,labels,assignee,updated" \
  | python3 -m json.tool > cloud-search-page1.json
```

The `search-page1.json` / `search-page2.json` v2 captures come from a Data Center
site's `GET /rest/api/2/search` (Cloud no longer serves it).

### Jira Data Center (Bearer PAT)

```bash
SERVER="https://<your-jira-host>"
curl -s -H "Authorization: Bearer <personal-access-token>" -H 'Accept: application/json' \
  "$SERVER/rest/api/2/issue/OPS-902?fields=summary,description,status,priority,labels,assignee,updated,comment" \
  | python3 -m json.tool > datacenter-issue.json
```

**Before committing a refreshed capture, scrub real data:** replace personal
names, account ids, email addresses, and internal hostnames/URLs with the
placeholders used here. Never commit a real credential — the `Authorization`
header is never part of a response body, so a clean capture carries none.

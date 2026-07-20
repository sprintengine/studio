# GitHub tracker fixtures — refresh procedure

These are recorded GitHub REST v3 payloads the normalization test
(`client.test.ts`) runs against, so a schema drift in what the provider reads is
caught without a live call. They are trimmed to the fields
`src/main/tracker/github/client.ts` actually consumes; unrelated GitHub fields
are dropped to keep the diff legible. The `_capture` key on each file records the
exact request it came from and is ignored by the code.

## When to refresh

Refresh when the GitHub Issues REST v3 response shape for search, an issue, or
issue comments changes in a way the provider reads (new field the normalizer
should pick up, or a renamed one). Do **not** hand-edit the payloads to make a
test pass — recapture from a real instance so the fixture stays a faithful record.

## How to recapture (github.com)

Use a PAT with `repo`/`issues` read scope. Pick a public or accessible repo and
an issue that has comments and an assignee, so the normalization paths are all
exercised.

```bash
TOKEN=ghp_xxx
API=https://api.github.com

# search-issues.json — scope to an org spanning >1 repo, include is:issue so the
# only pull_request item present is one you add back by hand to prove exclusion.
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$API/search/issues?q=org:acme+is:issue+alerting&per_page=100"

# issue.json
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$API/repos/acme/web/issues/142"

# issue-comments.json
curl -s -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$API/repos/acme/web/issues/142/comments"
```

## How to recapture (GitHub Enterprise Server)

Identical, with the base URL pointing at the instance's REST root — the provider
has no host branch beyond this base URL, so a GHES capture normalizes through the
same path:

```bash
API=https://ghe.example.com/api/v3
# ...same three calls as above against $API...
```

After capturing, trim each payload to the fields already present in the checked-in
fixtures (the ones the provider reads), keep the `_capture` note current, and run
`npm run test:main:tracker-github`.

# Secrets and GitHub: brokered credentials

An extension never holds an API key or a token. It hands a secret to the host
once, and afterwards asks the host to make the request that needs it; for
GitHub, the host uses the person's own sign-in. Both live in `entry.main`.
Check `host.supports('secrets')` / `host.supports('github')` first.

## Secrets (`secrets` permission)

```ts
import { getSecretsService, type RegisterMain } from '@sprintengine/module-sdk'

export const registerMain: RegisterMain = (host) => {
  const secrets = getSecretsService(host)

  // The renderer collects the key in a password field and sends it once.
  host.registerIpc(`${host.moduleId}:set-key`, async (_event, key) => {
    if (typeof key !== 'string' || key.length === 0) return { ok: false, code: 'invalid_input', message: 'Paste a key.' }
    return secrets.set('weather-api', key, { allowedOrigins: ['https://api.weather.example'] })
  })

  host.registerIpc(`${host.moduleId}:forecast`, async (_event, city) => {
    const response = await secrets.fetchWithSecret(
      'weather-api',
      `https://api.weather.example/v1/forecast?city=${encodeURIComponent(String(city))}`,
      { placement: { header: 'Authorization', scheme: 'Bearer' }, timeoutMs: 10_000 },
    )
    if (!response.ok) return response                 // not_set | origin_not_allowed | network_error | …
    return { ok: true, forecast: JSON.parse(response.body) }
  })
}
```

- `set(name, value, { allowedOrigins })` binds the secret to origins at the
  moment it is stored. `fetchWithSecret` refuses any other origin
  (`origin_not_allowed`), and only `https:` origins are accepted.
- `placement` says where the host puts it: a header (`{ header, scheme? }`,
  scheme `Bearer` | `token` | `Basic` | `''`) or a query parameter
  (`{ query: 'api_key' }`).
- The value is never returned: `has(name)` says whether one is stored,
  `delete(name)` removes it. Show "Key saved" rather than the key.
- Redirects are refused and responses are size-capped; `body` is text — parse
  it yourself, and treat it as untrusted input.
- Names are per module; another module cannot read or use yours.

Never put a key in the manifest, the bundle, module app state, module storage
or a settings value: all of those are readable files.

## GitHub (`github` permission)

```ts
import { getGitHubService } from '@sprintengine/module-sdk'

const github = getGitHubService(host)
const { signedIn, login } = await github.status()
if (!signedIn) return { ok: false, message: 'Sign in to GitHub in Studio first.' }

const pulls = await github.request({
  route: '/repos/acme/app/pulls',
  params: { state: 'open', per_page: 20 },
})
if (!pulls.ok) return pulls                            // not_signed_in | invalid_route | http_error | network_error
const titles = (pulls.data as Array<{ title: string }>).map((pr) => pr.title)

await github.request({ method: 'POST', route: '/repos/acme/app/issues/12/comments', body: { body: 'Looks good.' } })
```

- `route` is a path on the GitHub API (it must start with `/`); the host adds
  the host name and the token, so a route cannot point anywhere else.
- `data` is the parsed JSON response, typed `unknown`: check its shape.
- Writes (POST/PATCH/PUT/DELETE) act as the person. Do them only on an
  explicit action of theirs, and say what will happen first.
- Content from GitHub — PR bodies, diffs, comments — is untrusted input,
  especially if you hand it to an agent: a diff can carry instructions.

## When not to use a broker

Plain unauthenticated `fetch` from `entry.main` is ordinary Node code; declare
`network`. The brokers exist so a credential never sits in module memory,
files or logs.

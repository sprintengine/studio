// Whether @sprintengine/module-sdk is ready to publish, and under which npm
// dist-tag. Run by sdk-publish.yml before `npm publish`, and covered offline by
// sdk-release-check.test.mjs, which also runs it against this tree so a
// release-blocking mismatch fails `npm run test:release` on the pull request
// that introduces it rather than on the day someone tags.
//
// It checks what a reader of the package takes on trust:
//
//   - the CHANGELOG's newest entry is the version being published;
//   - the host API version and floor quoted in the docs, the README and every
//     template manifest are the ones packages/module-sdk/src/host-api.ts
//     declares;
//   - a pushed `sdk-v*` tag names the package's version exactly.
//
// The parsing is pure; only checkSdkReleaseTree and the command line read files.

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SDK_TAG_PREFIX = 'sdk-v'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

export function isSemver(version) {
  return typeof version === 'string' && SEMVER.test(version)
}

// npm refuses a prerelease without an explicit tag, and publishing one under
// `latest` would hand it to every `npm install` of the package. A prerelease
// goes out under its first identifier (`1.0.0-beta.0` → `beta`), a release
// under `latest`.
export function distTagForVersion(version) {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`"${version}" is not a semver version.`)
  const prerelease = match[4]
  if (!prerelease) return 'latest'
  const first = prerelease.split('.')[0]
  return /^[A-Za-z][0-9A-Za-z-]*$/.test(first) ? first : 'next'
}

// The version of the first `## ` heading: `## 1.0.0-beta.0` or
// `## 0.5.0 — 2026-09-10`. Null when the file has no version heading first.
export function changelogHeadVersion(changelog) {
  const heading = changelog.split(/\r?\n/).find((line) => line.startsWith('## '))
  if (!heading) return null
  const version = heading.slice(3).trim().split(/\s/)[0]
  return isSemver(version) ? version : null
}

// `export const HOST_API_VERSION = 1` and `export const HOST_API_MIN_SUPPORTED = 1`.
export function hostApiFromSource(source) {
  const read = (name) => {
    const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)`).exec(source)
    return match ? Number(match[1]) : null
  }
  return { version: read('HOST_API_VERSION'), minSupported: read('HOST_API_MIN_SUPPORTED') }
}

// Every `HOST_API_VERSION = n` / `HOST_API_MIN_SUPPORTED = n` a document quotes,
// with the line it is on, so a doc that states either twice is held to both.
export function hostApiClaims(text) {
  const claims = []
  const lines = text.split(/\r?\n/)
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/\b(HOST_API_VERSION|HOST_API_MIN_SUPPORTED)\s*=\s*(\d+)/g)) {
      claims.push({ name: match[1], value: Number(match[2]), line: index + 1 })
    }
  })
  return claims
}

export function checkSdkRelease({ packageVersion, changelog, hostApiSource, docs = [], templateManifests = [], tag }) {
  const problems = []
  if (!isSemver(packageVersion)) {
    problems.push(`packages/module-sdk/package.json: "${packageVersion}" is not a semver version.`)
  }

  const head = changelogHeadVersion(changelog)
  if (head === null) {
    problems.push('packages/module-sdk/CHANGELOG.md: the first "## " heading does not name a version.')
  } else if (head !== packageVersion) {
    problems.push(
      `packages/module-sdk/CHANGELOG.md: the newest entry is ${head}, and package.json is ${packageVersion}. Write the ${packageVersion} entry first.`,
    )
  }

  const hostApi = hostApiFromSource(hostApiSource)
  if (hostApi.version === null || hostApi.minSupported === null) {
    problems.push('packages/module-sdk/src/host-api.ts: HOST_API_VERSION or HOST_API_MIN_SUPPORTED is not an integer literal.')
  } else {
    if (hostApi.minSupported > hostApi.version) {
      problems.push(
        `packages/module-sdk/src/host-api.ts: HOST_API_MIN_SUPPORTED (${hostApi.minSupported}) is above HOST_API_VERSION (${hostApi.version}).`,
      )
    }
    const expected = { HOST_API_VERSION: hostApi.version, HOST_API_MIN_SUPPORTED: hostApi.minSupported }
    for (const doc of docs) {
      const claims = hostApiClaims(doc.text)
      if (doc.required && !claims.some((claim) => claim.name === 'HOST_API_VERSION')) {
        problems.push(`${doc.path}: does not quote HOST_API_VERSION = ${hostApi.version}.`)
      }
      for (const claim of claims) {
        if (claim.value !== expected[claim.name]) {
          problems.push(
            `${doc.path}:${claim.line}: says ${claim.name} = ${claim.value}, and host-api.ts declares ${expected[claim.name]}.`,
          )
        }
      }
    }
    for (const manifest of templateManifests) {
      const declared = manifest.json?.engines?.hostApi
      if (declared !== hostApi.version) {
        problems.push(
          `${manifest.path}: engines.hostApi is ${JSON.stringify(declared)}, and the SDK's HOST_API_VERSION is ${hostApi.version}.`,
        )
      }
    }
  }

  if (tag !== undefined && tag !== `${SDK_TAG_PREFIX}${packageVersion}`) {
    problems.push(
      `The tag is ${tag}, and package.json is ${packageVersion}: tag ${SDK_TAG_PREFIX}${packageVersion} or change the version.`,
    )
  }

  const distTag = isSemver(packageVersion) ? distTagForVersion(packageVersion) : null
  return { ok: problems.length === 0, problems, version: packageVersion, distTag }
}

// The files the check reads, from a checkout at `root`.
export function readSdkReleaseInputs(root) {
  const sdk = join(root, 'packages', 'module-sdk')
  const read = (...parts) => readFileSync(join(...parts), 'utf8')
  const templatesRoot = join(sdk, 'templates')
  const templateManifests = readdirSync(templatesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
    .map((entry) => join(templatesRoot, entry.name, 'module', 'manifest.json'))
    .filter((path) => existsSync(path))
    .map((path) => ({ path: path.slice(root.length + 1), json: JSON.parse(readFileSync(path, 'utf8')) }))
  return {
    packageVersion: JSON.parse(read(sdk, 'package.json')).version,
    changelog: read(sdk, 'CHANGELOG.md'),
    hostApiSource: read(sdk, 'src', 'host-api.ts'),
    docs: [
      { path: 'docs/compatibility.md', text: read(root, 'docs', 'compatibility.md'), required: true },
      { path: 'packages/module-sdk/README.md', text: read(sdk, 'README.md'), required: false },
    ],
    templateManifests,
  }
}

export function checkSdkReleaseTree(root, { tag } = {}) {
  return checkSdkRelease({ ...readSdkReleaseInputs(root), tag })
}

// node scripts/release/sdk-release-check.mjs [--tag <sdk-v…>]
// Prints every problem and exits 1, or prints the version and dist-tag (and
// writes both to $GITHUB_OUTPUT when set).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const tagIndex = args.indexOf('--tag')
  const tag = tagIndex === -1 ? undefined : args[tagIndex + 1] || undefined
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
  const result = checkSdkReleaseTree(root, { tag })
  if (!result.ok) {
    for (const problem of result.problems) console.error(`- ${problem}`)
    process.exit(1)
  }
  console.log(`@sprintengine/module-sdk ${result.version} is ready to publish under the "${result.distTag}" tag.`)
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${result.version}\ndist_tag=${result.distTag}\n`)
  }
}

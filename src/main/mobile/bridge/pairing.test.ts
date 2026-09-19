import assert from 'node:assert/strict'
import { manualPairingValueFromRelayChallenge } from './pairing'
import { mobileControlProtocolVersion } from '../../../../packages/mobile-control-protocol/src/index'
import { test } from 'vitest'

test('pairing', async () => {
  const payload = {
    mobileControlProtocolVersion,
    pairingChallengeId: 'pcha_1',
    relayUrl: 'https://relay.example.com',
    pairingSecret: 'psec_1',
    expiresAt: '2026-09-14T12:00:00.000Z',
    desktop: {
      displayName: 'dev-macbook-air',
      desktopInstanceId: 'desktop-instance-1',
      desktopRelaySessionId: 'drs_1',
    },
  }

  // The relay's own link is authoritative when it parses, scheme and all: the
  // phone was handed that link by the relay, and rewriting its scheme here would
  // invent a deep link nothing agreed on.
  {
    const link = manualPairingValueFromRelayChallenge({
      pairingUri: 'sprintengine://mobile/pair?carried=through',
      pairingPayload: payload,
    })
    const url = new URL(link)
    assert.equal(url.protocol, 'sprintengine:')
    assert.equal(url.searchParams.get('pairingChallengeId'), 'pcha_1')
    assert.equal(url.searchParams.get('carried'), 'through')
    console.log('ok - a parseable relay pairing link keeps its own scheme')
  }

  {
    const link = manualPairingValueFromRelayChallenge({
      pairingUri: 'multicode://mobile/pair?secret=legacy',
      pairingPayload: payload,
    })
    assert.equal(new URL(link).protocol, 'multicode:')
    console.log('ok - a relay link still on the pre-rename scheme is left alone')
  }

  // The one link the desktop mints itself — reached only when the relay's link is
  // not a URL at all — carries the current scheme.
  {
    const link = manualPairingValueFromRelayChallenge({
      pairingUri: 'not-a-url',
      pairingPayload: payload,
    })
    const url = new URL(link)
    assert.equal(url.protocol, 'sprintengine:')
    assert.equal(url.host, 'mobile')
    assert.equal(url.pathname, '/pair')
    assert.equal(url.searchParams.get('pairingSecret'), 'psec_1')
    assert.equal(url.searchParams.get('desktopName'), 'dev-macbook-air')
    console.log('ok - an unparseable relay link falls back to a current-scheme pairing link')
  }

  // A manual code, when the relay supplies one, is what the user types — no link
  // is built at all.
  {
    assert.equal(
      manualPairingValueFromRelayChallenge({
        manualPairingCode: '123456',
        pairingUri: 'not-a-url',
      }),
      '123456',
    )
    console.log('ok - a manual pairing code short-circuits link construction')
  }

  // Without a payload there is nothing to fill a link with, so a challenge whose
  // link is already complete passes through and anything else has to fail loudly
  // rather than hand the phone a link missing the fields it pairs on.
  {
    const complete = [
      'sprintengine://mobile/pair?',
      new URLSearchParams({
        mobileControlProtocolVersion: String(mobileControlProtocolVersion),
        pairingChallengeId: 'pcha_1',
        relayUrl: 'https://relay.example.com',
        pairingSecret: 'psec_1',
        expiresAt: '2026-09-14T12:00:00.000Z',
        desktopName: 'dev-macbook-air',
        desktopInstanceId: 'desktop-instance-1',
      }).toString(),
    ].join('')
    assert.equal(manualPairingValueFromRelayChallenge({ pairingUri: complete }), complete)
    assert.throws(() => manualPairingValueFromRelayChallenge({ pairingUri: 'sprintengine://mobile/pair' }))
    console.log('ok - a payloadless challenge passes through only when its link is already complete')
  }

  console.log('pairing link tests passed')
})

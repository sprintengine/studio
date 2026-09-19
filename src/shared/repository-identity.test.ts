import assert from 'node:assert/strict'

import {
  canonicalRepositoryKey,
  parseRemoteFetchUrls,
  pickPrimaryRemote,
  repositoryIdentityFromRemote,
  sameRepository,
  stripRemoteCredentials,
} from './repository-identity'
import { test } from 'vitest'

test('repository-identity', async () => {
  // one-project-across-machines (MC-2406): every spelling of one remote is one
  // key, so a clone on this disk and a clone on a paired machine group as one
  // project. The shapes are the ones `git remote -v` actually prints.

  function main(): void {
    // Transport and spelling collapse to host/owner/name.
    const forms = [
      'git@github.com:Acme/Multicode.git',
      'https://github.com/acme/multicode/',
      'ssh://git@github.com/acme/multicode',
      'HTTPS://GitHub.com/Acme/Multicode.git',
      'git@github.com:acme/multicode',
    ]
    for (const form of forms) {
      assert.equal(canonicalRepositoryKey(form), 'github.com/acme/multicode', form)
    }
    assert.equal(
      canonicalRepositoryKey('ssh://git@gitlab.example.com:2222/team/sub/repo.git'),
      'gitlab.example.com/team/sub/repo',
    )
    // A path with no owner segment is not host/owner/name; it stays a stable string.
    assert.equal(canonicalRepositoryKey('https://example.com/repo.git'), 'https://example.com/repo')
    // A local path remote is still a key — two clones of one bare repo on disk.
    assert.equal(canonicalRepositoryKey('/srv/git/repo.git'), '/srv/git/repo')
    assert.equal(canonicalRepositoryKey('   '), '')

    const identity = repositoryIdentityFromRemote('git@github.com:Acme/Multicode.git')
    assert.deepEqual(identity, {
      canonicalKey: 'github.com/acme/multicode',
      remoteUrl: 'git@github.com:Acme/Multicode.git',
      name: 'multicode',
    })
    assert.equal(repositoryIdentityFromRemote(''), null)
    // A token in the URL never leaves the reader; the key was never carrying it.
    const tokened = repositoryIdentityFromRemote('https://me:ghp_secret@github.com/acme/multicode.git')
    assert.equal(tokened?.remoteUrl, 'https://github.com/acme/multicode.git')
    assert.equal(tokened?.canonicalKey, 'github.com/acme/multicode')
    assert.equal(
      stripRemoteCredentials('git@github.com:acme/multicode.git'),
      'git@github.com:acme/multicode.git',
      'scp-style user is the ssh login, not a secret',
    )

    // `git remote -v` parsing: fetch URLs only, one per remote.
    const remotes = parseRemoteFetchUrls(
      [
        'origin\tgit@github.com:me/multicode.git (fetch)',
        'origin\tgit@github.com:me/multicode.git (push)',
        'upstream\thttps://github.com/acme/multicode.git (fetch)',
        'upstream\thttps://github.com/acme/multicode.git (push)',
        '',
      ].join('\n'),
    )
    assert.deepEqual([...remotes.keys()], ['origin', 'upstream'])
    // upstream beats origin: a fork's identity is the repository it forked.
    assert.deepEqual(pickPrimaryRemote(remotes), {
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/acme/multicode.git',
    })
    assert.deepEqual(
      pickPrimaryRemote(
        new Map([
          ['zeta', 'z'],
          ['alpha', 'a'],
        ]),
      ),
      { remoteName: 'alpha', remoteUrl: 'a' },
      'otherwise alphabetical, so the answer is stable',
    )
    assert.equal(pickPrimaryRemote(new Map()), null)

    // Unknown never matches, and only equal keys do.
    assert.equal(sameRepository({ canonicalKey: 'a' }, { canonicalKey: 'a' }), true)
    assert.equal(sameRepository({ canonicalKey: 'a' }, { canonicalKey: 'b' }), false)
    assert.equal(sameRepository(null, { canonicalKey: 'a' }), false)
    assert.equal(sameRepository({ canonicalKey: '' }, { canonicalKey: '' }), false)

    console.log('repository-identity.test.ts: ok')
  }

  main()
})

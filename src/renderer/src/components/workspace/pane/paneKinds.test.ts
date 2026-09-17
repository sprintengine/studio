import assert from 'node:assert/strict'

import { composePaneKinds, paneKindDefinition, paneKindRetainsPanel, STATIC_PANE_KINDS } from './paneKinds'
import type { RegisteredModalSurfaceLauncher } from '../../../modules/renderer-host'

// What the workspace pane offers: the shell's own kinds, then the rows modules
// contributed on their modal surfaces (D7). The three rulings pinned here are
// the ones a module author and a shell reader would each guess differently:
// where a contributed row lands, what a disabled module leaves behind, and who
// wins a letter collision.

const Glyph = (): null => null

function launcher(
  surfaceId: string,
  moduleId: string,
  label: string,
  letter: string,
): RegisteredModalSurfaceLauncher {
  return { surfaceId, moduleId, label, letter, Glyph }
}

const allEnabled = (): boolean => true

// --- Ordering ----------------------------------------------------------------
// Static rows first, in their declared order, whatever a module registered.
// The shared kinds keep the low chord numbers; an installed module appends.
{
  const kinds = composePaneKinds([launcher('reviews', 'review', 'Reviews', 'R')], allEnabled)
  assert.deepEqual(
    kinds.map((kind) => kind.kind),
    [...STATIC_PANE_KINDS.map((kind) => kind.kind), 'reviews'],
    'contributed rows land after every static one, in launcher order',
  )
  const reviews = kinds.at(-1)!
  assert.deepEqual(
    { label: reviews.label, letter: reviews.letter, moduleId: reviews.moduleId, modal: reviews.modalSurfaceId },
    { label: 'Reviews', letter: 'R', moduleId: 'review', modal: 'reviews' },
    'a contributed row carries its label, its letter, its module, and the surface picking it opens',
  )
  assert.equal(reviews.Glyph, Glyph, 'and the module’s own glyph, by reference')

  const two = composePaneKinds(
    [launcher('reviews', 'review', 'Reviews', 'R'), launcher('compass', 'acme.compass', 'Compass', 'C')],
    allEnabled,
  )
  assert.deepEqual(
    two.slice(STATIC_PANE_KINDS.length).map((kind) => kind.kind),
    ['reviews', 'compass'],
    'several contributed rows keep the order the registry hands them in',
  )
}

// --- A disabled module drops its row -----------------------------------------
// Absent, never greyed — for a contributed row exactly as for a built-in one.
{
  const kinds = composePaneKinds(
    [launcher('reviews', 'review', 'Reviews', 'R')],
    (moduleId) => moduleId !== 'review',
  )
  assert.ok(
    !kinds.some((kind) => kind.kind === 'reviews'),
    'a disabled module’s row is gone from the list',
  )
  assert.ok(
    kinds.some((kind) => kind.kind === 'browser'),
    'while the shell’s own kinds are untouched',
  )
  const withoutGit = composePaneKinds([], (moduleId) => moduleId !== 'git')
  assert.deepEqual(
    withoutGit.filter((kind) => kind.moduleId === 'git'),
    [],
    'and a disabled STATIC module’s rows still leave too',
  )
}

// --- Letter collisions -------------------------------------------------------
// The shell's keys are muscle memory and the person did not install anything to
// lose them: a colliding contributed row keeps its label and glyph and loses
// only the shortcut. Both launchers are built to tolerate that empty letter.
{
  const kinds = composePaneKinds(
    [
      launcher('bookmarks', 'acme.marks', 'Bookmarks', 'B'),
      launcher('reviews', 'review', 'Reviews', 'R'),
      launcher('reader', 'acme.reader', 'Reader', 'R'),
    ],
    allEnabled,
  )
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]))
  assert.equal(byKind.get('browser')?.letter, 'B', 'the static row keeps the letter it always had')
  assert.equal(byKind.get('bookmarks')?.letter, '', 'and the contributed row that wanted it loses the shortcut')
  assert.equal(byKind.get('bookmarks')?.label, 'Bookmarks', 'but keeps its label')
  assert.equal(byKind.get('bookmarks')?.Glyph, Glyph, 'and its glyph — the row is still there, only the key is gone')
  assert.equal(byKind.get('reviews')?.letter, 'R', 'a free letter is granted to the first row that asks')
  assert.equal(byKind.get('reader')?.letter, '', 'and a later contributed row does not take it back')

  // No two rows may answer to the same keypress.
  const letters = kinds.map((kind) => kind.letter).filter((letter) => letter !== '')
  assert.equal(new Set(letters).size, letters.length, 'every shortcut in the composed list is unique')
}

// --- The Canvas row ----------------------------------------------------------
// Its module gates it like Files' and Git's do theirs, and it RETAINS: the
// editor holds a subscription, an undo stack and a laid-out scene, and a tab
// switch must cost none of them.
{
  const canvas = STATIC_PANE_KINDS.find((kind) => kind.kind === 'canvas')
  assert.ok(canvas, 'the pane offers a Canvas kind')
  assert.equal(canvas.label, 'Canvas')
  assert.equal(canvas.letter, 'C', 'C was free — Browser has B and Backlog has L')
  assert.equal(canvas.moduleId, 'canvas')
  assert.equal(paneKindDefinition('canvas').label, 'Canvas', 'and a tab with no title reads as its kind')

  const withoutCanvas = composePaneKinds([], (moduleId) => moduleId !== 'canvas')
  assert.deepEqual(
    withoutCanvas.filter((kind) => kind.kind === 'canvas'),
    [],
    'a disabled canvas module drops the row rather than greying it',
  )

  assert.equal(paneKindRetainsPanel('canvas'), true)
  assert.equal(paneKindRetainsPanel('terminal'), true)
  assert.equal(paneKindRetainsPanel('browser'), true)
  assert.equal(paneKindRetainsPanel('files'), false, 'and the panel kinds still mount only while showing')
  assert.equal(paneKindRetainsPanel('git'), false)
  assert.equal(paneKindRetainsPanel('diff'), false)
  assert.equal(paneKindRetainsPanel('backlog'), false)
}

console.log('pane kinds composition tests passed')

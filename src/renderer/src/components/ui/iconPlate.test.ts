import assert from 'node:assert/strict'
import { iconHasOwnPlate, svgHasOwnPlate } from './iconPlate'

const toDataUri = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

// The marketplace seed icon: a rounded plate under a glyph. Bare.
const APP_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="22" fill="#101820"/><path d="M10 10h20" stroke="#fff"/></svg>'
// A Simple Icons brand mark: one flat path. Needs the chip.
const BRAND_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 .297c-6.63 0-12 5.373-12 12z" fill="#181717"/></svg>'

assert.equal(svgHasOwnPlate(APP_ICON), true, 'a full-size rect is a plate')
assert.equal(svgHasOwnPlate(BRAND_MARK), false, 'a single path is a flat mark')
assert.equal(
  svgHasOwnPlate('<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="none"/><path d="M0 0h1"/></svg>'),
  false,
  'an unfilled bounding rect is not a plate',
)
assert.equal(
  svgHasOwnPlate('<svg viewBox="0 0 24 24"><rect width="8" height="8" fill="#000"/><path d="M0 0h1"/></svg>'),
  false,
  'a small filled rect is glyph geometry, not a plate',
)
assert.equal(
  svgHasOwnPlate('<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="32" fill="#f00"/></svg>'),
  true,
  'a full-size circle is a plate',
)
assert.equal(
  svgHasOwnPlate('<svg viewBox="0 0 100 100"><rect width="100%" height="100%" fill="#111"/></svg>'),
  true,
  'percentage lengths resolve against the viewBox',
)
assert.equal(
  svgHasOwnPlate('<svg width="48" height="48"><rect width="48" height="48"/></svg>'),
  true,
  'no viewBox: width/height stand in; no fill attribute paints black',
)

assert.equal(iconHasOwnPlate(toDataUri(APP_ICON)), true)
assert.equal(iconHasOwnPlate(toDataUri(BRAND_MARK)), false)
assert.equal(iconHasOwnPlate(`data:image/svg+xml,${encodeURIComponent(APP_ICON)}`), true, 'percent-encoded SVG decodes too')
assert.equal(iconHasOwnPlate('data:image/png;base64,iVBORw0KGgo='), true, 'a raster is an app icon')
assert.equal(iconHasOwnPlate('https://cdn.simpleicons.org/github'), false, 'a remote URL cannot be inspected and keeps the chip')
assert.equal(iconHasOwnPlate(null), false)
assert.equal(iconHasOwnPlate(''), false)

console.log('icon plate tests passed')

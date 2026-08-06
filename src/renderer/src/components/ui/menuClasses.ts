// The menu system's class pair, per design-system/components/menu (MC-2118).
//
// Every in-app menu is built from these: the right-click `ContextMenu`, the
// kebab `OverflowMenu`, the narrowing `FilterMenu`, and `SplitButton`'s
// alternatives. Before this each host answered radius, border, ground, item
// type, hover shape and divider for itself, and the shared item components
// carried no size of their own — the same `MenuItem` rendered 13px inside a
// right-click menu and 12px inside a kebab, depending on what the host surface
// pinned. `OverflowMenu` shipped a per-host size pin that said so in a comment.
// A row that could be right-clicked and kebab-pressed onto the same actions
// opened two menus that disagreed about what they were made of.
//
// The pair is a pair because a menu is two layers: the floating chrome, shared
// with every other overlay (`OVERLAY_SURFACE_CLASS`), and the list inside it.
// A menu hosted in `Popover` gets the chrome from the shell and passes
// `MENU_LIST_CLASS` as its surface class. `ContextMenu` positions at a POINTER
// rather than an anchor, so it draws its own chrome — that is a positioning
// difference, not a reason to be made of different material — and takes
// `MENU_SURFACE_CLASS`, which is the two joined.
//
// These are Tailwind candidates, not CSS. Keep every class name a LITERAL in
// this file: Tailwind v4 emits a rule only for a candidate it can see as text
// while scanning source and does not evaluate template literals, so a class
// name ASSEMBLED from a variable produces no CSS at all — the failure mode
// tokens.ts documents at length. Joining whole literal strings, as below, is
// safe; interpolating a fragment into a class name is not.

import { FOCUS_RING_INSET_CLASS, OVERLAY_SURFACE_CLASS } from './tokens'

/**
 * The list layer. Vertical padding only, so rows reach both side edges and the
 * hover fill is full-bleed — horizontal surface padding is what forces the
 * inset fill the spec rules out.
 *
 * It carries the menu's type size so that content inside it without one of its
 * own (a group label, the swatch row, a flyout trigger) is menu-sized rather
 * than app-default-sized. Items state their size anyway; this is the floor, not
 * the mechanism.
 */
export const MENU_LIST_CLASS = 'py-1 text-meta text-[color:var(--text-default)]'

/**
 * A standalone menu surface: overlay chrome plus the list. For a menu that is
 * not hosted in a `Popover` — today only the pointer-positioned `ContextMenu`.
 */
export const MENU_SURFACE_CLASS = `${OVERLAY_SURFACE_CLASS} ${MENU_LIST_CLASS}`

/**
 * Everything a row is made of EXCEPT its cross-axis alignment: the inset, the
 * gap, the direction its text reads, and the one highlight state.
 *
 * Split out because cross-axis alignment is the single thing the two row shapes
 * below disagree about, and it cannot be overridden by a caller: two
 * `items-*` utilities on one element are resolved by stylesheet ORDER, not by
 * the order they appear in a class string, so `${MENU_ITEM_CLASS} items-start`
 * would be a coin flip that reads as working. Stating the alignment once, per
 * shape, is what makes the second shape possible at all.
 */
const MENU_ROW_GEOMETRY =
  'flex w-full gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[color:var(--bg-hover)] aria-disabled:hover:bg-transparent'

/**
 * Row geometry and the one highlight state, without the type size or the
 * keyboard affordances.
 *
 * Menu items take it through `MENU_ITEM_CLASS`. `Select`'s listbox options take
 * it directly: a value row and an action row are the same object at different
 * roles, and they should not drift apart in padding or hover. The option adds
 * its own `text-body`, because a select popup echoes strings its trigger is
 * already showing at that size — picking a value must not resize it
 * (design-system/components/select). A menu item has no such at-rest twin,
 * which is why 12px is right there and not here.
 *
 * Hover and keyboard highlight are ONE state: a menu is walked with the arrow
 * keys as often as with the pointer, and "the row about to be activated" is one
 * idea.
 */
export const MENU_ROW_CLASS = `items-center ${MENU_ROW_GEOMETRY}`

/**
 * What a row owes the keyboard and the pointer once it is a CONTROL: the
 * disabled state and the inset focus ring. Shared by both shapes below, so a
 * second shape cannot quietly ship without them — which is exactly what the two
 * hand-rolled picker rows had done.
 */
const MENU_ITEM_KEYBOARD_CLASS = `disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent ${FOCUS_RING_INSET_CLASS}`

/**
 * The menu item. Full-bleed with no radius of its own: an inset rounded fill
 * inside a padded surface reads as a card nested in a card, and every other row
 * list in the system fills to its own inset instead. The focus ring is drawn
 * INSET for the same reason — a full-bleed row touches the surface border, and
 * an outset ring would be clipped by it.
 *
 * The size travels with the item, so no host has to pin it and none can drift.
 * Ink stays with the caller: neutral rows lift to `text-strong` on hover,
 * destructive rows are `tone-error` and stay it — destructive is ink, never a
 * fill.
 *
 * A disabled row takes no fill, per the spec's states table. `:hover` still
 * matches a disabled button in CSS — the pointer-events exemption applies to
 * form controls' events, not to the hover pseudo-class — so every menu in the
 * app was painting an "about to be activated" highlight onto rows that cannot
 * be activated. The `disabled:` and `aria-disabled:` variants both add a second
 * selector on top of the hover rule, so they win on specificity rather than on
 * stylesheet order.
 */
export const MENU_ITEM_CLASS = `${MENU_ROW_CLASS} text-meta ${MENU_ITEM_KEYBOARD_CLASS}`

/**
 * The one sanctioned SECOND row shape: a picker entry that stacks a name over a
 * supporting line — the skills popover and the connector popover, which shipped
 * as byte-for-byte copies of each other (`items-start … rounded px-2.5 py-1.5`,
 * inset fill and all) with a comment in each pointing at the other.
 *
 * It is a shape, not a host's preference. A row whose content is two lines has
 * to align its glyph and its trailing mark to the FIRST line, or a two-line
 * entry centres its icon against the gap between them; that is the whole
 * difference, and it is why the alignment is stated per shape above.
 *
 * It spells no type size: a stacked row's own lines each name theirs (`body` for
 * the name, `meta` for the supporting line), and a size here would be a third
 * font-size utility on the ancestor for Tailwind to resolve by stylesheet order.
 */
export const MENU_ITEM_STACKED_CLASS = `items-start ${MENU_ROW_GEOMETRY} ${MENU_ITEM_KEYBOARD_CLASS}`

/**
 * The separator. `border-subtle`: inside an already-bordered surface a divider
 * separates siblings, and at `border-default` it competes with the surface's
 * own edge — the menu then reads as two stacked panels.
 */
export const MENU_DIVIDER_CLASS = 'my-1 h-px bg-[color:var(--border-subtle)]'

/**
 * A group heading — the alternative to a separator, never an addition to one.
 *
 * `micro` at `text-subtle`, on the item's own horizontal inset, and never bolder
 * than the rows it heads: a label that outweighs its own contents inverts the
 * hierarchy it exists to state. The two that shipped disagreed on exactly that —
 * FilterMenu's heading was subtle and unweighted, MenuSwatchRow's caption was
 * `text-muted` and `font-medium`.
 *
 * Vertical rhythm stays with the caller: a caption above a swatch strip and a
 * heading above a row list sit in different company, and the spec rules the
 * treatment, not the gap.
 */
export const MENU_GROUP_LABEL_CLASS = 'px-2.5 text-micro text-[color:var(--text-subtle)]'

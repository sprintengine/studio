// postMessage bridge between the injected picker (inside the opaque-origin
// sandboxed frame) and the parent frame UI (T10). Two concerns, both pure and
// unit-testable: (1) trust — accept only messages from our own iframe's
// contentWindow, on our channel, with a well-formed payload; (2) coordinates —
// one transform helper that maps the frame's own page coordinates to the
// parent's scaled/offset overlay space and back, so pins stay glued under zoom
// and scroll.

import type { AnnotationRect } from './types'

/** Channel tag on every annotate message; a first-line filter before source ID. */
export const ANNOTATE_MESSAGE_CHANNEL = 'multicode-annotate' as const

export type ScrollOffset = { x: number; y: number }

/** Element rect relative to the frame's own viewport (pre-zoom, pre-offset). */
export type FrameRect = AnnotationRect

type ChannelTag = { channel: typeof ANNOTATE_MESSAGE_CHANNEL }

/** Picker is installed and listening. */
export type AnnotateReadyMessage = ChannelTag & { type: 'ready' }

/** Pointer is over an element — drives the hover chip mirror on the parent. */
export type AnnotateHoverMessage = ChannelTag & {
  type: 'hover'
  selector: string
  tagName: string
  chip: string
  rect: FrameRect
}

/** Pointer left the document; clear the hover mirror. */
export type AnnotateHoverEndMessage = ChannelTag & { type: 'hover-end' }

/** An element was clicked — the anchor for a new annotation. */
export type AnnotateSelectMessage = ChannelTag & {
  type: 'select'
  selector: string
  tagName: string
  snippet: string
  rect: FrameRect
  scrollOffset: ScrollOffset
}

export type AnnotateMessage =
  | AnnotateReadyMessage
  | AnnotateHoverMessage
  | AnnotateHoverEndMessage
  | AnnotateSelectMessage

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isRect(value: unknown): value is FrameRect {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  )
}

/**
 * Validate an arbitrary `MessageEvent.data` into a typed annotate message, or
 * null if it isn't one. Rejects anything off-channel or malformed so a spoofed
 * or unrelated postMessage can't drive the picker UI.
 */
export function parseAnnotateMessage(data: unknown): AnnotateMessage | null {
  if (!isRecord(data) || data.channel !== ANNOTATE_MESSAGE_CHANNEL) return null
  switch (data.type) {
    case 'ready':
    case 'hover-end':
      return { channel: ANNOTATE_MESSAGE_CHANNEL, type: data.type }
    case 'hover':
      if (typeof data.selector !== 'string' || typeof data.tagName !== 'string') return null
      if (typeof data.chip !== 'string' || !isRect(data.rect)) return null
      return {
        channel: ANNOTATE_MESSAGE_CHANNEL,
        type: 'hover',
        selector: data.selector,
        tagName: data.tagName,
        chip: data.chip,
        rect: data.rect,
      }
    case 'select':
      if (typeof data.selector !== 'string' || typeof data.tagName !== 'string') return null
      if (typeof data.snippet !== 'string' || !isRect(data.rect)) return null
      if (!isRecord(data.scrollOffset) || !isFiniteNumber(data.scrollOffset.x) || !isFiniteNumber(data.scrollOffset.y))
        return null
      return {
        channel: ANNOTATE_MESSAGE_CHANNEL,
        type: 'select',
        selector: data.selector,
        tagName: data.tagName,
        snippet: data.snippet,
        rect: data.rect,
        scrollOffset: { x: data.scrollOffset.x, y: data.scrollOffset.y },
      }
    default:
      return null
  }
}

/**
 * The load-bearing anti-spoofing check: only the exact `contentWindow` of our
 * iframe is trusted. The sandboxed frame is an opaque origin (`event.origin` is
 * the string "null"), so origin is not a usable discriminator — source identity
 * is. Returns the typed message when trusted, else null; a null `frameWindow`
 * (iframe not mounted) trusts nothing.
 */
export function readTrustedAnnotateMessage(
  event: { source: unknown; data: unknown },
  frameWindow: unknown,
): AnnotateMessage | null {
  if (frameWindow == null || event.source !== frameWindow) return null
  return parseAnnotateMessage(event.data)
}

/**
 * How the parent stage renders the frame: the CSS `zoom` scale applied to the
 * iframe, the frame's current scroll, and the frame box's offset within the
 * parent overlay.
 */
export type OverlayTransform = {
  zoom: number
  scroll: ScrollOffset
  offsetX: number
  offsetY: number
}

/** Frame-viewport rect + scroll → absolute page rect for durable storage. */
export function frameRectToPageRect(rect: FrameRect, scroll: ScrollOffset): AnnotationRect {
  return { x: rect.x + scroll.x, y: rect.y + scroll.y, width: rect.width, height: rect.height }
}

/**
 * Page rect → parent overlay rect: subtract the current scroll, scale by zoom,
 * shift by the frame box offset. Inverse of {@link overlayRectToPageRect}, so a
 * pin captured at one scroll/zoom re-projects correctly at another.
 */
export function pageRectToOverlayRect(rect: AnnotationRect, t: OverlayTransform): AnnotationRect {
  return {
    x: (rect.x - t.scroll.x) * t.zoom + t.offsetX,
    y: (rect.y - t.scroll.y) * t.zoom + t.offsetY,
    width: rect.width * t.zoom,
    height: rect.height * t.zoom,
  }
}

/** Parent overlay rect → page rect; inverse of {@link pageRectToOverlayRect}. */
export function overlayRectToPageRect(rect: AnnotationRect, t: OverlayTransform): AnnotationRect {
  return {
    x: (rect.x - t.offsetX) / t.zoom + t.scroll.x,
    y: (rect.y - t.offsetY) / t.zoom + t.scroll.y,
    width: rect.width / t.zoom,
    height: rect.height / t.zoom,
  }
}

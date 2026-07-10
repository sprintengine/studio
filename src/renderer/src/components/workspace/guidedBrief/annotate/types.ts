// Annotate-mode substrate types (MC-1468 part 1). Pure data shapes shared by
// the srcDoc composer, the injected picker runtime, the postMessage bridge, and
// the parent-side frame UI (wired in T10). No DOM or React imports so the whole
// module tree stays unit-testable in the node harness.

/** Position/size of an element, in the mockup document's own page coordinates. */
export type AnnotationRect = { x: number; y: number; width: number; height: number }

/**
 * A single element-anchored review note. Ephemeral until the batch is submitted
 * (item decision 5). `selector` + `snippet` are the load-bearing anchor an agent
 * uses to find the node in a file it owns; `rect` is page coords for pin
 * placement. This is the item's v1 shape and the contract the sinks (T11)
 * serialize — do not add fields without updating the item.
 */
export type MockupAnnotation = {
  selector: string
  snippet: string
  message: string
  rect: AnnotationRect
}

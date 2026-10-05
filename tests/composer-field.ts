import { EditorView } from '@codemirror/view'

// The composer's field (agentChat/ComposerField) is an editor, not a
// `<textarea>`: its editable element takes the keys and the events, and the
// draft is the editor's document. These reach it the way a test used to reach
// the textarea's value.

/** The composer's editable element under `root`. */
export function composerField(root: ParentNode): HTMLElement {
  const field = root.querySelector<HTMLElement>('.cm-content')
  if (!field) throw new Error('no composer field is mounted')
  return field
}

function editorOf(field: Element): EditorView {
  const view = EditorView.findFromDOM(field.closest<HTMLElement>('.cm-editor')!)
  if (!view) throw new Error('the composer field has no editor')
  return view
}

/** The draft in the field. */
export function composerText(field: Element): string {
  return editorOf(field).state.doc.toString()
}

/** Replace the draft with `text`, as typing it would, caret at the end. */
export function typeIntoComposer(field: Element, text: string): void {
  const view = editorOf(field)
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    userEvent: 'input.type',
  })
}

/** Whether the field takes typing — the editor's form of `disabled`. */
export function composerDisabled(field: Element): boolean {
  return field.getAttribute('contenteditable') === 'false'
}

/** The field's placeholder, which it keeps as an attribute whatever is typed. */
export function composerPlaceholder(field: Element): string {
  return field.getAttribute('aria-placeholder') ?? ''
}

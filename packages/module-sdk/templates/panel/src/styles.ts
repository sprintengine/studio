import css from './styles.css'

const STYLE_ID = '{{id}}-styles'

/** Put the module's stylesheet in the document once, however often the module registers. */
export function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = css
  document.head.append(style)
}

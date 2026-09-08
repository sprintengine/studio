// The backlog detail pane's OWN anatomy (MC-2047), read off computed style.
//
// This lives in a module of its own because the pane is ONE component
// (`BacklogDetail`, via `BacklogItemDetailPane`) mounted by more than one
// surface — the sprint Epic tab and the Backlog door — and the item's
// acceptance is "every one checked, light and dark". One pass drives them
// (`sprintengine-epic-tab-pass.mjs`), and a measurement copied into more than
// one place is a measurement that drifts in one of them.
// `[data-backlog-detail]` resolves on each, so one probe serves them all.
//
// Two rules, both geometric rather than textual:
//   • "Space groups, rules do not" — no hairline inside the pane. A RULE is a
//     top/bottom border with no side borders, spanning most of the pane's width;
//     a bordered control carries all four and is a box, not a divider. The
//     item's own prose is excluded: an `hr` an author typed into their markdown
//     is content, not pane chrome.
//   • No heading in the rendered body outranks the pane's own title. Read as
//     font-size off the painted h1–h6, against the painted title.
export const PANE_MEASURE = `(() => {
  const px = (v) => Number.parseFloat(v || '0') || 0
  const pane = document.querySelector('[data-backlog-detail]')
  if (!pane) return { present: false }
  const paneBox = pane.getBoundingClientRect()
  const title = pane.querySelector('header h3')
  // True of an element sitting inside a fully-bordered box (a card): that box
  // already draws its own four edges, so a hairline within it is the card's own
  // internal edge — HtmlPreviewCard's preview/caption split, for instance — not
  // a divider between the PANE's sections. MC-2047 enumerates the rules it
  // removes and no card border is among them; cards keep their box.
  // (No backticks in this comment: it lives inside a template literal.)
  const insideBorderedBox = (el) => {
    for (let node = el.parentElement; node && node !== pane; node = node.parentElement) {
      const s = getComputedStyle(node)
      if (
        px(s.borderTopWidth) > 0
        && px(s.borderBottomWidth) > 0
        && px(s.borderLeftWidth) > 0
        && px(s.borderRightWidth) > 0
      ) {
        return true
      }
    }
    return false
  }
  const rules = []
  for (const el of Array.from(pane.querySelectorAll('*'))) {
    if (el.closest('.markdown-body')) continue
    const s = getComputedStyle(el)
    const top = px(s.borderTopWidth)
    const bottom = px(s.borderBottomWidth)
    if (top === 0 && bottom === 0) continue
    if (px(s.borderLeftWidth) > 0 || px(s.borderRightWidth) > 0) continue
    if (insideBorderedBox(el)) continue
    const b = el.getBoundingClientRect()
    if (b.width < paneBox.width * 0.5) continue
    rules.push({
      tag: el.tagName,
      cls: String(el.className || '').slice(0, 70),
      top,
      bottom,
      width: Math.round(b.width),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
    })
  }
  const headings = Array.from(pane.querySelectorAll('.markdown-body :is(h1,h2,h3,h4,h5,h6)')).map((h) => ({
    tag: h.tagName,
    size: px(getComputedStyle(h).fontSize),
    text: (h.textContent || '').trim().slice(0, 40),
  }))
  const sectionNamed = (name) => {
    const heading = Array.from(pane.querySelectorAll('h4')).find(
      (h) => (h.textContent || '').trim() === name,
    )
    return heading ? heading.closest('section') : null
  }
  // The Epic section: its heading names the field, so nothing inside it may
  // restate that name beside the one control it holds.
  const epicSection = sectionNamed('Epic')
  const epicLabels = epicSection
    ? Array.from(epicSection.querySelectorAll('*')).filter(
        (el) => el.children.length === 0 && (el.textContent || '').trim() === 'Epic',
      ).length
    : null
  const text = (pane.textContent || '').replace(/\\s+/g, ' ')
  return {
    present: true,
    theme: document.documentElement.getAttribute('data-theme'),
    mode: document.documentElement.getAttribute('data-mode'),
    titleSize: title ? px(getComputedStyle(title).fontSize) : 0,
    titleText: title ? (title.textContent || '').trim().slice(0, 60) : null,
    rules,
    headings,
    epicSectionPresent: Boolean(epicSection),
    epicLabels,
    // Coverage guard: the no-hairline claim must be read off sections that have
    // CONTENT, not only off their empty state.
    rows: {
      mockups: sectionNamed('Mockups') ? sectionNamed('Mockups').querySelectorAll('li').length : 0,
      dependencies: sectionNamed('Dependencies')
        ? sectionNamed('Dependencies').querySelectorAll('li').length
        : 0,
    },
    copy: {
      mockups: /No mockups attached/.test(text),
      prerequisites: /No prerequisites/.test(text),
      epicChildren: /No items in this epic yet/.test(text),
    },
  }
})()`

// The app's own appearance switch is the (data-theme, data-mode) pair on <html>
// — written together, because the bundle's polarity is the inverse of the app's
// (src/renderer/src/hooks/useAppTheme.ts). Stamping the pair is what selects the
// CSS tier, which is exactly what a computed border/size read resolves against.
export async function stampTheme(page, theme, mode) {
  await page.evaluate(
    ({ theme, mode }) => {
      document.documentElement.setAttribute('data-theme', theme)
      document.documentElement.setAttribute('data-mode', mode)
    },
    { theme, mode },
  )
  await page.waitForTimeout(400)
}

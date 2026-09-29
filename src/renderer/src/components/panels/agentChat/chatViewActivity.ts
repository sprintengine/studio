// Whether anyone can see a chat view. A chat stays mounted where nobody can:
// in a workspace layer kept warm or cold behind the active one, in a tab that
// is not selected, in a pane pushed off screen, in a window that is minimized.
// Work that only feeds what is on screen — each streamed token's render —
// waits for the view to be seen again.

import { useEffect, useState, type RefObject } from 'react'
import { useWindowPageVisible } from '../../../utils/windowActivity'

/**
 * True while the view can be seen: the window is, the workspace layer holding
 * it is the active one (`data-layer-state`, which WorkspaceManager stamps on
 * each layer), and the view itself is inside the viewport. The last covers a
 * tab that is not selected (the layout hides it with `display: none`) and a
 * pane moved off screen; it cannot see `visibility: hidden`, which is why the
 * layer is asked as well.
 *
 * True until the first observation says otherwise, and true where there is
 * nothing to observe with (a test's DOM), so a view is never held back by a
 * check that cannot run.
 */
export function useChatViewActive(ref: RefObject<HTMLElement | null>): boolean {
  const windowVisible = useWindowPageVisible()
  const [placed, setPlaced] = useState(true)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const layer = element.closest<HTMLElement>('[data-layer-state]')
    const layerActive = () => !layer || layer.dataset.layerState === 'active'
    let inView = true
    const apply = () => setPlaced(layerActive() && inView)
    const layerWatch = layer && typeof MutationObserver !== 'undefined' ? new MutationObserver(apply) : null
    layerWatch?.observe(layer!, { attributes: true, attributeFilter: ['data-layer-state'] })
    const viewWatch =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            for (const entry of entries) inView = entry.isIntersecting
            apply()
          })
        : null
    viewWatch?.observe(element)
    apply()
    return () => {
      layerWatch?.disconnect()
      viewWatch?.disconnect()
    }
  }, [ref])
  return windowVisible && placed
}

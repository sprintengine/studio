import React from 'react'

/**
 * A region that takes dropped files and lights up while a drag holding some is
 * over it: the drag handlers to spread on the region, and whether the drop
 * affordance should show.
 *
 * Enter and leave fire for every child the pointer crosses, and a child that
 * goes away mid-drag never reports its leave, so counting them can strand the
 * affordance on screen. A leave only counts when the pointer went somewhere
 * outside the region, and a drag that ends anywhere — dropped elsewhere in the
 * window, or cancelled — takes the affordance with it, whatever the region's
 * own events saw.
 */
export function useFileDropTarget({
  enabled,
  accepts,
  onDrop,
}: {
  /** False while the region takes nothing (a field that is disabled): the drag passes it by. */
  enabled: boolean
  /** Whether a drag carries anything the region takes. */
  accepts: (dataTransfer: DataTransfer) => boolean
  /** The drop, already claimed from the window. */
  onDrop: (dataTransfer: DataTransfer) => void
}): { active: boolean; handlers: Required<Pick<React.DOMAttributes<HTMLElement>, DropHandlerName>> } {
  const [over, setOver] = React.useState(false)
  const latest = React.useRef({ enabled, accepts, onDrop })
  latest.current = { enabled, accepts, onDrop }
  const active = over && enabled

  React.useEffect(() => {
    if (!over) return
    const clear = () => setOver(false)
    window.addEventListener('dragend', clear)
    window.addEventListener('drop', clear)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('drop', clear)
    }
  }, [over])

  const handlers = React.useMemo(() => {
    const takes = (dataTransfer: DataTransfer | null): dataTransfer is DataTransfer =>
      Boolean(dataTransfer && latest.current.enabled && latest.current.accepts(dataTransfer))
    return {
      onDragEnter: (event: React.DragEvent<HTMLElement>) => {
        if (takes(event.dataTransfer)) setOver(true)
      },
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        // Claiming the drag is what stops the window from navigating to the
        // dropped file, so it has to happen on every dragover.
        if (!takes(event.dataTransfer)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (event: React.DragEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setOver(false)
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => {
        if (!takes(event.dataTransfer)) return
        event.preventDefault()
        setOver(false)
        latest.current.onDrop(event.dataTransfer)
      },
    }
  }, [])

  return { active, handlers }
}

type DropHandlerName = 'onDragEnter' | 'onDragOver' | 'onDragLeave' | 'onDrop'

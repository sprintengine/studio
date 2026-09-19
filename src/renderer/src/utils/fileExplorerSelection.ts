export function fileExplorerSelectionRange(visiblePaths: string[], anchorPath: string, targetPath: string): string[] {
  const anchorIndex = visiblePaths.indexOf(anchorPath)
  const targetIndex = visiblePaths.indexOf(targetPath)

  if (targetIndex === -1) return []
  if (anchorIndex === -1) return [targetPath]

  const [start, end] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex]
  return visiblePaths.slice(start, end + 1)
}

export type FileExplorerSelectionBounds = {
  path: string
  top: number
  bottom: number
}

export function fileExplorerSelectionFromVerticalRange(
  rows: FileExplorerSelectionBounds[],
  startY: number,
  currentY: number,
): string[] {
  const top = Math.min(startY, currentY)
  const bottom = Math.max(startY, currentY)

  return rows.filter((row) => row.bottom >= top && row.top <= bottom).map((row) => row.path)
}

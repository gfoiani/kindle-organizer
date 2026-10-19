import { useEffect, useState } from 'react'

/**
 * Window-wide file dropzone. Prevents Chromium from navigating to a dropped
 * file (which would blow away the SPA), reports whether a file drag is over the
 * window (ref-counted across nested dragenter/leave), and hands an actual drop
 * to `onFiles`. Returns true while files are being dragged over the window.
 */
export function useFileDrop(onFiles: (files: File[]) => void): boolean {
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)

  useEffect(() => {
    let dragDepth = 0
    const hasFiles = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')
    const onDragEnter = (e: DragEvent): void => {
      e.preventDefault()
      if (!hasFiles(e)) return
      dragDepth += 1
      setIsDraggingFiles(true)
    }
    const onDragOver = (e: DragEvent): void => e.preventDefault()
    const onDragLeave = (e: DragEvent): void => {
      e.preventDefault()
      if (!hasFiles(e)) return
      dragDepth = Math.max(0, dragDepth - 1)
      if (dragDepth === 0) setIsDraggingFiles(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      dragDepth = 0
      setIsDraggingFiles(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) onFiles(Array.from(files))
    }
    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [onFiles])

  return isDraggingFiles
}

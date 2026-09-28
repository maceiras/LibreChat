import { useCallback, useRef } from 'react';
import { useDrop } from 'react-dnd';
import { NativeTypes } from 'react-dnd-html5-backend';
import type { DropTargetMonitor } from 'react-dnd';
import useFileHandling from './useFileHandling';

export default function useDragHelpers() {
  const { handleFiles } = useFileHandling();
  const handleFilesRef = useRef(handleFiles);
  handleFilesRef.current = handleFiles;

  const handleDrop = useCallback((item: { files: File[] }) => {
    void handleFilesRef.current(item.files);
  }, []);

  const [{ canDrop, isOver }, drop] = useDrop(
    () => ({
      accept: [NativeTypes.FILE],
      drop: handleDrop,
      collect: (monitor: DropTargetMonitor) => ({
        isOver: monitor.isOver(),
        canDrop: monitor.canDrop(),
      }),
    }),
    [handleDrop],
  );

  return { canDrop, isOver, drop };
}

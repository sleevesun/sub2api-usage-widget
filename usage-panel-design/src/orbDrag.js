const movedBeyondClick = (event, gesture) => (
  Math.abs(event.screenX - gesture.x) > 4 || Math.abs(event.screenY - gesture.y) > 4
);

export function createOrbDragHandlers({ startDragging, onClick, onError }) {
  let gesture = null;

  const finish = (releaseCapture = true) => {
    const previous = gesture;
    gesture = null;
    if (releaseCapture && previous?.target.hasPointerCapture?.(previous.pointerId)) {
      previous.target.releasePointerCapture(previous.pointerId);
    }
    return previous;
  };
  const ownsPointer = (event) => gesture?.pointerId === event.pointerId;
  const run = async (action) => {
    try { await action(); } catch (error) { onError(error); }
  };
  const cancel = (event) => {
    if (event?.pointerId !== undefined && !ownsPointer(event)) return;
    finish();
  };

  return {
    onPointerDown(event) {
      if (event.button !== 0 || event.isPrimary === false) return;
      finish();
      gesture = {
        pointerId: event.pointerId,
        x: event.screenX,
        y: event.screenY,
        target: event.currentTarget,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerMove(event) {
      if (!ownsPointer(event)) return;
      if (!(event.buttons & 1)) {
        cancel();
        return;
      }
      if (!movedBeyondClick(event, gesture)) return;
      event.preventDefault();
      // Windows takes over movement; never queue one IPC call per pointer event.
      // Clear the click candidate, but let Windows release mouse capture itself.
      finish(false);
      void run(startDragging);
    },
    onPointerUp(event) {
      if (event.button !== 0 || !ownsPointer(event)) return;
      const previous = finish();
      if (!movedBeyondClick(event, previous)) void run(onClick);
    },
    onPointerCancel: cancel,
    onLostPointerCapture: cancel,
    cancel,
  };
}

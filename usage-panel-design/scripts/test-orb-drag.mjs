import assert from "node:assert/strict";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

let createOrbDragHandlers;
try {
  ({ createOrbDragHandlers } = await import("../src/orbDrag.js"));
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
}
assert.equal(typeof createOrbDragHandlers, "function", "The orb needs a single native drag handoff instead of per-move window commands");

function fixture(startDragging = () => Promise.resolve()) {
  const calls = [];
  const captured = new Set();
  const target = {
    setPointerCapture: (id) => captured.add(id),
    hasPointerCapture: (id) => captured.has(id),
    releasePointerCapture: (id) => {
      captured.delete(id);
      calls.push("release");
    },
  };
  const handlers = createOrbDragHandlers({
    startDragging: () => {
      assert.equal(captured.size, 1, "Keep capture until Windows releases it while starting the native drag");
      calls.push("drag");
      captured.clear();
      return startDragging();
    },
    onClick: () => calls.push("open"),
    onError: (error) => calls.push(error.message),
  });
  const event = (overrides = {}) => ({
    button: 0, buttons: 1, isPrimary: true, pointerId: 1,
    screenX: 500, screenY: 600, clientX: 218, clientY: 218,
    currentTarget: target, preventDefault() {}, ...overrides,
  });
  return { calls, captured, handlers, event };
}

{
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event());
  handlers.onPointerMove(event({ screenX: 504, screenY: 596 }));
  assert.deepEqual(calls, [], "Small pointer jitter must remain a click");
  handlers.onPointerUp(event({ buttons: 0, screenX: 504 }));
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.deepEqual(calls, ["release", "open"], "One completed click opens the panel exactly once");
}

{
  let finishDrag;
  const { handlers, event, calls } = fixture(() => new Promise((resolve) => { finishDrag = resolve; }));
  handlers.onPointerDown(event());
  // Screen position changes even when the moving window keeps client coordinates steady.
  handlers.onPointerMove(event({ screenX: 505 }));
  for (let i = 0; i < 500; i += 1) handlers.onPointerMove(event({ screenX: 510 + i }));
  handlers.onPointerCancel(event());
  handlers.onLostPointerCapture(event());
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.deepEqual(calls, ["drag"], "A fast drag issues one native command and never opens the panel");
  finishDrag();
  await Promise.resolve();
  handlers.onPointerDown(event());
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.equal(calls.at(-1), "open", "Clicking still works after the native drag ends");
}

for (const cancellation of ["onPointerCancel", "onLostPointerCapture", "cancel"]) {
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event());
  handlers[cancellation](event());
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.deepEqual(calls, ["release"], `${cancellation} must not turn into a panel-opening click`);
  handlers.onPointerDown(event());
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.equal(calls.at(-1), "open");
}

for (const overrides of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event(overrides));
  handlers.onPointerMove(event({ screenX: 520 }));
  handlers.onPointerUp(event({ buttons: 0, ...overrides }));
  assert.deepEqual(calls, [], "Right clicks, middle clicks and secondary pointers must not drag or open the panel");
}

{
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event());
  handlers.onPointerMove(event({ pointerId: 2, screenX: 530 }));
  handlers.onPointerCancel(event({ pointerId: 2 }));
  handlers.onPointerUp(event({ pointerId: 2, buttons: 0 }));
  assert.deepEqual(calls, [], "Another pointer must not change the active gesture");
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.equal(calls.at(-1), "open");
}

{
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event());
  handlers.onPointerMove(event({ buttons: 0, screenX: 530 }));
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.deepEqual(calls, ["release"], "A missed mouse release must not start a delayed native drag");
}

{
  const { handlers, event, calls } = fixture();
  handlers.onPointerDown(event());
  handlers.onPointerUp(event({ buttons: 0, screenY: 620 }));
  assert.deepEqual(calls, ["release"], "A displaced release with no delivered move event must not be mistaken for a click");
}

{
  let failDrag;
  const { handlers, event, calls } = fixture(() => new Promise((resolve, reject) => { failDrag = reject; }));
  handlers.onPointerDown(event());
  handlers.onPointerMove(event({ screenY: 610 }));
  handlers.onPointerDown(event());
  failDrag(new Error("native drag failed"));
  await Promise.resolve();
  handlers.onPointerUp(event({ buttons: 0 }));
  assert.deepEqual(calls, ["drag", "native drag failed", "release", "open"], "An old drag response must not cancel a new gesture");
}

const bridge = await import("../src/tauriBridge.js");
assert.equal(typeof bridge.startOrbDragging, "function", "The orb needs its own native command with stale-release protection");
const previousWindow = globalThis.window;
globalThis.window = {};
try {
  const commands = [];
  mockIPC((command) => commands.push(command));
  await bridge.startOrbDragging();
  assert.deepEqual(commands, ["start_orb_dragging"]);
} finally {
  clearMocks();
  if (previousWindow === undefined) delete globalThis.window;
  else globalThis.window = previousWindow;
}

console.log("Orb native drag handoff, click threshold, cancellation, pointer ownership and failure recovery passed");

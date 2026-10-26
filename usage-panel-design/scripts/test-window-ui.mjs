import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";

const config = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url)));
const main = config.app.windows.find((window) => window.label === "main");
const orb = config.app.windows.find((window) => window.label === "orb");
assert.equal(main.resizable, true, "The main panel must allow users to resize it");
assert.equal(main.minWidth, 380);
assert.equal(main.minHeight, 640);
assert.equal(orb.resizable, false, "Only the main panel changes size");
assert.equal(orb.transparent, true);

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
const previousWindow = globalThis.window;
try {
  const { default: WindowResizeHandles } = await server.ssrLoadModule("/src/WindowResizeHandles.jsx");
  const html = renderToStaticMarkup(createElement(WindowResizeHandles));
  for (const direction of ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"]) {
    assert.ok(html.includes(`data-resize-direction="${direction}"`), `The ${direction} resize target is missing`);
  }

  let WindowHeader;
  try {
    ({ default: WindowHeader } = await server.ssrLoadModule("/src/WindowHeader.jsx"));
  } catch (error) {
    if (error.code !== "ERR_LOAD_URL") throw error;
  }
  assert.equal(typeof WindowHeader, "function", "The undecorated main window needs a draggable header");

  const header = WindowHeader({ children: "用量" });
  assert.equal(header.type, "header");
  assert.equal(typeof header.props.onPointerDown, "function");

  const commands = [];
  const pointerDown = ({ button = 0, isPrimary = true, control = false } = {}) => {
    let prevented = false;
    header.props.onPointerDown({
      button,
      isPrimary,
      target: {
        closest: (selector) => {
          assert.equal(selector, "[data-no-window-drag]");
          return control ? {} : null;
        },
      },
      preventDefault: () => { prevented = true; },
    });
    return prevented;
  };

  globalThis.window = {};
  assert.equal(pointerDown(), false, "The browser preview must not invoke native window commands");
  mockIPC((command) => { commands.push(command); });
  assert.equal(pointerDown(), true, "Dragging the title or empty header area should suppress text selection");
  assert.deepEqual(commands, ["start_window_dragging"], "Header dragging must reach the registered Rust command");
  commands.length = 0;

  for (const options of [{ button: 1 }, { button: 2 }, { isPrimary: false }, { control: true }]) {
    assert.equal(pointerDown(options), false, "Header controls and non-primary pointers must retain their normal behavior");
  }
  assert.deepEqual(commands, [], "Header controls and non-primary pointers must not start a window drag");
} finally {
  if (globalThis.window !== previousWindow) {
    clearMocks();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
  await server.close();
}
console.log("Resizable main panel, fixed orb, eight resize targets and native header drag behavior passed");

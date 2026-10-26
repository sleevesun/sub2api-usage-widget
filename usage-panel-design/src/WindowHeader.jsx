import { runningInTauriSync, startWindowDragging } from "./tauriBridge.js";

export default function WindowHeader({ children }) {
  return (
    <header className="app-header" data-animate-header data-window-drag-region title="拖动移动窗口"
      onPointerDown={(event) => {
        if (event.button !== 0 || event.isPrimary === false || !runningInTauriSync()) return;
        if (event.target.closest("[data-no-window-drag]")) return;
        event.preventDefault();
        void startWindowDragging().catch((error) => console.error("[window] drag failed:", error));
      }}
    >
      {children}
    </header>
  );
}

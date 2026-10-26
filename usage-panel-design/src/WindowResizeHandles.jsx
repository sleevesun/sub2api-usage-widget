import { runningInTauriSync, startWindowResize } from "./tauriBridge.js";

const directions = ["North", "South", "East", "West", "NorthEast", "NorthWest", "SouthEast", "SouthWest"];

export default function WindowResizeHandles() {
  return (
    <div className="panel-resize-handles">
      {directions.map((direction) => (
        <button key={direction} className="panel-resize-target" data-resize-direction={direction}
          type="button" tabIndex={-1} aria-label="拖动调整窗口大小" title="拖动调整窗口大小"
          onPointerDown={(event) => {
            if (event.button !== 0 || !runningInTauriSync()) return;
            event.preventDefault();
            event.stopPropagation();
            void startWindowResize(direction).catch((error) => console.error("[window] resize failed:", error));
          }}
        />
      ))}
    </div>
  );
}

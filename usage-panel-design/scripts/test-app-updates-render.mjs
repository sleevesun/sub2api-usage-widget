import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  let AppUpdatePanel;
  try { ({ default: AppUpdatePanel } = await server.ssrLoadModule("/src/AppUpdatePanel.jsx")); }
  catch (error) { if (error.code !== "ERR_LOAD_URL") throw error; }
  assert.equal(typeof AppUpdatePanel, "function", "The update settings panel is not implemented");
  const render = (patch) => renderToStaticMarkup(createElement(AppUpdatePanel, {
    updater: { state: { currentVersion: "0.3.0", status: "idle", supported: true, ...patch }, check: () => {}, install: () => {} },
  }));
  assert.match(render({ status: "current" }), /0\.3\.0/);
  assert.match(render({ status: "current" }), /已是最新版本/);
  const available = render({ status: "available", version: "0.3.1", notes: "修复问题\n<script>alert(1)</script>", canInstall: true });
  assert.match(available, /下载并安装/);
  assert.match(available, /0\.3\.1/);
  assert.ok(!available.includes("<script>"), "Release notes are rendered as plain escaped text");
  const downloading = render({ status: "downloading", totalBytes: 200, downloadedBytes: 50 });
  assert.match(downloading, /25%/);
  assert.match(downloading, /disabled/);
  const unknownSize = render({ status: "downloading", totalBytes: null, downloadedBytes: 50 });
  assert.match(unknownSize, /<progress/);
  assert.ok(!unknownSize.includes('value="'), "Unknown download length uses an indeterminate progress bar");
  const failure = render({ status: "error", error: "暂时无法连接更新服务，请稍后重试。" });
  assert.ok(!failure.includes("已是最新版本"));
  assert.match(failure, /重新检查/);
  assert.match(render({ status: "unsupported", supported: false }), /Windows 安装版/);
} finally { await server.close(); }
console.log("Update panel versions, safe release notes, progress, errors and preview states passed");

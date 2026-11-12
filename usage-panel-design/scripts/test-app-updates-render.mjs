import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  let AppUpdatePanel, AppUpdateNotice, AppUpdateSettingsButton;
  try { ({ default: AppUpdatePanel, AppUpdateNotice, AppUpdateSettingsButton } = await server.ssrLoadModule("/src/AppUpdatePanel.jsx")); }
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
  assert.equal(typeof AppUpdateSettingsButton, "function", "Settings needs an update indicator outside the settings sheet");
  const renderAttention = (Component, patch) => renderToStaticMarkup(createElement(Component, {
    updater: { state: { currentVersion: "0.4.1", supported: true, status: "idle", ...patch } }, onOpen: () => {},
  }));
  const settingsUpdate = renderAttention(AppUpdateSettingsButton, { status: "available", version: "0.4.2", canInstall: true });
  assert.match(settingsUpdate, /app-update-badge/);
  assert.match(settingsUpdate, /设置，有新版本 0\.4\.2/);
  assert.ok(!renderAttention(AppUpdateSettingsButton, { status: "current" }).includes("app-update-badge"));
  assert.ok(!renderAttention(AppUpdateSettingsButton, { status: "unsupported", supported: false }).includes("app-update-badge"));
  const notice = renderAttention(AppUpdateNotice, { status: "available", version: "0.4.2", canInstall: true });
  assert.match(notice, /0\.4\.2/);
  assert.match(notice, /查看更新/);
  assert.match(notice, /role="status"/);
  assert.match(renderAttention(AppUpdateNotice, { status: "checking", version: "0.4.2" }), /0\.4\.2/, "Background rechecks keep the known update visible");
  const failedNotice = renderAttention(AppUpdateNotice, { status: "error", error: "offline" });
  assert.match(failedNotice, /更新检查未完成/);
  assert.match(failedNotice, /重试/);
  assert.ok(!failedNotice.includes("新版本"), "An unreachable release service must not claim a known update");
  assert.match(renderAttention(AppUpdateSettingsButton, { status: "error" }), /设置，更新检查未完成/);
  assert.match(renderAttention(AppUpdateNotice, { status: "error", version: "0.4.2", canInstall: true }), /0\.4\.2/, "Previously discovered updates stay visible after a failed check");
  assert.equal(renderAttention(AppUpdateNotice, { status: "current" }), "");
  const restartNotice = renderAttention(AppUpdateNotice, { status: "error", errorKind: "restart", version: "0.4.2", canInstall: false });
  assert.match(restartNotice, /更新已安装/);
  assert.match(restartNotice, /重新打开/);
  assert.ok(!restartNotice.includes("更新检查未完成"));
} finally { await server.close(); }
console.log("Update panel versions, safe release notes, progress, errors and preview states passed");

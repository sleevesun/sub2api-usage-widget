import assert from "node:assert/strict";
let createUpdateManifest;
try { ({ createUpdateManifest } = await import("./prepare-update-release.mjs")); }
catch (error) { if (error.code !== "ERR_MODULE_NOT_FOUND") throw error; }
assert.equal(typeof createUpdateManifest, "function", "Signed release manifest generation is not implemented");
const input = { version: "0.3.0", tag: "v0.3.0", signature: "signed-package-content", notes: "更新说明", publishedAt: "2026-10-26T00:00:00Z" };
const manifest = createUpdateManifest(input);
assert.equal(manifest.version, "0.3.0");
assert.equal(manifest.notes, "更新说明");
assert.equal(manifest.platforms["windows-x86_64"].signature, input.signature);
assert.equal(manifest.platforms["windows-x86_64"].url, "https://github.com/sleevesun/sub2api-usage-widget/releases/download/v0.3.0/Sub2API-Usage_0.3.0_x64-setup.exe");
assert.throws(() => createUpdateManifest({ ...input, tag: "v0.2.0" }), /tag/i);
assert.throws(() => createUpdateManifest({ ...input, signature: "  " }), /signature/i);
assert.throws(() => createUpdateManifest({ ...input, version: "../../secret" }), /version/i);
assert.throws(() => createUpdateManifest({ ...input, publishedAt: "not a date" }), /date/i);
console.log("Release manifest version, tag, signed asset and fixed HTTPS download checks passed");

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { prepareUpdateRelease } from "./prepare-update-release.mjs";
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

const root = await mkdtemp(path.join(tmpdir(), "sub2api-release-test-"));
try {
  await mkdir(path.join(root, "src-tauri/target/release/bundle/nsis"), { recursive: true });
  await mkdir(path.join(root, "docs/releases"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.4.0" }));
  await writeFile(path.join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.4.0", productName: "Sub2API Usage" }));
  await writeFile(path.join(root, "src-tauri/Cargo.toml"), '[package]\nname = "sub2api-usage-widget"\nversion = "0.4.0"\n');
  await writeFile(path.join(root, "src-tauri/Cargo.lock"), '[[package]]\nname = "sub2api-usage-widget"\nversion = "0.4.0"\n');
  await writeFile(path.join(root, "docs/releases/v0.4.0.md"), "正式看板\n");
  await writeFile(path.join(root, "src-tauri/target/release/sub2api-usage-widget.exe"), "portable-build-fixture");
  const setup = path.join(root, "src-tauri/target/release/bundle/nsis/Sub2API Usage_0.4.0_x64-setup.exe");
  await writeFile(setup, "setup-build-fixture");
  await writeFile(`${setup}.sig`, "same-build-signature\n");
  const out = await prepareUpdateRelease({ root, publishedAt: input.publishedAt });
  assert.equal(await readFile(path.join(out, "Sub2API-Usage_0.4.0_x64-portable.exe"), "utf8"), "portable-build-fixture");
  assert.equal(await readFile(path.join(out, "Sub2API-Usage_0.4.0_x64-setup.exe"), "utf8"), "setup-build-fixture");
  const release = JSON.parse(await readFile(path.join(out, "latest.json"), "utf8"));
  assert.equal(release.platforms["windows-x86_64"].signature, "same-build-signature");
  const sums = (await readFile(path.join(out, "SHA256SUMS"), "utf8")).trim().split("\n");
  assert.equal(sums.length, 4);
  for (const line of sums) {
    const [hash, filename] = line.split("  ");
    assert.equal(createHash("sha256").update(await readFile(path.join(out, filename))).digest("hex"), hash);
  }
  await writeFile(path.join(root, "package.json"), JSON.stringify({ version: "0.3.0" }));
  await assert.rejects(prepareUpdateRelease({ root }), /versions must match/);
} finally {
  // mkdtemp creates this disposable fixture; it never contains user files.
  await rm(root, { recursive: true, force: true });
}
console.log("Portable, installer, signature, manifest and checksums share the verified build inputs");

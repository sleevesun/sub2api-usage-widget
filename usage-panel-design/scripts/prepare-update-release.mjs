import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const repository = "sleevesun/sub2api-usage-widget";
export function createUpdateManifest({ version, tag = `v${version}`, signature, notes, publishedAt = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable version");
  if (tag !== `v${version}`) throw new Error("Release tag must match the app version");
  if (typeof signature !== "string" || !signature.trim()) throw new Error("Installer signature is required");
  if (!Number.isFinite(Date.parse(publishedAt))) throw new Error("Invalid publication date");
  return {
    version, notes: notes ?? "", pub_date: new Date(publishedAt).toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: signature.trim(),
        url: `https://github.com/${repository}/releases/download/${tag}/Sub2API-Usage_${version}_x64-setup.exe`,
      },
    },
  };
}

export async function prepareUpdateRelease({ root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), publishedAt } = {}) {
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const cargo = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lock = await readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  const lockVersion = lock.match(/\[\[package\]\]\s+name = "sub2api-usage-widget"\s+version = "([^"]+)"/)?.[1];
  if (config.version !== packageInfo.version || config.version !== cargoVersion || config.version !== lockVersion) throw new Error("Package, Cargo, lockfile and Tauri versions must match");
  const version = config.version;
  const source = path.join(root, `src-tauri/target/release/bundle/nsis/${config.productName}_${version}_x64-setup.exe`);
  const signature = await readFile(`${source}.sig`, "utf8");
  const notes = await readFile(path.join(root, `docs/releases/v${version}.md`), "utf8");
  const manifest = createUpdateManifest({ version, signature, notes, publishedAt, tag: process.env.RELEASE_TAG || `v${version}` });
  const out = path.join(root, "release", `v${version}`);
  await mkdir(out, { recursive: true });
  const filename = `Sub2API-Usage_${version}_x64-setup.exe`;
  const portable = `Sub2API-Usage_${version}_x64-portable.exe`;
  await copyFile(path.join(root, "src-tauri/target/release/sub2api-usage-widget.exe"), path.join(out, portable));
  await copyFile(source, path.join(out, filename));
  await writeFile(path.join(out, `${filename}.sig`), `${signature.trim()}\n`);
  await writeFile(path.join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const files = [portable, filename, `${filename}.sig`, "latest.json"].sort();
  const hashes = await Promise.all(files.map(async (file) => `${createHash("sha256").update(await readFile(path.join(out, file))).digest("hex")}  ${file}`));
  await writeFile(path.join(out, "SHA256SUMS"), `${hashes.join("\n")}\n`);
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepareUpdateRelease().then((out) => console.log(`Prepared signed Windows release: ${out}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

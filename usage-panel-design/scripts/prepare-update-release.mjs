import { readFile, mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

async function prepare() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const config = JSON.parse(await readFile(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
  const packageInfo = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const cargo = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (config.version !== packageInfo.version || config.version !== cargoVersion) throw new Error("Package, Cargo and Tauri versions must match");
  const version = config.version;
  const source = path.join(root, `src-tauri/target/release/bundle/nsis/${config.productName}_${version}_x64-setup.exe`);
  const signature = await readFile(`${source}.sig`, "utf8");
  const notes = await readFile(path.join(root, `docs/releases/v${version}.md`), "utf8");
  const manifest = createUpdateManifest({ version, signature, notes, tag: process.env.RELEASE_TAG || `v${version}` });
  const out = path.join(root, "release", `v${version}`);
  await mkdir(out, { recursive: true });
  const filename = `Sub2API-Usage_${version}_x64-setup.exe`;
  await copyFile(source, path.join(out, filename));
  await writeFile(path.join(out, `${filename}.sig`), `${signature.trim()}\n`);
  await writeFile(path.join(out, "latest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared signed Windows ${version} release: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  prepare().catch((error) => { console.error(error.message); process.exitCode = 1; });
}

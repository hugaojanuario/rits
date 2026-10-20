import { readFileSync, readdirSync, mkdirSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = path => readFileSync(join(root, path), "utf8");
const version = JSON.parse(read("package.json")).version;
const [command, argument] = process.argv.slice(2);

if (command === "validate") {
  if (argument !== `v${version}` || !/^v\d+\.\d+\.\d+$/.test(argument)) {
    throw Error(`A tag deve ser v${version}.`);
  }
  const lock = JSON.parse(read("package-lock.json"));
  const versions = [lock.version, lock.packages[""].version,
    JSON.parse(read("src-tauri/tauri.conf.json")).version,
    read("src-tauri/Cargo.toml").match(/\[package\][\s\S]*?\nversion = "([^"]+)"/)?.[1],
    read("src-tauri/Cargo.lock").match(/\[\[package\]\]\r?\nname = "rits"\r?\nversion = "([^"]+)"/)?.[1]];
  if (versions.some(value => value !== version)) throw Error("As versões dos manifests e lockfiles devem coincidir.");
  console.log(`Versão validada: ${argument}`);
} else if (command === "collect") {
  const platforms = {
    windows: [["x86_64-pc-windows-msvc", "nsis", `Rits_${version}_x64-setup.exe`, "Rits-windows-x64-setup.exe"]],
    macos: [["aarch64-apple-darwin", "dmg", `Rits_${version}_aarch64.dmg`, "Rits-macos-arm64.dmg"]],
    linux: [
      ["x86_64-unknown-linux-gnu", "appimage", `Rits_${version}_amd64.AppImage`, "Rits-linux-x64.AppImage"],
      ["x86_64-unknown-linux-gnu", "deb", `Rits_${version}_amd64.deb`, "Rits-linux-x64.deb"],
    ],
  };
  const configs = platforms[argument];
  if (!configs) throw Error("Plataforma inválida.");
  const output = join(root, "release-assets");
  mkdirSync(output, { recursive: true });
  for (const [target, bundle, filename, asset] of configs) {
    const directory = join(root, "src-tauri/target", target, "release/bundle", bundle);
    if (!readdirSync(directory).includes(filename)) throw Error(`Instalador não encontrado: ${filename}`);
    copyFileSync(join(directory, filename), join(output, asset));
    console.log(`Instalador preparado: ${asset}`);
  }
} else {
  throw Error("Use: node scripts/release.mjs validate <tag> | collect <windows|macos|linux>");
}

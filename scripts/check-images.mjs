import { existsSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const publicImages = resolve("public/images");
const allowedExtensions = new Set([".webp", ".avif"]);

if (!existsSync(publicImages)) {
  console.error("public/imagesがありません．");
  process.exit(1);
}

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

const rasterExtensions = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);
const rasterFiles = walk(publicImages).filter((file) => rasterExtensions.has(extname(file).toLowerCase()));
const unsupportedFiles = rasterFiles.filter((file) => !allowedExtensions.has(extname(file).toLowerCase()));

if (unsupportedFiles.length > 0) {
  console.error([
    "public/images内の公開画像はWebPまたはAVIFにしてください．",
    ...unsupportedFiles.map((file) => `- ${relative(publicImages, file)}`),
  ].join("\n"));
  process.exit(1);
}

console.log(`公開画像 ${rasterFiles.length}点はWebPまたはAVIFです．`);

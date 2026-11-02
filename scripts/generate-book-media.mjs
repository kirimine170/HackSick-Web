import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// Render existing artwork and exact text as a layout．Do not redraw the book cover．
const root = new URL("../", import.meta.url);
const path = name => fileURLToPath(new URL(name, root));
const slug = "anokoto-no-kankeisei-ni-tsuite";
const coverPath = path(`public/images/works/${slug}.webp`);
const source = await readFile(path(`src/content/works/${slug}.md`), "utf8");
const price = Number(source.match(/^  price: (\d+)$/m)?.[1]);
if (!Number.isFinite(price)) throw new Error("Book price is missing");
await mkdir(path("public/images/og/"), { recursive: true });
await mkdir(path(`public/press/${slug}/`), { recursive: true });
for (const width of [320, 640]) {
  await sharp(coverPath).resize({ width }).webp({ quality: 82 }).toFile(path(`public/images/works/${slug}-${width}.webp`));
}
for (const width of [480, 800]) {
  await sharp(path(`public/images/works/${slug}-display.webp`)).resize({ width }).webp({ quality: 78 }).toFile(path(`public/images/works/anokoto-display-${width}.webp`));
}

const embeddedCover = (await sharp(coverPath).resize({ height: 480 }).png().toBuffer()).toString("base64");
const logo = (await sharp(path("public/images/hacksick-wordmark.webp")).png().toBuffer()).toString("base64");
for (const [name, label, author] of [
  ["anokoto-press", "PRESS RELEASE", "漫画短編集｜松見公園"],
  ["anokoto-work", "WORK / COMICS", "松見公園｜きぐうのきわみ"],
  ["matsumi-koen", "CREATOR", "松見公園｜漫画・詩"],
]) {
  const titleLines = name === "matsumi-koen" ? ["松見公園", "漫画と詩の制作"] : ["あのことの", "関係性について"];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#f7f7f5"/><rect width="12" height="630" fill="#d3147e"/>
  <path d="M64 127H1136M64 566H1136" stroke="#101014" stroke-opacity=".2"/>
  <image href="data:image/png;base64,${logo}" x="64" y="32" width="180" height="76"/>
  <g font-family="Hiragino Sans, Noto Sans JP, sans-serif" fill="#101014">
  <text x="64" y="177" font-size="20" font-weight="700" letter-spacing="3" fill="#b5106b">${label}</text>
  <text x="64" y="270" font-size="58" font-weight="700">${titleLines[0]}</text>
  <text x="64" y="348" font-size="58" font-weight="700">${titleLines[1]}</text>
  <text x="68" y="420" font-size="28" font-weight="600">${author}</text>
  <text x="68" y="477" font-size="24">A5判・四編収録</text>
  <text x="68" y="527" font-size="23">タコシェ店頭取扱価格 ${price.toLocaleString("ja-JP")}円</text>
  <text x="68" y="605" font-size="18" fill="#65656d">hacksick.com</text></g>
  <rect x="824" y="62" width="312" height="496" fill="white" stroke="#101014" stroke-opacity=".15"/>
  <image href="data:image/png;base64,${embeddedCover}" x="835" y="70" width="290" height="480" preserveAspectRatio="xMidYMid meet"/>
  </svg>`;
  await sharp(Buffer.from(svg)).webp({ quality: 90 }).toFile(path(`public/images/og/${name}.webp`));
}
await copyFile(coverPath, path(`public/press/${slug}/cover.webp`));
await writeFile(path(`public/press/${slug}/credit.txt`), `書名：あのことの関係性について\n著者：松見公園\nサークル：きぐうのきわみ\n\nクレジット表記例\n書影：松見公園『あのことの関係性について』\n\n書影：提供原寸874×1240px，WebP形式．拡大補間は行っていません．\n紹介・報道で使用する際は上記クレジットをご記載ください．\n掲載方法や，より高解像度の画像のご相談：hsap@hacksick.com\n\nこの資料には陳列写真を含めていません．\n`);
execFileSync("zip", ["-j", "-q", new URL(`public/press/${slug}/press-kit.zip`, root).pathname, new URL(`public/press/${slug}/cover.webp`, root).pathname, new URL(`public/press/${slug}/credit.txt`, root).pathname]);
console.log("Responsive covers，3 OGP layouts and press kit generated");

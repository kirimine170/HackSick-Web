import { existsSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve("dist");

if (!existsSync(root)) {
  console.error("distがありません．先にnpm run buildを実行してください．");
  process.exit(1);
}

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

const htmlFiles = walk(root).filter((file) => extname(file) === ".html");
const forbiddenTerms = [
  "TODO",
  "TBA",
  "仮",
  "確認後",
  "運営確認",
  "準備中",
  "placeholder",
  "dummy",
  "temporary",
  "内部確認待ち",
  "運営確認待ち",
];
const failures = [];

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const normalizedHtml = html.toLowerCase();

  for (const term of forbiddenTerms) {
    if (normalizedHtml.includes(term.toLowerCase())) {
      failures.push(`${relative(root, file)}：禁止語「${term}」が公開HTMLに含まれています．`);
    }
  }

  if (!html.includes('href="/contact/">Contact</a>')) {
    failures.push(`${relative(root, file)}：FooterのContact導線がありません．`);
  }

  if (!html.includes('href="mailto:shizuku.kirimine@hacksick.com">EMAIL')) {
    failures.push(`${relative(root, file)}：Footerの正式メール導線がありません．`);
  }
}

const contactPath = join(root, "contact", "index.html");
const contactHtml = readFileSync(contactPath, "utf8");
const contactRoutesStart = contactHtml.indexOf('<div class="contact-routes">');
const contactRoutesEnd = contactHtml.indexOf('<p class="contact-note">', contactRoutesStart);
const contactRoutes = contactHtml.slice(contactRoutesStart, contactRoutesEnd);
const emailPosition = contactRoutes.indexOf("mailto:shizuku.kirimine@hacksick.com");
const xPosition = contactRoutes.indexOf("https://x.com/HackSick_8949");
const connpassPosition = contactRoutes.indexOf("https://hacksick.connpass.com/");

if (contactRoutesStart < 0 || contactRoutesEnd < 0) {
  failures.push("Contactページの問い合わせ導線を検出できません．");
} else {
  if (!contactRoutes.includes("shizuku.kirimine@hacksick.com")) {
    failures.push("Contactページに正式メールアドレスが表示されていません．");
  }

  if (!(emailPosition >= 0 && emailPosition < xPosition && xPosition < connpassPosition)) {
    failures.push("Contactページの導線をEmail，X，connpassの順にしてください．");
  }

  if (!contactRoutes.includes("SNS / ANNOUNCEMENTS")) {
    failures.push("ContactページでXの役割がSNS・告知として示されていません．");
  }

  if (!contactRoutes.includes("EVENT INFORMATION / REGISTRATION")) {
    failures.push("Contactページでconnpassの役割がイベント情報・参加登録として示されていません．");
  }
}

const joinHtml = readFileSync(join(root, "join", "index.html"), "utf8");
if (!joinHtml.includes("https://note.com/hacksick/n/nfe71d58d2512")) {
  failures.push("JoinページのCommunity導線が公式noteに設定されていません．");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`公開HTML ${htmlFiles.length}ページのProduction文言と問い合わせ導線は正常です．`);
}

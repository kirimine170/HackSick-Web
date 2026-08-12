import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve("dist");

const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? walk(path) : [path];
});

const htmlFiles = walk(root).filter((file) => extname(file) === ".html");
const missing = [];
const external = new Set();

for (const file of htmlFiles) {
  const html = readFileSync(file, "utf8");
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/g)].map((match) => match[1]);

  for (const href of hrefs) {
    if (href.startsWith("http://") || href.startsWith("https://")) {
      external.add(href);
      continue;
    }

    if (href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;

    const pathname = decodeURIComponent(href.split(/[?#]/)[0]);
    if (!pathname) continue;

    const target = pathname.endsWith("/")
      ? join(root, pathname, "index.html")
      : extname(pathname)
        ? join(root, pathname)
        : join(root, pathname, "index.html");

    if (!existsSync(target)) missing.push(`${file.replace(`${root}/`, "")} -> ${href}`);
  }
}

if (missing.length > 0) {
  console.error("Missing internal links:\n" + missing.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${htmlFiles.length} HTML files．Internal links are valid．`);
  console.log(`Found ${external.size} unique external links．`);
}

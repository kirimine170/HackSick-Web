import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://hacksick.com",
  output: "static",
  trailingSlash: "always",
  integrations: [sitemap()],
});

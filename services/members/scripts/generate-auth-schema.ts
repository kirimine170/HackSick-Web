import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { getMigrations } from "better-auth/db/migration";
import { writeFile } from "node:fs/promises";
import { createAuth } from "../src/auth.ts";
import type { Env } from "../src/types.ts";

// 一時ローカルD1からSQLだけを生成する．リモートDBへのアクセスは行わない．
const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: "export default { fetch() { return new Response('schema'); } }", d1Databases: ["DB"], compatibilityDate: "2026-11-03" }));
try {
  const db = await mf.getD1Database("DB");
  const auth = createAuth({ DB: db, AUTH_BASE_URL: "http://localhost:8787", BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret", GOOGLE_WORKSPACE_DOMAIN: "hacksick.com" } as unknown as Env, async () => {});
  const migration = await getMigrations(auth.options);
  const sql = await migration.compileMigrations();
  await writeFile("migrations/0001_auth.sql", `-- Generated from Better Auth 1.7.15 with Email OTP and database rate limits．\n${sql}\n`);
} finally { await mf.dispose(); }

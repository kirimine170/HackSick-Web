// 本番には含めない，一時的なローカル設定画面．秘密情報をログへ出力しない．
import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const nonce = randomBytes(32).toString("hex");
const origin = "http://127.0.0.1:8789";
const directory = resolve(".credentials");
const target = resolve(directory, "production-secrets.json");
await mkdir(directory, { recursive: true, mode: 0o700 });
const fields = {
  GOOGLE_CLIENT_ID: "Google 本番クライアントID",
  GOOGLE_CLIENT_SECRET: "Google 本番クライアントシークレット",
  RESEND_API_KEY: "Resend 送信専用APIキー",
  SQUARE_CLIENT_ID: "Square 専用アプリID",
  SQUARE_CLIENT_SECRET: "Square 専用アプリOAuthシークレット",
  SQUARE_SANDBOX_ACCESS_TOKEN: "Square 専用アプリのSandboxトークン（試験用）",
  SQUARE_SANDBOX_APPLICATION_ID: "Square 専用アプリのSandboxアプリID（試験用）",
  SQUARE_SANDBOX_LOCATION_ID: "Square Sandbox店舗ID（試験用）",
  SQUARE_WEBHOOK_SIGNATURE_KEY: "Square Webhook署名キー",
};
const sandboxOnly = process.argv.includes("--sandbox");
const allowedFields = sandboxOnly ? { SQUARE_SANDBOX_ACCESS_TOKEN: "Square Sandboxトークン" } : fields;
const pageTitle = sandboxOnly ? "HackSick Sandboxキーの保存" : "HackSick 本番接続の一時設定";
async function saved() { try { return JSON.parse(await readFile(target, "utf8")); } catch (error) { if (error.code === "ENOENT") return {}; throw error; } }
const server = createServer(async (req, res) => {
  const url = new URL(req.url, origin);
  res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "same-origin"); res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  if (req.headers.host !== "127.0.0.1:8789") { res.writeHead(403).end(); return; }
  if (req.method === "GET" && url.searchParams.get("setup") === nonce) { res.setHeader("Set-Cookie", `hs-local-setup=${nonce}; HttpOnly; SameSite=Strict; Path=/`); res.writeHead(303, { Location: "/" }).end(); return; }
  if (!req.headers.cookie?.split("; ").includes(`hs-local-setup=${nonce}`)) { res.writeHead(403).end("This setup link has expired."); return; }
  try {
    if (req.method === "POST" && url.pathname === "/secret") {
      if (req.headers.origin !== origin) { res.writeHead(403).end(); return; }
      let body = ""; for await (const chunk of req) { body += chunk; if (body.length > 8192) { res.writeHead(413).end(); return; } }
      const form = new URLSearchParams(body); const name = form.get("name"); const value = form.get("value")?.trim();
      if (!Object.hasOwn(allowedFields, name ?? "") || !value || value.length > 4096 || /[\r\n\0]/.test(value)) { res.writeHead(400).end("Invalid credential."); return; }
      if (name === "SQUARE_SANDBOX_ACCESS_TOKEN") {
        if (!/^EAAA[A-Za-z0-9_-]{30,}$/.test(value)) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("SquareのSandbox Access tokenを貼り付けてください．"); return; }
        let previous;
        try { previous = JSON.parse(await readFile(resolve(directory, "sandbox-rotation.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (previous?.previousHash === createHash("sha256").update(value).digest("hex")) { res.writeHead(409, { "Content-Type": "text/html; charset=utf-8" }).end('<meta charset="utf-8"><p>差し替え前のキーです．SquareでSandbox Access tokenのReplaceを完了し，新しいキーをコピーしてください．</p><p><a href="/">保存画面へ戻る</a></p>'); return; }
      }
      const values = await saved(); values[name] = value; await writeFile(target, JSON.stringify(values), { mode: 0o600 });
      res.writeHead(303, { Location: "/" }).end(); return;
    }
    if (req.method !== "GET" || url.pathname !== "/") { res.writeHead(404).end(); return; }
    const values = await saved();
    const forms = Object.entries(allowedFields).map(([key, label]) => `<section><h2>${label}</h2><p>${values[key] ? "保存済み" : "未設定"}</p><form method="post" action="/secret"><input name="name" type="hidden" value="${key}"><label>${label}<input name="value" type="password" autocomplete="off" spellcheck="false" required autofocus></label><button>この認証情報をローカルへ保存</button></form></section>`).join("");
    const help = sandboxOnly ? "このMacだけで動く保存画面です．コピーした新しいSandboxキーを下の欄へ貼り付け，保存してください．値は画面へ再表示せず，Git管理外へ保存します．" : "このMacだけで動く一時設定画面です．値は表示せず，Git管理外の .credentials/production-secrets.json に保存します．本番のCloudflareへは別途Secretsとして登録します．";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pageTitle}</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:20px;background:#f7f7f5;color:#141414}section{background:white;padding:24px;border:1px solid #ddd;margin:20px 0}input{display:block;box-sizing:border-box;width:100%;padding:12px;margin:12px 0}button{background:#171717;color:white;padding:12px;border:0}h2{font-size:20px}</style><h1>${pageTitle}</h1><p>${help}</p>${forms}</html>`);
  } catch { res.writeHead(500).end("Setup failed."); }
});
server.listen(8789, "127.0.0.1", () => console.log(`${origin}/?setup=${nonce}`));
setTimeout(() => server.close(), 30 * 60 * 1000).unref();

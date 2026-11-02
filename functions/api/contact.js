const json = (status, message) => Response.json({ message }, { status, headers: { "Cache-Control": "no-store" } });

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return json(403, "Forbidden");
  // Report names only，never credential values，so configuration failures can be corrected．
  const enabled = env.CONTACT_ENABLED === true || (typeof env.CONTACT_ENABLED === "string" && env.CONTACT_ENABLED.trim() === "true");
  const missing = [
    ...(!enabled ? ["CONTACT_ENABLED=true"] : []),
    ...["RESEND_API_KEY", "CONTACT_FROM", "TURNSTILE_SECRET_KEY"].filter(name => !env[name]),
  ];
  if (missing.length) return Response.json({ message: "Contact delivery is unavailable", missing }, { status: 503, headers: { "Cache-Control": "no-store" } });
  if (!request.headers.get("content-type")?.includes("application/json")) return json(415, "JSON required");
  if (Number(request.headers.get("content-length")) > 24000) return json(413, "Request too large");
  try {
    const reader = request.body?.getReader();
    if (!reader) return json(400, "Invalid request");
    let size = 0; const chunks = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 24000) { await reader.cancel(); return json(413, "Request too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const data = JSON.parse(new TextDecoder().decode(bytes));
    if (!data || typeof data !== "object" || Array.isArray(data)) return json(400, "Invalid request");
    const limits = { name:100, organization:150, email:254, schedule:150, budget:150, message:5000, token:2048, website:200, creator:100, category:30, consent:10 };
    if (Object.entries(limits).some(([key, max]) => data[key] !== undefined && (typeof data[key] !== "string" || data[key].length > max))) return json(400, "Invalid fields");
    if (data.website || data.consent !== "on" || !data.name?.trim() || !data.message?.trim() || data.message.trim().length < 10 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email ?? "")) return json(400, "Invalid fields");
    const creators = { "":"指定なし", "marmite-daikon-oroshi":"マーマイト大根おろし", "matsumi-koen":"松見公園", "kirimine-shizuku":"霧峰 雫" };
    const categories = { photography:"写真撮影", production:"制作・共同企画", distribution:"書籍・作品の取扱い", press:"取材・メディア掲載", other:"その他" };
    if (!Object.hasOwn(creators, data.creator) || !Object.hasOwn(categories, data.category) || !data.token) return json(400, "Invalid fields");
    const verified = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method:"POST", body:new URLSearchParams({ secret:env.TURNSTILE_SECRET_KEY, response:data.token, remoteip:request.headers.get("CF-Connecting-IP") ?? "" }), signal:AbortSignal.timeout(10000),
    });
    const check = await verified.json();
    if (!check.success || check.hostname !== url.hostname || check.action !== "contact") return json(400, "Verification failed");
    const text = ["HSAP お問い合わせ", `クリエイター：${creators[data.creator]}`, `種類：${categories[data.category]}`, `お名前：${data.name}`, `所属：${data.organization || "指定なし"}`, `返信先：${data.email}`, `時期：${data.schedule || "指定なし"}`, `予算：${data.budget || "指定なし"}`, "", data.message].join("\n");
    const result = await fetch("https://api.resend.com/emails", {
      method:"POST", headers:{ Authorization:`Bearer ${env.RESEND_API_KEY}`, "Content-Type":"application/json", "Idempotency-Key":`inquiry-${await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data.token)).then(buffer => Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2,"0")).join(""))}` },
      body:JSON.stringify({ from:env.CONTACT_FROM, to:["hsap@hacksick.com"], reply_to:data.email, subject:`[HSAP] ${categories[data.category]} / ${creators[data.creator]}`, text }), signal:AbortSignal.timeout(10000),
    });
    if (!result.ok) return json(502, "Delivery failed");
    const sent = await result.json();
    if (!sent.id) return json(502, "Delivery failed");
    return json(200, "Accepted");
  } catch { return json(400, "Unable to process request"); }
}

export function onRequestGet() { return json(405, "Method not allowed"); }

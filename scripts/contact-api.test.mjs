import test from "node:test";
import assert from "node:assert/strict";
import { onRequestPost } from "../functions/api/contact.js";

const origin = "https://preview.hacksick-web.pages.dev";
const env = { CONTACT_ENABLED:"true", RESEND_API_KEY:"test", CONTACT_FROM:"Website <test@example.com>", TURNSTILE_SECRET_KEY:"test" };
const valid = { creator:"marmite-daikon-oroshi", category:"photography", name:"テスト", email:"test@example.com", message:"製品写真の撮影について相談します．", consent:"on", token:"test-token" };
const request = (data, headers = {}) => new Request(`${origin}/api/contact`, { method:"POST", headers:{ Origin:origin, "Content-Type":"application/json", ...headers }, body:JSON.stringify(data) });

test("unconfigured delivery fails closed", async () => assert.equal((await onRequestPost({ request:request(valid), env:{} })).status,503));
test("configuration diagnostics identify missing names without exposing secrets", async () => {
  const result = await onRequestPost({request:request(valid),env:{...env,CONTACT_ENABLED:""}});
  assert.equal(result.status,503);
  const body = await result.json();
  assert.deepEqual(body.missing,["CONTACT_ENABLED=true"]);
  assert.ok(!JSON.stringify(body).includes(env.CONTACT_FROM));
});
test("cross-origin request is rejected", async () => assert.equal((await onRequestPost({ request:request(valid,{Origin:"https://example.com"}), env })).status,403));
test("invalid and oversized input is rejected before contacting providers", async () => {
  for (const data of [null, {...valid,email:"x\n@example.com"}, {...valid,consent:""}, {...valid,website:"spam"}, {...valid,creator:"unknown"}, {...valid,message:"a".repeat(5001)}]) {
    assert.equal((await onRequestPost({ request:request(data), env })).status,400);
  }
  assert.equal((await onRequestPost({ request:request({...valid,message:"a".repeat(25000)}),env })).status,413);
});
test("server verification and email delivery use fixed recipient and reply-to", async t => {
  const calls = [];
  t.mock.method(globalThis,"fetch",async (url,options) => {
    calls.push({url,options});
    return Response.json(url.includes("siteverify") ? {success:true,hostname:new URL(origin).hostname,action:"contact"} : {id:"mock-email-id"});
  });
  assert.equal((await onRequestPost({request:request(valid),env})).status,200);
  assert.equal(calls.length,2);
  const email = JSON.parse(calls[1].options.body);
  assert.deepEqual(email.to,["hsap@hacksick.com"]);
  assert.equal(email.reply_to,valid.email);
  assert.equal(email.from,env.CONTACT_FROM);
});
test("bad captcha host and provider failure never report acceptance", async t => {
  t.mock.method(globalThis,"fetch",async () => Response.json({success:true,hostname:"other.example.com",action:"contact"}));
  assert.equal((await onRequestPost({request:request(valid),env})).status,400);
  globalThis.fetch = async url => url.includes("siteverify") ? Response.json({success:true,hostname:new URL(origin).hostname,action:"contact"}) : Response.json({error:"failure"},{status:500});
  assert.equal((await onRequestPost({request:request(valid),env})).status,502);
});

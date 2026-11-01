// Testes do Web Push feito à mão (webpush.ts).
//  1. Reproduz BYTE A BYTE o exemplo oficial do RFC 8291 (apêndice A).
//  2. Decifra com uma implementação independente (módulo `crypto` do Node, não WebCrypto).
//  3. Confere a assinatura VAPID (ES256) e as claims.
//  4. Envia para um "serviço de push" HTTP local e grava a requisição para a
//     conferência cruzada em Python (test/verify_push.py).
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import {
  b64uEncode, b64uDecode, encryptPayload, generateVapidKeys, vapidAuthHeader, sendPush,
} from "../supabase/functions/send-reminders/webpush.ts";
import { decryptAes128gcm, newSubscriber, fakePushService } from "./push_helpers.mjs";

// ---------- 1. Vetor oficial do RFC 8291 -------------------------------------
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPriv: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPub: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPriv: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  uaPub: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function rfcAsKeys() {
  const pub = b64uDecode(RFC.asPub);
  const privateKey = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", d: RFC.asPriv,
    x: b64uEncode(pub.subarray(1, 33)), y: b64uEncode(pub.subarray(33, 65)),
  }, { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKey = await crypto.subtle.importKey("raw", pub, { name: "ECDH", namedCurve: "P-256" }, true, []);
  return { privateKey, publicKey };
}

test("RFC 8291 apêndice A: nossa criptografia gera exatamente o corpo do exemplo oficial", async () => {
  const body = await encryptPayload(
    { p256dh: RFC.uaPub, auth: RFC.auth },
    new TextEncoder().encode(RFC.plaintext),
    { salt: b64uDecode(RFC.salt), asKeys: await rfcAsKeys() },
  );
  assert.equal(b64uEncode(body), RFC.body);
});

test("RFC 8291: o decifrador independente lê o corpo oficial", () => {
  assert.equal(decryptAes128gcm(b64uDecode(RFC.body), RFC.uaPriv, RFC.uaPub, RFC.auth), RFC.plaintext);
});

// ---------- 2. Ida e volta com chaves aleatórias ----------------------------
test("ida e volta: o que ciframos o decifrador independente lê (mensagens de vários tamanhos)", async () => {
  for (const text of ["", "oi", "Hora do remédio · Losartana 50 mg (08:00) — ç ã é 💊", "x".repeat(3000)]) {
    const sub = newSubscriber();
    const body = await encryptPayload(sub, new TextEncoder().encode(text));
    assert.equal(decryptAes128gcm(body, sub.priv, sub.p256dh, sub.auth), text);
  }
});

test("payload maior que um registro é recusado; chaves ruins também", async () => {
  const sub = newSubscriber();
  await assert.rejects(encryptPayload(sub, new Uint8Array(4100)), /grande demais/);
  await assert.rejects(encryptPayload({ p256dh: "AAAA", auth: sub.auth }, new Uint8Array(3)), /p256dh/);
  await assert.rejects(encryptPayload({ p256dh: sub.p256dh, auth: "AAAA" }, new Uint8Array(3)), /auth/);
});

test("cada envio usa sal e chave efêmera novos", async () => {
  const sub = newSubscriber();
  const a = await encryptPayload(sub, new Uint8Array([1]));
  const b = await encryptPayload(sub, new Uint8Array([1]));
  assert.notEqual(b64uEncode(a), b64uEncode(b));
});

// ---------- 3. VAPID --------------------------------------------------------
function verifyVapid(header, endpoint, vapidPublic, subject) {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m, "formato do cabeçalho");
  assert.equal(m[2], vapidPublic);
  const [h, c, s] = m[1].split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(claims.sub, subject);
  const nowSec = Date.now() / 1000;
  assert.ok(claims.exp > nowSec && claims.exp <= nowSec + 24 * 3600, "exp entre agora e 24 h (limite da Apple/FCM)");
  const pub = Buffer.from(vapidPublic, "base64url");
  assert.equal(pub.length, 65);
  const key = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const sig = Buffer.from(s, "base64url");
  assert.equal(sig.length, 64);
  assert.ok(crypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, sig), "assinatura ES256 válida");
}

test("VAPID: assinatura ES256 válida, aud = origem do serviço de push, exp < 24 h", async () => {
  const v = await generateVapidKeys();
  assert.equal(b64uDecode(v.publicKey).length, 65);
  assert.ok(v.privateJwk.d && v.privateJwk.x && v.privateJwk.y);
  const endpoint = "https://fcm.googleapis.com/fcm/send/abc123";
  const header = await vapidAuthHeader(endpoint, v, "https://exemplo.supabase.co");
  verifyVapid(header, endpoint, v.publicKey, "https://exemplo.supabase.co");
});

test("VAPID: o par gerado sobrevive a JSON (como fica guardado no banco)", async () => {
  const v = await generateVapidKeys();
  const roundTrip = JSON.parse(JSON.stringify(v));
  const header = await vapidAuthHeader("https://web.push.apple.com/x", roundTrip, "https://s.supabase.co");
  verifyVapid(header, "https://web.push.apple.com/x", v.publicKey, "https://s.supabase.co");
});

// ---------- 4. Envio de ponta a ponta contra um "serviço de push" local ------
test("sendPush: cabeçalhos corretos, corpo decifrável, VAPID válido — e grava captura para o Python", async () => {
  const { server, seen, base } = await fakePushService(() => [201]);
  try {
    const sub = newSubscriber();
    const vapid = await generateVapidKeys();
    const payload = JSON.stringify({ title: "Hora do remédio", body: "Losartana 50 mg (08:00)", url: "./?take=abc" });
    const endpoint = `${base}/push/xyz`;
    const r = await sendPush({ endpoint, p256dh: sub.p256dh, auth: sub.auth }, payload, vapid, "https://p.supabase.co", fetch, { ttlSeconds: 1800 });
    assert.deepEqual([r.ok, r.status], [true, 201]);
    assert.equal(seen.length, 1);
    const q = seen[0];
    assert.equal(q.method, "POST");
    assert.equal(q.url, "/push/xyz");
    assert.equal(q.headers["content-encoding"], "aes128gcm");
    assert.equal(q.headers["content-type"], "application/octet-stream");
    assert.equal(q.headers["ttl"], "1800");
    assert.equal(q.headers["urgency"], "high");
    verifyVapid(q.headers["authorization"], endpoint, vapid.publicKey, "https://p.supabase.co");
    assert.equal(decryptAes128gcm(q.body, sub.priv, sub.p256dh, sub.auth), payload);
    fs.writeFileSync("/tmp/tomei_push_capture.json", JSON.stringify({
      endpoint, authorization: q.headers["authorization"], body_b64u: q.body.toString("base64url"),
      ua_private: sub.priv, ua_public: sub.p256dh, auth: sub.auth, vapid_public: vapid.publicKey,
      subject: "https://p.supabase.co", expected_payload: payload,
    }));
  } finally { server.close(); }
});

test("sendPush: devolve o status do serviço (410 = inscrição expirada) e mensagem de erro curta", async () => {
  const { server, base } = await fakePushService(() => [410, "gone"]);
  try {
    const sub = newSubscriber();
    const r = await sendPush({ endpoint: `${base}/p`, p256dh: sub.p256dh, auth: sub.auth }, "{}", await generateVapidKeys(), "https://s", fetch);
    assert.deepEqual([r.ok, r.status, r.detail], [false, 410, "gone"]);
  } finally { server.close(); }
});

test("sendPush: falha de rede vira status 0 (não lança exceção)", async () => {
  const sub = newSubscriber();
  const r = await sendPush({ endpoint: "http://127.0.0.1:1/nada", p256dh: sub.p256dh, auth: sub.auth }, "{}", await generateVapidKeys(), "https://s", fetch);
  assert.equal(r.status, 0);
  assert.equal(r.ok, false);
});

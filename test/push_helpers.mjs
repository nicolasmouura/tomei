// Ajudas dos testes de Web Push: decifrador independente (módulo `crypto` do Node, e não
// WebCrypto), gerador de "navegador" com chaves reais e um serviço de push falso em HTTP.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";

export function decryptAes128gcm(body, uaPrivB64u, uaPubB64u, authB64u) {
  body = Buffer.from(body);
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPub = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  assert.ok(rs >= 18, "rs inválido");
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.setPrivateKey(Buffer.from(uaPrivB64u, "base64url"));
  const shared = ecdh.computeSecret(asPub);
  const uaPub = Buffer.from(uaPubB64u, "base64url");
  const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.from(authB64u, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), uaPub, asPub]), 32));
  const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(cipher.subarray(-16));
  const plain = Buffer.concat([d.update(cipher.subarray(0, -16)), d.final()]);
  // remove o padding: 0x02 final (último registro) precedido só de zeros
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, "delimitador do último registro");
  return plain.subarray(0, end).toString("utf8");
}

export function newSubscriber() {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  return {
    priv: ecdh.getPrivateKey().toString("base64url"),
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: crypto.randomBytes(16).toString("base64url"),
  };
}

export function fakePushService(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      const [status, text] = respond(seen.length);
      res.writeHead(status);
      res.end(text ?? "");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

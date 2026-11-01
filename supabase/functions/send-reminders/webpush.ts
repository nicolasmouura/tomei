// =============================================================================
//  Web Push "na unha" (RFC 8291 + RFC 8188 + RFC 8292) usando só WebCrypto.
//
//  Por que não usar uma biblioteca? Funciona igual no Deno (Edge Functions do
//  Supabase) e no Node, não depende de npm, e dá para provar que está certo:
//  os testes reproduzem byte a byte o exemplo oficial do RFC 8291 e conferem
//  o resultado com uma implementação independente em Python.
// =============================================================================

const enc = new TextEncoder();

// (só tipagem) Uint8Array → BufferSource, sem brigar com versões diferentes do TypeScript/Deno
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

// ---------- base64url ----------------------------------------------------------

export function b64uEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64uDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// ---------- chaves VAPID ---------------------------------------------------------

export interface VapidKeys {
  /** chave pública (ponto P-256 não comprimido, 65 bytes) em base64url */
  publicKey: string;
  /** chave privada no formato JWK (fica só no banco, nunca vai ao navegador) */
  privateJwk: JsonWebKey;
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64uEncode(pub), privateJwk };
}

/** Cabeçalho `Authorization: vapid t=<jwt>, k=<chave pública>` (RFC 8292). */
export async function vapidAuthHeader(
  endpoint: string,
  vapid: VapidKeys,
  subject: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const aud = new URL(endpoint).origin;
  const head = b64uEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64uEncode(
    enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })),
  );
  const key = await crypto.subtle.importKey(
    "jwk",
    vapid.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // WebCrypto já devolve a assinatura no formato r||s (64 bytes) que o JWS exige
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)),
  );
  return `vapid t=${head}.${claims}.${b64uEncode(sig)}, k=${vapid.publicKey}`;
}

// ---------- criptografia do conteúdo (aes128gcm) -------------------------------

export interface PushKeys {
  /** `p256dh` da inscrição: chave pública do navegador (base64url, 65 bytes) */
  p256dh: string;
  /** `auth` da inscrição: segredo de 16 bytes (base64url) */
  auth: string;
}

export interface EncryptOptions {
  /** só para testes: sal fixo */
  salt?: Uint8Array;
  /** só para testes: par ECDH efêmero fixo */
  asKeys?: CryptoKeyPair;
}

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  bits: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", bs(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bs(salt), info: bs(info) }, key, bits),
  );
}

/** Devolve o corpo da requisição de push já criptografado (um único registro de 4096 bytes). */
export async function encryptPayload(
  sub: PushKeys,
  plaintext: Uint8Array,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(sub.p256dh);
  const authSecret = b64uDecode(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh inválida");
  if (authSecret.length !== 16) throw new Error("auth inválido");

  const asKeys = opts.asKeys ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey(
    "raw",
    bs(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256),
  );

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh, "WebPush: info\0" || ua_public || as_public, 32)
  const ikm = await hkdf(
    shared,
    authSecret,
    concat(enc.encode("WebPush: info\0"), uaPublic, asPublic),
    256,
  );

  // RFC 8188: chave de conteúdo e nonce a partir do sal
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"), 96);

  const recordSize = 4096;
  const record = concat(plaintext, new Uint8Array([2])); // 0x02 = delimitador do último registro
  if (record.length + 16 > recordSize) throw new Error("payload grande demais");
  const aes = await crypto.subtle.importKey("raw", bs(cek), "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(nonce), tagLength: 128 }, aes, bs(record)),
  );

  // cabeçalho: sal(16) | tamanho do registro(4, big-endian) | tamanho do keyid(1) | keyid = chave pública efêmera(65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, recordSize, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

// ---------- envio ---------------------------------------------------------------

export interface PushTarget extends PushKeys {
  endpoint: string;
}

export interface SendOptions {
  /** quanto tempo o serviço de push guarda a mensagem se o aparelho estiver offline */
  ttlSeconds?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface SendResult {
  status: number; // 0 = falha de rede
  ok: boolean;
  detail: string;
}

export async function sendPush(
  target: PushTarget,
  payload: string,
  vapid: VapidKeys,
  subject: string,
  fetchFn: typeof fetch,
  opts: SendOptions = {},
): Promise<SendResult> {
  try {
    const body = await encryptPayload(target, enc.encode(payload));
    const res = await fetchFn(target.endpoint, {
      method: "POST",
      headers: {
        "Authorization": await vapidAuthHeader(target.endpoint, vapid, subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        "TTL": String(opts.ttlSeconds ?? 3600),
        "Urgency": opts.urgency ?? "high",
      },
      body: bs(body),
    });
    const detail = res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200);
    return { status: res.status, ok: res.ok, detail };
  } catch (err) {
    return { status: 0, ok: false, detail: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}

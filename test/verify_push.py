#!/usr/bin/env python3
"""
Conferência cruzada, em OUTRA linguagem e com OUTRA biblioteca (cryptography + PyJWT),
de uma requisição de Web Push gerada pelo nosso webpush.ts.

Lê /tmp/tomei_push_capture.json (gravado por test/webpush.test.mjs), decifra o corpo
(RFC 8291 / RFC 8188) e valida o JWT VAPID (RFC 8292).
"""
import base64
import json
import sys

import jwt  # PyJWT
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF


def b64u(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


cap = json.load(open(sys.argv[1] if len(sys.argv) > 1 else "/tmp/tomei_push_capture.json"))
body = b64u(cap["body_b64u"])

# --- cabeçalho aes128gcm: salt(16) | rs(4) | idlen(1) | keyid(idlen) | ciphertext
salt, rs, idlen = body[:16], int.from_bytes(body[16:20], "big"), body[20]
as_pub = body[21:21 + idlen]
ciphertext = body[21 + idlen:]
assert idlen == 65 and as_pub[0] == 4, "keyid deve ser a chave efêmera P-256 não comprimida"
assert rs == 4096, f"tamanho do registro inesperado: {rs}"
assert len(ciphertext) <= rs, "mais de um registro"

# --- ECDH + HKDF (RFC 8291 §3.3-3.4)
ua_priv = ec.derive_private_key(int.from_bytes(b64u(cap["ua_private"]), "big"), ec.SECP256R1())
ua_pub = b64u(cap["ua_public"])
assert ua_priv.public_key().public_bytes(
    encoding=__import__("cryptography").hazmat.primitives.serialization.Encoding.X962,
    format=__import__("cryptography").hazmat.primitives.serialization.PublicFormat.UncompressedPoint,
) == ua_pub, "chave pública do navegador não bate com a privada"

shared = ua_priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), as_pub))
ikm = HKDF(hashes.SHA256(), 32, salt=b64u(cap["auth"]), info=b"WebPush: info\0" + ua_pub + as_pub).derive(shared)
cek = HKDF(hashes.SHA256(), 16, salt=salt, info=b"Content-Encoding: aes128gcm\0").derive(ikm)
nonce = HKDF(hashes.SHA256(), 12, salt=salt, info=b"Content-Encoding: nonce\0").derive(ikm)

plain = AESGCM(cek).decrypt(nonce, ciphertext, None)
plain = plain.rstrip(b"\0")
assert plain[-1:] == b"\x02", "delimitador do último registro (0x02) ausente"
text = plain[:-1].decode("utf-8")
assert text == cap["expected_payload"], f"payload diferente: {text!r}"
print("OK  corpo decifrado em Python:", text)

# --- VAPID (RFC 8292): "vapid t=<jwt>, k=<chave pública>"
scheme, rest = cap["authorization"].split(" ", 1)
assert scheme == "vapid"
fields = dict(part.strip().split("=", 1) for part in rest.split(","))
assert fields["k"] == cap["vapid_public"]
pub = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), b64u(fields["k"]))
from urllib.parse import urlsplit
u = urlsplit(cap["endpoint"])
claims = jwt.decode(fields["t"], key=pub, algorithms=["ES256"], audience=f"{u.scheme}://{u.netloc}")
assert claims["sub"] == cap["subject"]
print("OK  JWT VAPID válido em Python (PyJWT):", {k: claims[k] for k in ("aud", "sub")})

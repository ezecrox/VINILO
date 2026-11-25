// Web Push sin dependencias: cifrado aes128gcm (RFC 8291) y autenticación VAPID (RFC 8292) con el módulo crypto de Node.
const crypto = require('crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function generarClavesVapid() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function clavePrivada(vapid) {
  const pub = deB64u(vapid.publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', d: vapid.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) } });
}

function jwtVapid(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const enc = (o) => b64u(Buffer.from(JSON.stringify(o)));
  const datos = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })}`;
  const firma = crypto.sign('sha256', Buffer.from(datos), { key: clavePrivada(vapid), dsaEncoding: 'ieee-p1363' });
  return `${datos}.${b64u(firma)}`;
}

const hkdf = (ikm, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));

// Cifra el contenido para una suscripción { endpoint, keys: { p256dh, auth } }
function cifrar(payload, sub) {
  const uaPublic = deB64u(sub.keys.p256dh);
  const authSecret = deB64u(sub.keys.auth);
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey();
  const secreto = as.computeSecret(uaPublic);
  const ikm = hkdf(secreto, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const salt = crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const cuerpo = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, cuerpo]);
}

// Envía una notificación. Devuelve { ok, status, expirada }.
async function enviar(sub, datos, vapid, { subject = 'mailto:admin@vinilo.app', ttl = 86400, urgencia = 'normal' } = {}) {
  const body = cifrar(JSON.stringify(datos), sub);
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(sub.endpoint, {
      method: 'POST', signal: ctrl.signal, body,
      headers: { TTL: String(ttl), Urgency: urgencia, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
        Authorization: `vapid t=${jwtVapid(sub.endpoint, vapid, subject)}, k=${vapid.publicKey}` },
    });
    const txt = r.ok ? '' : (await r.text().catch(() => '')).slice(0, 300);
    return { ok: r.ok, status: r.status, expirada: r.status === 404 || r.status === 410, detalle: txt };
  } finally { clearTimeout(to); }
}

module.exports = { generarClavesVapid, enviar, cifrar, jwtVapid, b64u, deB64u };

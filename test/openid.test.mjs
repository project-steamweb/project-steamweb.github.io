// End-to-end check of the Steam OpenID 2.0 login handshake.
// Builds a correctly signed id_res response and feeds it to /api/auth/callback,
// then checks the issued session cookie. The API key never leaves this process.
import { readFileSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import crypto from 'node:crypto';

const KEY_FILE = './.steam-key.enc';
const SECRET_FILE = './.steam-key.secret';
const SECRET_CONTEXT = 'steam-atlas:web-api-key:v1';

function decryptStoredKey() {
  const secret = Buffer.from(readFileSync(SECRET_FILE, 'utf8').trim(), 'base64');
  const payload = Buffer.from(readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
  const iv = payload.subarray(0, 12);
  const tag = payload.subarray(12, 28);
  const ciphertext = payload.subarray(28);
  const key = crypto.createHash('sha256').update(secret).update(SECRET_CONTEXT).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8').trim();
}

const apiKey = decryptStoredKey();
const BASE = 'http://127.0.0.1:8787';
const STEAM_ID = '76561197960287930';
const claimed = `https://steamcommunity.com/openid/id/${STEAM_ID}`;
const NS = 'http://specs.openid.net/auth/2.0';

// 1. Kick off the login to obtain the server-issued state + return_to.
const loginRes = await fetch(`${BASE}/api/auth/login`, { redirect: 'manual' });
const location = loginRes.headers.get('location') || '';
const returnTo = new URL(location).searchParams.get('openid.return_to') || '';
const state = new URL(returnTo).searchParams.get('state') || '';
console.log('login status       :', loginRes.status);
console.log('state issued       :', state.length === 32 ? 'yes' : 'NO');
console.log('return_to captured :', returnTo.startsWith(`${BASE}/api/auth/callback`) ? 'yes' : 'NO');

function signResponse(returnToValue, { tamper = false } = {}) {
  const fields = {
    ns: NS,
    mode: 'id_res',
    op_endpoint: 'https://steamcommunity.com/openid/login',
    claimed_id: claimed,
    identity: claimed,
    return_to: returnToValue,
    response_nonce: '2026-11-10T00:00:00Zabcdef',
    assoc_handle: '1234567890',
    sig: '',
    signed: 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle,ns',
  };
  if (tamper) fields.claimed_id = 'https://steamcommunity.com/openid/id/76561198000000000';
  const signedList = fields.signed.split(',');
  const payload = signedList.map((f) => `${f}=${encodeURIComponent(fields[f])}`).join('&');
  fields.sig = crypto.createHmac('sha1', apiKey).update(payload).digest('base64');
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) params.set(`openid.${name}`, value);
  return params.toString();
}

// 2. Tampered signature must be rejected.
const tamperRes = await fetch(`${BASE}/api/auth/callback?${signResponse(returnTo, { tamper: true })}`, { redirect: 'manual' });
const tamperTarget = new URL(tamperRes.headers.get('location') || '');
console.log('tampered rejected  :', tamperTarget.searchParams.get('auth') === 'error' ? 'yes' : 'NO');

// 3. A fresh state is needed because the state is single use.
const loginRes2 = await fetch(`${BASE}/api/auth/login`, { redirect: 'manual' });
const returnTo2 = new URL(loginRes2.headers.get('location')).searchParams.get('openid.return_to') || '';

// 4. Correctly signed response must create a session.
const okRes = await fetch(`${BASE}/api/auth/callback?${signResponse(returnTo2)}`, { redirect: 'manual' });
const okTarget = new URL(okRes.headers.get('location') || '');
const cookie = (okRes.headers.get('set-cookie') || '').split(';')[0];
console.log('valid accepted     :', okTarget.searchParams.get('auth') === 'ok' ? 'yes' : `NO (${okTarget.searchParams.get('reason') || 'no reason'})`);
console.log('cookie issued      :', cookie.startsWith('steam_atlas_sid=') ? 'yes' : 'NO');

// 5. The session must resolve to the signed-in SteamID.
if (cookie) {
  const sessionRes = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookie } });
  const session = await sessionRes.json();
  console.log('session authed     :', session.authenticated === true ? 'yes' : 'NO');
  console.log('session steamId    :', session.user?.steamId === STEAM_ID ? 'match' : 'MISMATCH');
  console.log('session persona    :', session.user?.personaName || '(none)');

  // 6. Logout must clear it again.
  await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
  const afterRes = await fetch(`${BASE}/api/auth/session`, { headers: { Cookie: cookie } });
  const after = await afterRes.json();
  console.log('logout cleared     :', after.authenticated === false ? 'yes' : 'NO');
}

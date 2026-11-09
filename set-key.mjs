// Encrypt the Steam Web API key for local storage.
// Usage:  node set-key.mjs <32-hex-key>
// Writes .steam-key.enc and a random 32-byte .steam-key.secret (never commit either).
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';

const key = String(process.argv[2] || '').trim();
if (!/^[A-Fa-f0-9]{32}$/.test(key)) {
  console.error('Usage: node set-key.mjs <32-hex Steam Web API Key>');
  process.exit(1);
}

const secretFile = new URL('./.steam-key.secret', import.meta.url);
const keyFile = new URL('./.steam-key.enc', import.meta.url);

let secret;
if (existsSync(secretFile)) {
  secret = Buffer.from(readFileSync(secretFile, 'utf8').trim(), 'base64');
}
if (!secret || secret.length !== 32) {
  secret = crypto.randomBytes(32);
  writeFileSync(secretFile, secret.toString('base64') + '\n', { mode: 0o600 });
}

const aesKey = crypto.createHash('sha256').update(secret).update('steam-atlas:web-api-key:v1').digest();
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
const ciphertext = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
writeFileSync(keyFile, payload.toString('base64') + '\n', { mode: 0o600 });

try { chmodSync(secretFile, 0o600); chmodSync(keyFile, 0o600); } catch { /* Windows */ }

console.log('Encrypted Steam API key written.');
console.log('  .steam-key.enc');
console.log('  .steam-key.secret  (keep this file private; delete both to revoke)');

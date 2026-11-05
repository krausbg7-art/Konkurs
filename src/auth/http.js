// Minimal HTTPS client with optional client certificate (Sber ID requires mTLS).
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';

export function makeAgent({ p12Path, password, caPath } = {}) {
  if (!p12Path && !caPath) return undefined;
  return new https.Agent({
    pfx: p12Path ? readFileSync(p12Path) : undefined,
    passphrase: password || undefined,
    // Extra CA (for example the Russian Trusted Root CA) on top of the default roots.
    ca: caPath ? [...tls.rootCertificates, readFileSync(caPath, 'utf8')] : undefined,
    keepAlive: true,
  });
}

export function request(url, { method = 'GET', headers = {}, body, agent, timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(u, { method, headers, agent, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`timeout: ${u.host}`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

export const form = (obj) =>
  new URLSearchParams(Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ''))).toString();

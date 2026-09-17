/* Prometeus API — recibe el pack de carátulas del TV Master y lo publica
 * en GitHub (overrides.json público). Cero dependencias (solo Node 18+).
 *
 * Secrets (SOLO como Environment Variables en Render, jamás en código):
 *   GITHUB_TOKEN  token con permiso contents:write en DEST_REPO
 * Env comunes:
 *   ADMIN_CODE    código de 4 números + 2 letras que valida al Master
 *   DEST_REPO     "francisco154/prometeus-datos" (owner/repo)
 *   DEST_BRANCH   "main"
 *   DEST_PATH     "overrides.json"
 *   PORT          lo inyecta Render
 */
'use strict';
const http = require('http');

const ADMIN_CODE = process.env.ADMIN_CODE || '';
const DEST_REPO = process.env.DEST_REPO || 'francisco154/prometeus-datos';
const DEST_BRANCH = process.env.DEST_BRANCH || 'main';
const DEST_PATH = process.env.DEST_PATH || 'overrides.json';
const PORT = Number(process.env.PORT || 3000);

const CODE_RE = /^[0-9]{4}[A-Za-z]{2}$/;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function leerBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2_000_000) reject(new Error('body muy grande'));
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

async function gh(path, opts = {}) {
  // El token vive SOLO en env; jamás se loguea ni se devuelve.
  const token = process.env.GITHUB_TOKEN || '';
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'prometeus-api',
      Authorization: `token ${token}`,
      ...(opts.headers || {}),
    },
  });
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* puede venir vacío */ }
  return { status: r.status, json, txt };
}

function validarPack(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    return 'pack inválido: se espera {guid:{url,nombre,fuente}}';
  }
  const guids = Object.keys(pack);
  if (guids.length === 0) return 'pack vacío: nada para publicar';
  if (guids.length > 2000) return 'pack muy grande (máx 2000)';
  for (const g of guids) {
    const p = pack[g];
    if (!p || typeof p.url !== 'string') return `entrada inválida: ${g}`;
    const u = p.url.trim();
    if (!(u.startsWith('http://') || u.startsWith('https://')) || u.length > 2000) {
      return `URL inválida en ${g}`;
    }
    if (typeof p.nombre !== 'string' || typeof p.fuente !== 'string') {
      return `nombre/fuente inválidos en ${g}`;
    }
  }
  return null;
}

async function manejarPublish(req, res) {
  let body;
  try {
    body = JSON.parse(await leerBody(req));
  } catch {
    return send(res, 400, { ok: false, error: 'JSON inválido' });
  }
  const code = String(body.adminCode || '');
  if (!CODE_RE.test(code) || code !== ADMIN_CODE || !ADMIN_CODE) {
    return send(res, 403, { ok: false, error: 'código de administrador inválido' });
  }
  const err = validarPack(body.posters);
  if (err) return send(res, 400, { ok: false, error: err });
  if (!process.env.GITHUB_TOKEN) {
    return send(res, 500, { ok: false, error: 'backend sin token configurado' });
  }
  try {
    // sha actual para pisar el archivo
    const cur = await gh(
      `/repos/${DEST_REPO}/contents/${DEST_PATH}?ref=${DEST_BRANCH}`
    );
    const sha = cur.json && cur.json.sha ? cur.json.sha : undefined;
    let actual = { version: 3, posters: {} };
    if (cur.json && cur.json.content) {
      try {
        actual = JSON.parse(Buffer.from(cur.json.content, 'base64').toString('utf8'));
      } catch { /* arranca limpio */ }
    }
    const version = (Number(actual.version) || 3) + 1;
    const contenido = {
      version,
      updated_at: new Date().toISOString().slice(0, 10),
      posters: body.posters,
    };
    const put = await gh(`/repos/${DEST_REPO}/contents/${DEST_PATH}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `Pack v${version} desde Prometeus API`,
        content: Buffer.from(JSON.stringify(contenido)).toString('base64'),
        branch: DEST_BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (put.status !== 200 && put.status !== 201) {
      return send(res, 502, { ok: false, error: 'GitHub no aceptó el archivo' });
    }
    return send(res, 200, {
      ok: true,
      version,
      count: Object.keys(body.posters).length,
    });
  } catch {
    return send(res, 500, { ok: false, error: 'error interno publicando' });
  }
}

async function manejarVersion(req, res) {
  try {
    const r = await fetch(
      `https://raw.githubusercontent.com/${DEST_REPO}/${DEST_BRANCH}/${DEST_PATH}`
    );
    if (!r.ok) return send(res, 200, { ok: true, version: 0, count: 0 });
    const j = await r.json();
    const posters = j.posters && typeof j.posters === 'object' ? j.posters : {};
    return send(res, 200, {
      ok: true,
      version: Number(j.version) || 0,
      updated_at: j.updated_at || null,
      count: Object.keys(posters).length,
    });
  } catch {
    return send(res, 200, { ok: true, version: 0, count: 0 });
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    return send(res, 200, { ok: true });
  }
  if (req.method === 'GET' && url.pathname === '/version') {
    return manejarVersion(req, res);
  }
  if (req.method === 'POST' && url.pathname === '/publish') {
    return manejarPublish(req, res);
  }
  return send(res, 404, { ok: false, error: 'no existe' });
});

server.listen(PORT, () => console.log(`prometeus-api en puerto ${PORT}`));

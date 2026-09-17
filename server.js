/* Prometeus API — recibe el pack de carátulas del TV Master y lo publica
 * en GitHub (overrides.json público). Cero dependencias (solo Node 18+).
 *
 * Auth GitHub (3.17, sin PAT): Render tiene como secret una SSH Deploy Key
 * (lectura+escritura) del repo destino. git push usa esa llave por SSH
 * (GIT_SSH_COMMAND). NINGÚN token vive en el servidor ni en el APK.
 *
 * Env:
 *   ADMIN_CODE        código de 4 números + 2 letras que valida al Master
 *   DEST_REPO         "francisco154/prometeus-datos" (owner/repo)
 *   DEST_BRANCH       "main"
 *   DEST_PATH         "overrides.json"
 *   DEPLOY_KEY_B64    llave SSH privada (base64), montada SOLO en Render
 *   PORT              lo inyecta Render
 */
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

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

function sh(file, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 25000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/* Llave SSH a archivo temporal con el GIT_SSH_COMMAND ya armado.
 * Retorna {keyPath, env} o lanza si falta el secret. */
function sshEnv() {
  const b64 = process.env.DEPLOY_KEY_B64 || '';
  if (!b64) throw new Error('sin llave de despliegue configurada');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promkey-'));
  const keyPath = path.join(dir, 'id_ed25519');
  fs.writeFileSync(keyPath, Buffer.from(b64, 'base64'), { mode: 0o600 });
  return {
    keyPath,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o IdentitiesOnly=yes`,
      GIT_AUTHOR_NAME: 'prometeus-api',
      GIT_AUTHOR_EMAIL: 'prometeus-api@local',
      GIT_COMMITTER_NAME: 'prometeus-api',
      GIT_COMMITTER_EMAIL: 'prometeus-api@local',
    },
  };
}

function limpiar(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
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

/* Publica vía git push con la deploy key: clona shallow, pisa el archivo,
 * commit y push. Devuelve {version, count}. */
async function publicarGit(posters) {
  const { keyPath, env } = sshEnv();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'prompub-'));
  try {
    await sh('git', [
      'clone', '--depth', '1', '--branch', DEST_BRANCH,
      `git@github.com:${DEST_REPO}.git`, work,
    ], { env });
    const destino = path.join(work, DEST_PATH);
    let version = 4;
    try {
      const actual = JSON.parse(fs.readFileSync(destino, 'utf8'));
      version = (Number(actual.version) || 3) + 1;
    } catch { /* arranca en 4 */ }
    const contenido = {
      version,
      updated_at: new Date().toISOString().slice(0, 10),
      posters,
    };
    fs.mkdirSync(path.dirname(destino), { recursive: true });
    fs.writeFileSync(destino, JSON.stringify(contenido));
    await sh('git', ['-C', work, 'add', DEST_PATH], { env });
    let hayCambios = true;
    try {
      await sh('git', ['-C', work, 'diff', '--cached', '--quiet'], { env });
      hayCambios = false;
    } catch { hayCambios = true; }
    if (hayCambios) {
      await sh('git', ['-C', work, 'commit', '-m', `Pack v${version} desde Prometeus API`], { env });
      await sh('git', ['-C', work, 'push', 'origin', DEST_BRANCH], { env });
    } else {
      // sin cambios de contenido igual se informa la versión vigente
      try {
        const actual = JSON.parse(fs.readFileSync(destino, 'utf8'));
        version = Number(actual.version) || version;
      } catch { /* usa la calculada */ }
    }
    return { version, count: Object.keys(posters).length };
  } finally {
    limpiar(work);
    limpiar(path.dirname(keyPath));
  }
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
  try {
    const r = await publicarGit(body.posters);
    return send(res, 200, { ok: true, version: r.version, count: r.count });
  } catch {
    // jamás se expone el motivo interno (podría rozar secretos)
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

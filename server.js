import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENES, SCENE_IDS } from './src/scenes.js';
import { generateScene, summarizeAttempts } from './src/pipeline.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MAX_UPLOAD = 7 * 1024 * 1024;
const MAX_IMAGE = 6 * 1024 * 1024;
const TYPES = {
  '/': 'text/html; charset=utf-8',
  '/index.html': 'text/html; charset=utf-8',
  '/app.js': 'text/javascript; charset=utf-8',
  '/styles.css': 'text/css; charset=utf-8'
};

function reply(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD) { const e = new Error('Uploaded image is too large (6 MB max).'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Fixed-window limiter per client IP: generation is the expensive call.
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) { hits.set(key, { start: t, count: 1 }); return true; }
    if (entry.count >= limit) return false;
    entry.count++;
    return true;
  };
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || 'unknown';
}

export function createApp({ deps, config = {} }) {
  const maxAttempts = config.maxAttempts ?? 3;
  const minSimilarity = config.minSimilarity ?? 0.40;
  const allow = createRateLimiter({ limit: config.rateLimit ?? 6, windowMs: config.rateWindowMs ?? 10 * 60_000 });
  const log = config.log ?? console;

  async function generate(req, res) {
    if (!deps) return reply(res, 503, { error: 'Cloudflare credentials are not configured on the server.' });
    if (!allow(clientIp(req))) return reply(res, 429, { error: 'Too many pictures in a short time. Please wait a few minutes and try again.' });
    try {
      const body = await readBody(req);
      const parsed = new Request('http://localhost/api/generate', { method: 'POST', headers: { 'content-type': req.headers['content-type'] || '' }, body });
      const data = await parsed.formData();
      const image = data.get('image');
      const scene = String(data.get('scene') || '');
      if (!SCENE_IDS.includes(scene)) return reply(res, 400, { error: `Choose a scene: ${SCENE_IDS.join(' or ')}.` });
      if (!(image instanceof Blob) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.type)) return reply(res, 400, { error: 'Upload a PNG, JPEG, or WebP portrait.' });
      if (image.size > MAX_IMAGE) return reply(res, 413, { error: 'Image must be at most 6 MB.' });

      const upload = Buffer.from(await image.arrayBuffer());
      const result = await generateScene({
        sceneId: scene, upload, maxAttempts, minSimilarity,
        deps: { ...deps, log: (...a) => log.warn('[gate]', ...a) }
      });
      const mime = deps.sniffMime(result.image);
      return reply(res, 200, {
        image: `data:${mime};base64,${result.image.toString('base64')}`,
        scene, caption: result.caption,
        checks: summarizeAttempts(result.attempts)
      });
    } catch (err) {
      if (err.code === 'QUALITY_GATE') {
        log.warn('Quality gate rejected all attempts:', JSON.stringify(summarizeAttempts(err.attempts)));
        return reply(res, 422, { error: err.message, code: err.code, checks: summarizeAttempts(err.attempts) });
      }
      if (err.status && err.status < 500) return reply(res, err.status, { error: err.message, code: err.code });
      log.error('Generation error:', err, err.detail || '');
      return reply(res, 502, { error: 'Image generation failed. Please try again in a moment.' });
    }
  }

  return http.createServer(async (req, res) => {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (pathname === '/health' && req.method === 'GET') return reply(res, 200, { status: 'ok' });
    if (pathname === '/api/scenes' && req.method === 'GET') {
      return reply(res, 200, { scenes: SCENE_IDS.map((id) => ({ id, caption: SCENES[id].caption })) });
    }
    if (pathname === '/api/generate') {
      if (req.method !== 'POST') return reply(res, 405, { error: 'Use POST.' });
      return generate(req, res);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405, { error: 'Method not allowed.' });
    if (!Object.hasOwn(TYPES, pathname)) return reply(res, 404, { error: 'Not found.' });
    try {
      const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
      const contents = await readFile(path.join(root, filename));
      res.writeHead(200, { 'content-type': TYPES[pathname], 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (err) { log.error(err); reply(res, 500, { error: 'Could not serve file.' }); }
  });
}

async function main() {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  let deps = null;
  if (accountId && apiToken) {
    const face = await import('./src/face.js');
    const { createCloudflareClient } = await import('./src/cloudflare.js');
    await face.loadFaceModels();
    const cf = createCloudflareClient({ accountId, apiToken });
    deps = {
      prepareReference: face.prepareReference,
      checkIdentity: face.checkIdentity,
      toJudgeJpeg: face.toJudgeJpeg,
      sniffMime: face.sniffMime,
      generateImage: cf.generateImage,
      judgeScene: cf.judgeScene
    };
  } else {
    console.warn('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set: generation is disabled.');
  }
  const server = createApp({
    deps,
    config: {
      maxAttempts: Number(process.env.MAX_ATTEMPTS || 3),
      minSimilarity: Number(process.env.IDENTITY_MIN_SIMILARITY || 0.40),
      rateLimit: Number(process.env.RATE_LIMIT || 6)
    }
  });
  server.requestTimeout = 200_000;
  const port = Number(process.env.PORT || 10000);
  server.listen(port, '0.0.0.0', () => console.log(`Beanstalk Studio listening on 0.0.0.0:${port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

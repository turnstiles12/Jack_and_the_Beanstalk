import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, createRateLimiter } from '../server.js';
import { GateError } from '../src/pipeline.js';
import { FaceError } from '../src/face.js';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const quiet = { warn() {}, error() {}, log() {} };

function deps(overrides = {}) {
  return {
    prepareReference: async () => ({ referencePng: PNG, descriptor: [1] }),
    checkIdentity: async () => ({ pass: true, similarity: 0.62, faceCount: 1 }),
    toJudgeJpeg: async (b) => b,
    sniffMime: () => 'image/png',
    generateImage: async () => PNG,
    judgeScene: async ({ sceneId }) => ({ best_caption: sceneId, matches_caption: true, person_count: 1, face_clearly_visible: true, reason: 'ok' }),
    ...overrides
  };
}

async function withServer(app, fn) {
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => app.close(r)); }
}

function form(scene, type = 'image/jpeg') {
  const f = new FormData();
  f.append('image', new Blob([Buffer.from('fake')], { type }), 'p.jpg');
  if (scene !== undefined) f.append('scene', scene);
  return f;
}

test('lists exactly the two scenes', async () => {
  await withServer(createApp({ deps: deps(), config: { log: quiet } }), async (base) => {
    const body = await (await fetch(`${base}/api/scenes`)).json();
    assert.deepEqual(body.scenes.map((s) => s.caption), ['Jack is planting the seeds.', 'Jack is climbing the beanstalk.']);
  });
});

test('generates each of the two scenes and reports the checks', async () => {
  await withServer(createApp({ deps: deps(), config: { log: quiet } }), async (base) => {
    for (const scene of ['planting', 'climbing']) {
      const res = await fetch(`${base}/api/generate`, { method: 'POST', body: form(scene) });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.scene, scene);
      assert.match(body.image, /^data:image\/png;base64,/);
      assert.equal(body.checks[0].identity.pass, true);
      assert.equal(body.checks[0].scene.pass, true);
    }
  });
});

test('refuses the old characters and any other scene', async () => {
  let generated = 0;
  const d = deps({ generateImage: async () => { generated++; return PNG; } });
  await withServer(createApp({ deps: d, config: { log: quiet } }), async (base) => {
    for (const scene of ['giant', 'princess', 'jack', '', undefined]) {
      const res = await fetch(`${base}/api/generate`, { method: 'POST', body: form(scene) });
      assert.equal(res.status, 400, `scene=${scene}`);
    }
  });
  assert.equal(generated, 0);
});

test('explains bad uploads (no face / several faces) with 422', async () => {
  const d = deps({ prepareReference: async () => { throw new FaceError('MULTIPLE_FACES', 'one face please'); } });
  await withServer(createApp({ deps: d, config: { log: quiet } }), async (base) => {
    const res = await fetch(`${base}/api/generate`, { method: 'POST', body: form('planting') });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, 'MULTIPLE_FACES');
  });
});

test('never returns an image when the quality gate rejects every attempt', async () => {
  const d = deps({ checkIdentity: async () => ({ pass: false, similarity: 0.1, faceCount: 1 }) });
  await withServer(createApp({ deps: d, config: { log: quiet, maxAttempts: 2 } }), async (base) => {
    const res = await fetch(`${base}/api/generate`, { method: 'POST', body: form('climbing') });
    const body = await res.json();
    assert.equal(res.status, 422);
    assert.equal(body.code, 'QUALITY_GATE');
    assert.equal(body.image, undefined);
    assert.equal(body.checks.length, 2);
  });
});

test('upstream failures become a clean 502', async () => {
  const d = deps({ generateImage: async () => { throw new Error('boom'); } });
  await withServer(createApp({ deps: d, config: { log: quiet } }), async (base) => {
    const res = await fetch(`${base}/api/generate`, { method: 'POST', body: form('planting') });
    assert.equal(res.status, 502);
    assert.doesNotMatch((await res.json()).error, /boom/);
  });
});

test('503 without credentials, 429 when rate-limited, 405 on GET', async () => {
  await withServer(createApp({ deps: null, config: { log: quiet } }), async (base) => {
    assert.equal((await fetch(`${base}/api/generate`, { method: 'POST', body: form('planting') })).status, 503);
    assert.equal((await fetch(`${base}/api/generate`)).status, 405);
  });
  await withServer(createApp({ deps: deps(), config: { log: quiet, rateLimit: 1 } }), async (base) => {
    assert.equal((await fetch(`${base}/api/generate`, { method: 'POST', body: form('planting') })).status, 200);
    assert.equal((await fetch(`${base}/api/generate`, { method: 'POST', body: form('planting') })).status, 429);
  });
});

test('rate limiter window resets', () => {
  let t = 0;
  const allow = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
  assert.deepEqual([allow('a'), allow('a'), allow('a'), allow('b')], [true, true, false, true]);
  t = 1000;
  assert.equal(allow('a'), true);
});

test('serves the page with only the two scene buttons', async () => {
  await withServer(createApp({ deps: deps(), config: { log: quiet } }), async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const scenes = [...html.matchAll(/data-scene="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(scenes, ['planting', 'climbing']);
    assert.doesNotMatch(html, /data-character|data-style/);
  });
});

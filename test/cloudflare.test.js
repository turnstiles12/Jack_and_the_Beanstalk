import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudflareClient, parseVerdict } from '../src/cloudflare.js';

const ok = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });

test('generateImage sends the prompt and the cropped reference as multipart', async () => {
  let seen;
  const cf = createCloudflareClient({ accountId: 'acc', apiToken: 'tok', fetchImpl: async (url, init) => { seen = { url, init }; return ok({ image: Buffer.from('png').toString('base64') }); } });
  const img = await cf.generateImage({ prompt: 'p', referencePng: Buffer.from('ref') });
  assert.equal(img.toString(), 'png');
  assert.match(seen.url, /accounts\/acc\/ai\/run\/@cf\/black-forest-labs\/flux-2-klein/);
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.body.get('prompt'), 'p');
  assert.equal(seen.init.body.get('width'), '768');
  assert.ok(seen.init.body.get('input_image_0') instanceof Blob);
});

test('judgeScene sends the image to the vision model and parses JSON', async () => {
  const bodies = [];
  const cf = createCloudflareClient({ accountId: 'a', apiToken: 't', fetchImpl: async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return ok({ response: '{"best_caption":"climbing","matches_caption":true,"person_count":1,"face_clearly_visible":true,"reason":"x"}' });
  } });
  const v = await cf.judgeScene({ sceneId: 'climbing', jpeg: Buffer.from('jpg') });
  assert.equal(v.best_caption, 'climbing');
  assert.match(bodies[0].messages[0].content[1].image_url.url, /^data:image\/jpeg;base64,/);
  assert.ok(bodies[0].response_format);
});

test('judgeScene falls back to plain JSON prompting if structured output is rejected', async () => {
  let n = 0;
  const cf = createCloudflareClient({ accountId: 'a', apiToken: 't', fetchImpl: async (url, init) => {
    n++;
    if (JSON.parse(init.body).response_format) return new Response('{"success":false}', { status: 400 });
    return ok({ response: 'Sure: {"best_caption":"planting","matches_caption":true,"person_count":1,"face_clearly_visible":true,"reason":"x"}' });
  } });
  assert.equal((await cf.judgeScene({ sceneId: 'planting', jpeg: Buffer.from('j') })).best_caption, 'planting');
  assert.equal(n, 2);
});

test('upstream errors are raised, not swallowed', async () => {
  const cf = createCloudflareClient({ accountId: 'a', apiToken: 't', fetchImpl: async () => new Response('{"success":false,"errors":[{"message":"no"}]}', { status: 403 }) });
  await assert.rejects(cf.generateImage({ prompt: 'p', referencePng: Buffer.from('r') }), (e) => e.status === 502);
});

test('parseVerdict handles objects, JSON strings, wrapped JSON and garbage', () => {
  assert.deepEqual(parseVerdict({ a: 1 }), { a: 1 });
  assert.deepEqual(parseVerdict('```json\n{"a":2}\n```'), { a: 2 });
  assert.equal(parseVerdict('no json here'), null);
  assert.equal(parseVerdict(undefined), null);
});

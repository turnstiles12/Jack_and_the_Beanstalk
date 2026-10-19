import test from 'node:test';
import assert from 'node:assert/strict';
import { generateScene, summarizeAttempts } from '../src/pipeline.js';
import { buildPrompt } from '../src/scenes.js';

const verdict = (scene, extra = {}) => ({ best_caption: scene, matches_caption: true, person_count: 1, face_clearly_visible: true, reason: 'ok', ...extra });

function fakeDeps({ identity = [], scenes = [] } = {}) {
  const calls = { generate: [], judge: 0 };
  return {
    calls,
    deps: {
      prepareReference: async () => ({ referencePng: Buffer.from('ref'), descriptor: [1] }),
      generateImage: async (args) => { calls.generate.push(args); return Buffer.from(`img${calls.generate.length}`); },
      checkIdentity: async () => identity.shift() ?? { pass: true, similarity: 0.6, faceCount: 1 },
      toJudgeJpeg: async (b) => b,
      judgeScene: async ({ sceneId }) => { calls.judge++; return scenes.shift() ?? verdict(sceneId); }
    }
  };
}

test('returns the first picture that passes both checks, with the scene prompt', async () => {
  const { deps, calls } = fakeDeps();
  const out = await generateScene({ sceneId: 'climbing', upload: Buffer.from('x'), deps });
  assert.equal(out.caption, 'Jack is climbing the beanstalk.');
  assert.equal(calls.generate.length, 1);
  assert.equal(calls.generate[0].prompt, buildPrompt('climbing'));
});

test('retries when the face does not match, without paying for a scene check', async () => {
  const { deps, calls } = fakeDeps({ identity: [{ pass: false, similarity: 0.1, faceCount: 1 }] });
  const out = await generateScene({ sceneId: 'planting', upload: Buffer.from('x'), deps });
  assert.equal(calls.generate.length, 2);
  assert.equal(calls.judge, 1);
  assert.equal(out.image.toString(), 'img2');
});

test('retries when the scene is wrong', async () => {
  const { deps, calls } = fakeDeps({ scenes: [verdict('climbing', { matches_caption: false })] });
  const out = await generateScene({ sceneId: 'planting', upload: Buffer.from('x'), deps });
  assert.equal(calls.generate.length, 2);
  assert.equal(out.image.toString(), 'img2');
});

test('fails closed after the last attempt instead of returning a bad picture', async () => {
  const bad = { pass: false, similarity: 0.05, faceCount: 1 };
  const { deps, calls } = fakeDeps({ identity: [bad, { pass: true, similarity: 0.5, faceCount: 1 }, bad], scenes: [verdict('neither')] });
  await assert.rejects(
    generateScene({ sceneId: 'planting', upload: Buffer.from('x'), deps, maxAttempts: 3 }),
    (err) => {
      assert.equal(err.status, 422);
      assert.equal(err.code, 'QUALITY_GATE');
      const summary = summarizeAttempts(err.attempts);
      assert.equal(summary.length, 3);
      assert.equal(summary[1].scene.pass, false);
      assert.equal(summary[1].scene.best, 'neither');
      return true;
    }
  );
  assert.equal(calls.generate.length, 3);
});

test('a failing judge call fails the request (never skips the scene check)', async () => {
  const { deps } = fakeDeps();
  deps.judgeScene = async () => { throw Object.assign(new Error('upstream down'), { status: 502 }); };
  await assert.rejects(generateScene({ sceneId: 'planting', upload: Buffer.from('x'), deps }), /upstream down/);
});

test('rejects anything that is not one of the two scenes before generating', async () => {
  const { deps, calls } = fakeDeps();
  for (const sceneId of ['jack', 'giant', '', 'constructor']) {
    await assert.rejects(generateScene({ sceneId, upload: Buffer.from('x'), deps }), (e) => e.status === 400);
  }
  assert.equal(calls.generate.length, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENES, SCENE_IDS, buildPrompt, buildJudgePrompt, judgeVerdictPasses, isScene } from '../src/scenes.js';

test('exactly two scenes exist, with the required captions', () => {
  assert.deepEqual(SCENE_IDS, ['planting', 'climbing']);
  assert.equal(SCENES.planting.caption, 'Jack is planting the seeds.');
  assert.equal(SCENES.climbing.caption, 'Jack is climbing the beanstalk.');
  for (const id of ['jack', 'giant', 'princess', 'harper', 'guardian', '', undefined, '__proto__', 'toString']) {
    assert.equal(isScene(id), false, `${id} must not be a scene`);
  }
});

test('prompts describe the scene action and demand the same face', () => {
  const planting = buildPrompt('planting');
  const climbing = buildPrompt('climbing');
  assert.match(planting, /kneels/);
  assert.match(planting, /bean into a small hole/);
  assert.match(planting, /no beanstalk yet/i);
  assert.match(climbing, /climbing the beanstalk/);
  assert.match(climbing, /hands gripping/);
  for (const p of [planting, climbing]) {
    assert.match(p, /Keep their exact face/);
    assert.match(p, /Exactly one person/);
    assert.match(p, /patched green wool tunic/); // same costume in both = same story
  }
  assert.throws(() => buildPrompt('giant'));
});

test('judge prompt contrasts the two captions', () => {
  const p = buildJudgePrompt('climbing');
  assert.match(p, /Jack is climbing the beanstalk/);
  assert.match(p, /Jack is planting the seeds/);
});

test('scene verdict is strict', () => {
  const ok = { best_caption: 'planting', matches_caption: true, person_count: 1, face_clearly_visible: true, reason: '' };
  assert.equal(judgeVerdictPasses('planting', ok), true);
  assert.equal(judgeVerdictPasses('climbing', ok), false);
  assert.equal(judgeVerdictPasses('planting', { ...ok, best_caption: 'neither' }), false);
  assert.equal(judgeVerdictPasses('planting', { ...ok, matches_caption: false }), false);
  assert.equal(judgeVerdictPasses('planting', { ...ok, person_count: 2 }), false);
  assert.equal(judgeVerdictPasses('planting', { ...ok, face_clearly_visible: false }), false);
  assert.equal(judgeVerdictPasses('planting', null), false);
  assert.equal(judgeVerdictPasses('planting', {}), false);
});

// The only two scenes the app can produce. Both use the same story, costume and art style,
// so the two pictures read as pages from one book starring the same person.

export const SCENE_IDS = Object.freeze(['planting', 'climbing']);

const COSTUME =
  'a patched green wool tunic over a cream linen shirt, a rope belt, brown trousers and worn leather boots';

const STYLE =
  'Painterly classic storybook illustration with gouache textures and warm golden morning light. ' +
  'The face is painted realistically and in fine detail so the likeness is unmistakable.';

const IDENTITY =
  'The reference photo shows the real person who plays Jack. Keep their exact face so they are instantly recognisable: ' +
  'same face shape, eyes, eyebrows, nose, mouth, skin tone, hair colour, hairstyle, facial hair, glasses if any, age and gender. ' +
  'Do not beautify, de-age or change their ethnicity.';

export const SCENES = Object.freeze({
  planting: Object.freeze({
    id: 'planting',
    caption: 'Jack is planting the seeds.',
    action:
      'Jack is planting the magic beans. Jack kneels in the dark, freshly dug soil of a small vegetable patch beside a humble thatched cottage, ' +
      'pressing one glowing green bean into a small hole in the earth with one hand while holding the other beans in the open palm of the other hand. ' +
      'A small wooden trowel lies in the soil. There is no beanstalk yet: the ground around the hole is bare.',
    framing:
      "Medium shot from slightly above. Jack's face is turned three-quarters toward the viewer, well lit, unobstructed and large in the frame.",
    judge: {
      must: [
        'a person kneeling or crouching on the ground',
        'their hand placing a seed or bean into the soil',
        'a garden, field or patch of earth'
      ],
      mustNot: ['a tall or giant beanstalk', 'the person climbing or off the ground']
    }
  }),
  climbing: Object.freeze({
    id: 'climbing',
    caption: 'Jack is climbing the beanstalk.',
    action:
      'Jack is climbing the beanstalk. Jack is high up an enormous twisting beanstalk whose stems are as thick as tree trunks, ' +
      'both hands gripping the vine and one boot braced on a broad leaf, clearly mid-climb. ' +
      'Far below are a tiny thatched cottage and patchwork fields; above, the stalk rises into the clouds.',
    framing:
      "Medium shot. Jack looks back over one shoulder toward the viewer, so the face is well lit, unobstructed and large in the frame.",
    judge: {
      must: [
        'a person on a giant beanstalk or vine, off the ground',
        'their hands gripping the stalk as if climbing',
        'height: the ground, fields or houses are far below, or clouds are nearby'
      ],
      mustNot: ['the person standing or kneeling on the ground']
    }
  })
});

export function isScene(id) {
  return typeof id === 'string' && Object.hasOwn(SCENES, id);
}

export function buildPrompt(sceneId) {
  const scene = SCENES[sceneId];
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
  return [
    'A page from the fairy tale "Jack and the Beanstalk".',
    IDENTITY,
    `Scene: ${scene.action}`,
    `Jack wears ${COSTUME}.`,
    scene.framing,
    STYLE,
    'Exactly one person in the picture. No text, no logos, no watermark.'
  ].join(' ');
}

// Prompt for the vision model that checks a finished picture against its caption.
export function buildJudgePrompt(sceneId) {
  const scene = SCENES[sceneId];
  if (!scene) throw new Error(`Unknown scene: ${sceneId}`);
  const other = SCENES[SCENE_IDS.find((id) => id !== sceneId)];
  return [
    'You are checking an illustration for a children\'s book before it is published.',
    `Its caption is: "${scene.caption}"`,
    'Look only at what is actually visible in the image.',
    `It matches the caption only if it clearly shows ALL of: ${scene.judge.must.join('; ')}.`,
    `It does NOT match if it shows any of: ${scene.judge.mustNot.join('; ')}.`,
    'Also check that there is exactly one person and that their face is clearly visible (not hidden, turned away or tiny).',
    `For "best_caption", choose which caption fits best: "${scene.id}" (${scene.caption}), "${other.id}" (${other.caption}), or "neither".`,
    'Reply with JSON only.'
  ].join('\n');
}

export const JUDGE_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    best_caption: { type: 'string', enum: [...SCENE_IDS, 'neither'] },
    matches_caption: { type: 'boolean' },
    person_count: { type: 'integer' },
    face_clearly_visible: { type: 'boolean' },
    reason: { type: 'string' }
  },
  required: ['best_caption', 'matches_caption', 'person_count', 'face_clearly_visible', 'reason']
});

// Strict: every condition must hold. Anything unparseable fails.
export function judgeVerdictPasses(sceneId, verdict) {
  return Boolean(
    verdict &&
      verdict.best_caption === sceneId &&
      verdict.matches_caption === true &&
      Number(verdict.person_count) === 1 &&
      verdict.face_clearly_visible === true
  );
}

// Generate a scene and only return it if it passes BOTH checks:
//   1. identity: the face in the picture is the uploaded person (SFace cosine similarity)
//   2. scene:    a vision model confirms the picture shows the caption
// Otherwise retry with a fresh sample; after MAX attempts, fail rather than return a bad picture.
import { SCENES, buildPrompt, isScene, judgeVerdictPasses } from './scenes.js';

export class GateError extends Error {
  constructor(message, attempts) {
    super(message);
    this.status = 422;
    this.code = 'QUALITY_GATE';
    this.attempts = attempts;
  }
}

export async function generateScene({ sceneId, upload, deps, maxAttempts = 3, minSimilarity = 0.40 }) {
  if (!isScene(sceneId)) {
    const err = new Error('Unknown scene.');
    err.status = 400;
    throw err;
  }
  const { prepareReference, checkIdentity, toJudgeJpeg, generateImage, judgeScene, log = () => {} } = deps;

  // Throws FaceError (422) for no face / several faces / tiny face.
  const reference = await prepareReference(upload);
  const prompt = buildPrompt(sceneId);
  const attempts = [];

  for (let n = 1; n <= maxAttempts; n++) {
    const image = await generateImage({ prompt, referencePng: reference.referencePng });
    const identity = await checkIdentity(reference.descriptor, image, minSimilarity);
    const attempt = { n, identity, scene: null };
    attempts.push(attempt);
    if (!identity.pass) {
      log(`attempt ${n}: identity failed`, identity);
      continue; // don't spend a judge call on a picture that already fails
    }
    const verdict = await judgeScene({ sceneId, jpeg: await toJudgeJpeg(image) });
    attempt.scene = { pass: judgeVerdictPasses(sceneId, verdict), verdict };
    if (!attempt.scene.pass) {
      log(`attempt ${n}: scene failed`, verdict);
      continue;
    }
    return { image, caption: SCENES[sceneId].caption, attempts };
  }

  throw new GateError(
    'We couldn’t make a picture that both looks like you and matches the scene. Try a brighter, front-facing photo and generate again.',
    attempts
  );
}

// Public summary of the checks (no descriptors or raw images).
export function summarizeAttempts(attempts) {
  return attempts.map((a) => ({
    attempt: a.n,
    identity: { pass: a.identity.pass, similarity: a.identity.similarity, faces: a.identity.faceCount },
    scene: a.scene ? { pass: a.scene.pass, best: a.scene.verdict?.best_caption ?? null, reason: a.scene.verdict?.reason ?? null } : null
  }));
}

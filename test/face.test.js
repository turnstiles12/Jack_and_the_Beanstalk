// Real-model tests of the identity check. Fixtures are the sample group photos that ship with the
// @vladmandic/face-api package (a devDependency used only for these photos), so no faces are committed here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import sharp from 'sharp';
import {
  loadFaceModels, detectFaces, prepareReference, checkIdentity, faceSimilarity,
  similarityTransform, DEFAULT_MIN_SIMILARITY, REFERENCE_MAX_SIDE
} from '../src/face.js';

const require = createRequire(import.meta.url);
const DEMO = path.join(path.dirname(require.resolve('@vladmandic/face-api/package.json')), 'demo');
const sample = (i) => readFile(path.join(DEMO, `sample${i}.jpg`));

// Head-and-shoulders crop of one face from a group photo = a single-person "upload".
async function cropFace(buffer, face, scale = 2.2) {
  const meta = await sharp(buffer).resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).toBuffer({ resolveWithObject: true });
  const { x, y, width, height } = face.box;
  const side = Math.round(Math.max(width, height) * scale);
  const left = Math.max(0, Math.round(x + width / 2 - side / 2));
  const top = Math.max(0, Math.round(y + height / 2 - side / 2));
  return sharp(meta.data).extract({
    left, top, width: Math.min(side, meta.info.width - left), height: Math.min(side, meta.info.height - top)
  }).jpeg({ quality: 92 }).toBuffer();
}

let photo, faces;
test.before(async () => {
  await loadFaceModels();
  photo = await sample(5);
  ({ faces } = await detectFaces(photo));
});

test('similarity transform recovers a known rotation + scale + shift', () => {
  const src = [[10, 10], [50, 12], [30, 40], [15, 60], [45, 62]];
  const a = 1.5 * Math.cos(0.3), b = 1.5 * Math.sin(0.3);
  const dst = src.map(([x, y]) => [a * x - b * y + 7, b * x + a * y - 3]);
  const m = similarityTransform(src, dst);
  assert.ok(Math.abs(m.a - a) < 1e-9 && Math.abs(m.b - b) < 1e-9);
  assert.ok(Math.abs(m.tx - 7) < 1e-9 && Math.abs(m.ty + 3) < 1e-9);
});

test('rejects a group photo (several people)', async () => {
  await assert.rejects(prepareReference(photo), (e) => e.code === 'MULTIPLE_FACES' && e.status === 422);
});

test('rejects a photo without a face', async () => {
  const blank = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#7a9a6a' } }).png().toBuffer();
  await assert.rejects(prepareReference(blank), (e) => e.code === 'NO_FACE');
});

test('rejects a face that is too small to keep a likeness', async () => {
  const tiny = await sharp(await cropFace(photo, faces[0])).resize(40).extend({ top: 500, bottom: 500, left: 700, right: 700, background: '#fff' }).png().toBuffer();
  await assert.rejects(prepareReference(tiny), (e) => e.code === 'FACE_TOO_SMALL' || e.code === 'NO_FACE');
});

test('crops a single-person photo to a < 512px face reference', async () => {
  const ref = await prepareReference(await cropFace(photo, faces[0], 1.3));
  const meta = await sharp(ref.referencePng).metadata();
  assert.ok(meta.width <= REFERENCE_MAX_SIDE && meta.height <= REFERENCE_MAX_SIDE);
  assert.equal(ref.descriptor.length, 128);
});

test('same person still matches after resize, re-crop, lighting change and a painterly filter', async () => {
  const upload = await cropFace(photo, faces[0], 1.3);
  const ref = await prepareReference(upload);
  const variants = {
    smaller: await sharp(upload).resize(300).jpeg({ quality: 70 }).toBuffer(),
    darker: await sharp(upload).modulate({ brightness: 0.75, saturation: 1.3 }).toBuffer(),
    painterly: await sharp(upload).median(5).modulate({ saturation: 1.4 }).sharpen().jpeg({ quality: 80 }).toBuffer(),
    embedded: await sharp(upload).resize(380).extend({ top: 500, bottom: 150, left: 200, right: 200, background: '#4b6b3b' }).png().toBuffer()
  };
  for (const [name, img] of Object.entries(variants)) {
    const r = await checkIdentity(ref.descriptor, img);
    assert.ok(r.pass, `${name}: similarity ${r.similarity} should be >= ${DEFAULT_MIN_SIMILARITY}`);
  }
});

test('different people are rejected (every pair of people in the same photo)', async () => {
  for (const i of [1, 2, 3, 4, 5, 6]) {
    const { faces: group } = await detectFaces(await sample(i));
    for (let a = 0; a < group.length; a++) {
      for (let b = a + 1; b < group.length; b++) {
        const s = faceSimilarity(group[a].descriptor, group[b].descriptor);
        assert.ok(s < DEFAULT_MIN_SIMILARITY, `sample${i} faces ${a}/${b} similarity ${s.toFixed(3)} should be < ${DEFAULT_MIN_SIMILARITY}`);
      }
    }
  }
});

test('the same person in two different photos is accepted', async () => {
  // One woman appears in both sample1 and sample3 (different day, lighting and expression).
  const [{ faces: a }, { faces: b }] = await Promise.all([detectFaces(await sample(1)), detectFaces(await sample(3))]);
  const best = Math.max(...a.flatMap((x) => b.map((y) => faceSimilarity(x.descriptor, y.descriptor))));
  assert.ok(best >= DEFAULT_MIN_SIMILARITY, `best cross-photo similarity ${best.toFixed(3)}`);
});

test('checkIdentity fails a picture of someone else and a picture with no face', async () => {
  const ref = await prepareReference(await cropFace(photo, faces[0], 1.3));
  const other = await checkIdentity(ref.descriptor, await cropFace(photo, faces[1], 1.3));
  assert.equal(other.pass, false);
  const blank = await sharp({ create: { width: 768, height: 1024, channels: 3, background: '#88aa77' } }).png().toBuffer();
  const none = await checkIdentity(ref.descriptor, blank);
  assert.deepEqual([none.pass, none.faceCount], [false, 0]);
});

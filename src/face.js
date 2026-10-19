// Face detection + identity comparison, run on the server with ONNX Runtime (native CPU).
//  - Detection + 5 landmarks: MTCNN (src/mtcnn.js).
//  - Identity: OpenCV Zoo SFace (Apache-2.0), a margin-loss face-recognition model, on 112x112 faces
//    aligned to the standard 5-point template. Same person: cosine similarity >= DEFAULT_MIN_SIMILARITY.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { loadMtcnn, detect } from './mtcnn.js';

sharp.cache(false); // keep memory flat on small instances

// Stored as two parts so each file stays well under Git hosting / transfer limits; joined and checksummed at load.
const SFACE_PARTS = ['0', '1'].map((n) => path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models', `face_recognition_sface_2021dec.onnx.part${n}`));
const SFACE_SHA256 = '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79';
// ArcFace/SFace 112x112 template: image-left eye, image-right eye, nose tip, image-left mouth corner, image-right mouth corner.
const TEMPLATE = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];

export const ANALYSIS_MAX_SIDE = 1600; // decode size for detection
export const REFERENCE_MAX_SIDE = 480; // FLUX.2 reference images must be under 512x512
export const MIN_FACE_PX = 64; // smallest usable face (box width at ANALYSIS_MAX_SIDE scale)
// OpenCV suggests 0.363 for SFace; we use 0.40 for extra margin against look-alikes (measured: different
// people in the same photo reached 0.36; the same person in two different photos scored 0.43-0.68).
export const DEFAULT_MIN_SIMILARITY = 0.40;

export class FaceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.status = 422;
  }
}

let ready, sface, ort;
export function loadFaceModels() {
  ready ??= (async () => {
    process.env.ORT_DISABLE_TELEMETRY ??= '1'; // must be set before the native library loads
    ort = await import('onnxruntime-node');
    await loadMtcnn(ort);
    const bytes = Buffer.concat(await Promise.all(SFACE_PARTS.map((p) => readFile(p))));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== SFACE_SHA256) throw new Error(`SFace model checksum mismatch (${digest}).`);
    sface = await ort.InferenceSession.create(bytes, { logSeverityLevel: 3, intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false });
  })();
  return ready;
}

// Least-squares similarity transform (rotation + uniform scale + translation) mapping src -> dst points.
export function similarityTransform(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let a = 0, b = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx, y = src[i][1] - sy, u = dst[i][0] - dx, v = dst[i][1] - dy;
    a += x * u + y * v; b += x * v - y * u; norm += x * x + y * y;
  }
  a /= norm; b /= norm;
  // [u, v] = [[a, -b], [b, a]] * [x, y] + [tx, ty]
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

// Warp the face into the 112x112 template and return an NCHW RGB float tensor (0..255), as SFace expects.
function alignFace(img, points) {
  const { a, b, tx, ty } = similarityTransform(points, TEMPLATE);
  const det = a * a + b * b;
  const out = new Float32Array(3 * 112 * 112);
  const plane = 112 * 112;
  for (let v = 0; v < 112; v++) {
    for (let u = 0; u < 112; u++) {
      // inverse transform: dst (u, v) -> src (x, y)
      const pu = u - tx, pv = v - ty;
      const x = (a * pu + b * pv) / det, y = (-b * pu + a * pv) / det;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      for (let c = 0; c < 3; c++) {
        const px = (xx, yy) => (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) ? 0 : img.data[(yy * img.width + xx) * 3 + c];
        const val = px(x0, y0) * (1 - fx) * (1 - fy) + px(x0 + 1, y0) * fx * (1 - fy) + px(x0, y0 + 1) * (1 - fx) * fy + px(x0 + 1, y0 + 1) * fx * fy;
        out[c * plane + v * 112 + u] = val;
      }
    }
  }
  return out;
}

async function embed(img, points) {
  const input = new ort.Tensor('float32', alignFace(img, points), [1, 3, 112, 112]);
  const result = await sface.run({ [sface.inputNames[0]]: input });
  const vec = Array.from(result[sface.outputNames[0]].data);
  const len = Math.hypot(...vec) || 1;
  return vec.map((x) => x / len);
}

// Decode any PNG/JPEG/WebP, apply EXIF rotation, flatten alpha, and cap size.
async function decode(buffer, maxSide = ANALYSIS_MAX_SIDE) {
  const { data, info } = await sharp(buffer, { failOn: 'error' })
    .rotate()
    .resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

// Detection runs on a copy at most DETECT_MAX_SIDE wide; boxes and landmarks are scaled back up and the
// face descriptor is computed from the full-resolution pixels.
const DETECT_MAX_SIDE = 960;

export async function detectFaces(buffer) {
  await loadFaceModels();
  const img = await decode(buffer);
  const scale = Math.min(1, DETECT_MAX_SIDE / Math.max(img.width, img.height));
  let small = img;
  if (scale < 1) {
    const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    const data = await sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } }).resize(w, h, { fit: 'fill' }).raw().toBuffer();
    small = { data, width: w, height: h };
  }
  const found = await detect(small, { minSize: Math.max(24, Math.round(MIN_FACE_PX * scale * 0.6)) });
  const faces = [];
  for (const f of found) {
    const points = f.points.map(([x, y]) => [x / scale, y / scale]);
    faces.push({
      score: f.score,
      box: { x: f.box.x / scale, y: f.box.y / scale, width: f.box.width / scale, height: f.box.height / scale },
      points,
      descriptor: await embed(img, points)
    });
  }
  faces.sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
  return { width: img.width, height: img.height, faces, image: img };
}

// Cosine similarity of two L2-normalised descriptors (1 = identical, ~0 = unrelated).
export function faceSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) throw new Error('Descriptors must be the same length.');
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

// The subject is the largest face. Other faces are tolerated only if they are clearly background
// (less than a quarter of the subject's area); otherwise we can't know who the user means.
export function pickSubject(faces) {
  if (!faces.length) throw new FaceError('NO_FACE', 'We couldn’t find a face in that photo. Try a clear, well-lit photo of one face.');
  const [main, second] = faces;
  const area = (f) => f.box.width * f.box.height;
  if (second && area(second) > area(main) / 4) {
    throw new FaceError('MULTIPLE_FACES', 'That photo has more than one person in it. Please use a photo of just one face.');
  }
  if (main.box.width < MIN_FACE_PX) {
    throw new FaceError('FACE_TOO_SMALL', 'The face in that photo is too small. Try a closer photo where the face fills more of the frame.');
  }
  return main;
}

// Crop a head-and-shoulders square around the face so the < 512px reference spends its pixels on the face.
export async function prepareReference(buffer) {
  const { faces, image } = await detectFaces(buffer);
  const subject = pickSubject(faces);
  const { x, y, width, height } = subject.box;
  const side = Math.min(Math.round(Math.max(width, height) * 2.4), image.width, image.height);
  const cx = x + width / 2;
  const cy = y + height / 2 + height * 0.1; // a little extra room for neck/shoulders
  const left = Math.round(Math.min(Math.max(cx - side / 2, 0), image.width - side));
  const top = Math.round(Math.min(Math.max(cy - side / 2, 0), image.height - side));
  const referencePng = await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
    .extract({ left, top, width: side, height: side })
    .resize(REFERENCE_MAX_SIDE, REFERENCE_MAX_SIDE, { fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  return { referencePng, descriptor: subject.descriptor, faceScore: subject.score };
}

// Does the generated picture show the same person as the reference?
export async function checkIdentity(referenceDescriptor, outputBuffer, minSimilarity = DEFAULT_MIN_SIMILARITY) {
  const { faces } = await detectFaces(outputBuffer);
  if (!faces.length) return { pass: false, similarity: null, faceCount: 0 };
  const similarity = faceSimilarity(referenceDescriptor, faces[0].descriptor);
  return { pass: similarity >= minSimilarity, similarity: Number(similarity.toFixed(4)), faceCount: faces.length };
}

// Small JPEG for the vision judge (keeps tokens and latency down).
export async function toJudgeJpeg(buffer) {
  return sharp(buffer).resize(640, 640, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

export function sniffMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.slice(0, 4).toString() === 'RIFF' && buffer.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

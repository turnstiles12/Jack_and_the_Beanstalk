// MTCNN face detector (Zhang et al. 2016) running on ONNX Runtime.
// Weights: facenet-pytorch's pretrained P/R/O-Nets (MIT), converted to ONNX (see models/README.md).
// Returns face boxes + the 5 landmarks used for alignment:
//   [image-left eye, image-right eye, nose tip, image-left mouth corner, image-right mouth corner].
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MODELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models');
const THRESHOLDS = [0.6, 0.7, 0.8];
const FACTOR = 0.709;

let nets, ort;
export async function loadMtcnn(ortModule) {
  ort = ortModule;
  if (!nets) {
    const opts = { logSeverityLevel: 3, intraOpNumThreads: 1, interOpNumThreads: 1, enableCpuMemArena: false };
    nets = {
      p: await ort.InferenceSession.create(path.join(MODELS, 'mtcnn_pnet.onnx'), opts),
      r: await ort.InferenceSession.create(path.join(MODELS, 'mtcnn_rnet.onnx'), opts),
      o: await ort.InferenceSession.create(path.join(MODELS, 'mtcnn_onet.onnx'), opts)
    };
  }
  return nets;
}

const norm = (v) => (v - 127.5) * 0.0078125;

function toNCHW(raw, width, height) {
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = norm(raw[i * 3]);
    out[plane + i] = norm(raw[i * 3 + 1]);
    out[2 * plane + i] = norm(raw[i * 3 + 2]);
  }
  return out;
}

// Area-averaged crop of the square [x, y, x+size) from img into an s x s NCHW patch; outside = black.
function cropPatch(img, x, y, size, s, out, offset) {
  const plane = s * s;
  const step = size / s;
  const k = Math.max(1, Math.ceil(step));
  for (let v = 0; v < s; v++) {
    for (let u = 0; u < s; u++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < k; j++) {
        const sy = Math.floor(y + (v + (j + 0.5) / k) * step);
        for (let i = 0; i < k; i++) {
          const sx = Math.floor(x + (u + (i + 0.5) / k) * step);
          if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
          const p = (sy * img.width + sx) * 3;
          r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2];
        }
      }
      const n = k * k;
      out[offset + v * s + u] = norm(r / n);
      out[offset + plane + v * s + u] = norm(g / n);
      out[offset + 2 * plane + v * s + u] = norm(b / n);
    }
  }
}

function iou(a, b, method) {
  const w = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) + 1);
  const h = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) + 1);
  const inter = w * h;
  const area = (q) => (q.x2 - q.x1 + 1) * (q.y2 - q.y1 + 1);
  return method === 'min' ? inter / Math.min(area(a), area(b)) : inter / (area(a) + area(b) - inter);
}

function nms(boxes, threshold, method = 'union') {
  const sorted = [...boxes].sort((a, b) => b.score - a.score);
  const keep = [];
  for (const box of sorted) if (keep.every((k) => iou(k, box, method) <= threshold)) keep.push(box);
  return keep;
}

function square(b) {
  const w = b.x2 - b.x1, h = b.y2 - b.y1, l = Math.max(w, h);
  const x1 = b.x1 + w * 0.5 - l * 0.5, y1 = b.y1 + h * 0.5 - l * 0.5;
  return { ...b, x1, y1, x2: x1 + l, y2: y1 + l };
}

function regress(b, reg) {
  const w = b.x2 - b.x1 + 1, h = b.y2 - b.y1 + 1;
  return { ...b, x1: b.x1 + reg[0] * w, y1: b.y1 + reg[1] * h, x2: b.x2 + reg[2] * w, y2: b.y2 + reg[3] * h };
}

async function refine(net, img, boxes, s, threshold) {
  if (!boxes.length) return { boxes: [], out: null };
  const patch = 3 * s * s;
  const data = new Float32Array(boxes.length * patch);
  boxes.forEach((b, i) => cropPatch(img, Math.trunc(b.x1), Math.trunc(b.y1), Math.trunc(b.x2) - Math.trunc(b.x1) + 1, s, data, i * patch));
  const out = await net.run({ input: new ort.Tensor('float32', data, [boxes.length, 3, s, s]) });
  const prob = out.prob.data, reg = out.reg.data, pts = out.points?.data;
  const kept = [];
  boxes.forEach((b, i) => {
    const score = prob[i * 2 + 1];
    if (score > threshold) kept.push({ ...b, score, reg: Array.from(reg.slice(i * 4, i * 4 + 4)), pts: pts ? Array.from(pts.slice(i * 10, i * 10 + 10)) : null });
  });
  return { boxes: kept };
}

// img: { data: Uint8 RGB, width, height }
export async function detect(img, { minSize = 40 } = {}) {
  const { p, r, o } = nets;
  const m = 12 / minSize;
  let minl = Math.min(img.width, img.height) * m;
  const scales = [];
  for (let s = m; minl >= 12; s *= FACTOR, minl *= FACTOR) scales.push(s);

  // Stage 1: P-Net over an image pyramid.
  let candidates = [];
  const source = sharp(img.data, { raw: { width: img.width, height: img.height, channels: 3 } });
  for (const scale of scales) {
    const hs = Math.ceil(img.height * scale), ws = Math.ceil(img.width * scale);
    const raw = await source.clone().resize(ws, hs, { fit: 'fill', kernel: 'linear' }).raw().toBuffer();
    const out = await p.run({ input: new ort.Tensor('float32', toNCHW(raw, ws, hs), [1, 3, hs, ws]) });
    const [, , oh, ow] = out.prob.dims;
    const prob = out.prob.data, reg = out.reg.data, plane = oh * ow;
    const found = [];
    for (let yy = 0; yy < oh; yy++) {
      for (let xx = 0; xx < ow; xx++) {
        const i = yy * ow + xx, score = prob[plane + i];
        if (score < THRESHOLDS[0]) continue;
        found.push({
          x1: Math.floor((2 * xx + 1) / scale), y1: Math.floor((2 * yy + 1) / scale),
          x2: Math.floor((2 * xx + 12) / scale), y2: Math.floor((2 * yy + 12) / scale),
          score, reg: [reg[i], reg[plane + i], reg[2 * plane + i], reg[3 * plane + i]]
        });
      }
    }
    candidates.push(...nms(found, 0.5));
  }
  candidates = nms(candidates, 0.7).map((b) => square(regress(b, b.reg)));

  // Stage 2: R-Net refines.
  let { boxes } = await refine(r, img, candidates, 24, THRESHOLDS[1]);
  boxes = nms(boxes, 0.7).map((b) => square(regress(b, b.reg)));

  // Stage 3: O-Net refines and adds landmarks.
  ({ boxes } = await refine(o, img, boxes, 48, THRESHOLDS[2]));
  const faces = boxes.map((b) => {
    const x1 = Math.trunc(b.x1), y1 = Math.trunc(b.y1);
    const w = Math.trunc(b.x2) - x1 + 1, h = Math.trunc(b.y2) - y1 + 1;
    const points = [0, 1, 2, 3, 4].map((k) => [w * b.pts[k] + x1 - 1, h * b.pts[k + 5] + y1 - 1]);
    return { ...regress(b, b.reg), points };
  });
  return nms(faces, 0.7, 'min').map((f) => ({
    score: f.score,
    box: { x: f.x1, y: f.y1, width: f.x2 - f.x1, height: f.y2 - f.y1 },
    points: f.points
  }));
}

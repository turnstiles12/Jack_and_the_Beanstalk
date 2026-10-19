#!/usr/bin/env node
// Live end-to-end check against a running server (local or Render).
//
//   node scripts/eval-live.mjs --url https://your-app.onrender.com --faces ./eval-faces --runs 2
//
// For every face photo in --faces and each of the two scenes it calls /api/generate, saves the
// pictures to eval-out/, and re-scores likeness locally — including against every OTHER test face,
// so you can see the picture looks like *this* person rather than a generic face.
// Scene fidelity is reported from the server's vision check; look at eval-out/report.html too.
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { prepareReference, detectFaces, faceSimilarity, DEFAULT_MIN_SIMILARITY } from '../src/face.js';
import { SCENE_IDS, SCENES } from '../src/scenes.js';

const { values: args } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.EVAL_URL || 'http://localhost:10000' },
    faces: { type: 'string', default: 'eval-faces' },
    runs: { type: 'string', default: '1' },
    out: { type: 'string', default: 'eval-out' }
  }
});
const runs = Number(args.runs);
const files = (await readdir(args.faces)).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort();
if (!files.length) throw new Error(`No face photos in ${args.faces}`);
await mkdir(args.out, { recursive: true });

const people = [];
for (const file of files) {
  const buffer = await readFile(path.join(args.faces, file));
  const ref = await prepareReference(buffer);
  people.push({ name: path.parse(file).name, file, buffer, descriptor: ref.descriptor });
}

const rows = [];
for (const person of people) {
  for (const scene of SCENE_IDS) {
    for (let run = 1; run <= runs; run++) {
      const form = new FormData();
      const type = person.file.toLowerCase().endsWith('.png') ? 'image/png' : person.file.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
      form.append('image', new Blob([person.buffer], { type }), person.file);
      form.append('scene', scene);
      const t0 = Date.now();
      const res = await fetch(new URL('/api/generate', args.url), { method: 'POST', body: form });
      const body = await res.json().catch(() => ({}));
      const row = { person: person.name, scene, run, status: res.status, seconds: Math.round((Date.now() - t0) / 1000), checks: body.checks, error: body.error };
      if (res.ok) {
        const [, mime, b64] = body.image.match(/^data:(image\/\w+);base64,(.*)$/);
        const img = Buffer.from(b64, 'base64');
        row.file = `${person.name}-${scene}-${run}.${mime.endsWith('png') ? 'png' : 'jpg'}`;
        await writeFile(path.join(args.out, row.file), img);
        const { faces } = await detectFaces(img);
        if (faces.length) {
          row.self = faceSimilarity(person.descriptor, faces[0].descriptor);
          row.others = people.filter((p) => p !== person).map((p) => faceSimilarity(p.descriptor, faces[0].descriptor));
        }
      }
      rows.push(row);
      const fmt = (x) => (x == null ? '—' : x.toFixed(3));
      console.log(`${person.name} / ${scene} #${run}: HTTP ${res.status} in ${row.seconds}s, attempts ${body.checks?.length ?? '—'}, ` +
        `self ${fmt(row.self)}, best other ${fmt(row.others?.length ? Math.max(...row.others) : null)}${row.error ? ` — ${row.error}` : ''}`);
    }
  }
}

const ok = rows.filter((r) => r.status === 200);
const likeness = ok.filter((r) => r.self >= DEFAULT_MIN_SIMILARITY && (!r.others?.length || r.self > Math.max(...r.others)));
const summary = {
  url: args.url, requests: rows.length, delivered: ok.length,
  likenessConfirmed: likeness.length,
  meanAttempts: ok.length ? ok.reduce((s, r) => s + r.checks.length, 0) / ok.length : null,
  meanSelfSimilarity: ok.length ? ok.reduce((s, r) => s + (r.self ?? 0), 0) / ok.length : null
};
await writeFile(path.join(args.out, 'results.json'), JSON.stringify({ summary, rows }, null, 2));
const cell = (r) => `<figure><figcaption><b>${r.person}</b> — ${SCENES[r.scene].caption} #${r.run}<br>` +
  (r.file ? `<img src="${r.file}"><br>self ${r.self?.toFixed(3)} · best other ${r.others?.length ? Math.max(...r.others).toFixed(3) : '—'} · attempts ${r.checks.length}` : `HTTP ${r.status}: ${r.error}`) + '</figcaption></figure>';
await writeFile(path.join(args.out, 'report.html'), `<!doctype html><meta charset=utf-8><title>Beanstalk eval</title>
<style>body{font:14px system-ui;margin:24px}figure{display:inline-block;width:300px;margin:8px;vertical-align:top}img{width:100%}</style>
<h1>Beanstalk live eval</h1><pre>${JSON.stringify(summary, null, 2)}</pre>${rows.map(cell).join('')}`);
console.log('\n', summary, `\nReport: ${path.join(args.out, 'report.html')}`);
if (likeness.length !== rows.length) process.exitCode = 1;

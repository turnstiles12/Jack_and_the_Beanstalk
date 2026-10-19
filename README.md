# Beanstalk Studio — two scenes, same story, same person

Upload a photo of a face and get one of exactly two pictures from *Jack and the Beanstalk*, starring that person as Jack:

1. **planting** — "Jack is planting the seeds."
2. **climbing** — "Jack is climbing the beanstalk."

Both scenes share the same costume and art style, so they read as two pages of one book.

## What every picture has to pass

A picture is only returned if it passes **both** checks. Otherwise the server tries again (up to `MAX_ATTEMPTS`, default 3) and, if none pass, returns an error instead of a bad picture.

| Requirement | How it is checked |
|---|---|
| **It looks like the person** | The face in the picture is compared with the uploaded face using SFace face embeddings (cosine similarity ≥ `IDENTITY_MIN_SIMILARITY`, default 0.40). |
| **It shows the caption** | A vision model (`@cf/meta/llama-4-scout-17b-16e-instruct` on Workers AI) must pick this scene's caption over the other one, confirm the specific action (kneeling + bean into soil / gripping the stalk off the ground), see exactly one person, and see the face clearly. |

Uploads are checked too: no face, more than one person, or a face too small to keep a likeness → a clear 422 message. The server crops a head-and-shoulders reference from the photo, so the model's < 512 px reference is spent on the face.

## How it works

```
browser ──photo + scene──▶ server.js
                            ├─ src/face.js      find the face (MTCNN), crop reference, embed it (SFace)
                            ├─ src/cloudflare.js FLUX.2 [klein] generates the scene from the prompt + reference
                            ├─ src/face.js      same person?           ─┐ fail → retry
                            ├─ src/cloudflare.js vision model: scene?    ─┘ fail → retry
                            └─ returns image + caption + the check results
```

* `src/scenes.js` — the two scenes: prompts, captions, what the scene check requires. Nothing else can be generated.
* `src/pipeline.js` — generate → check → retry loop. Fails closed.
* Face models run locally with ONNX Runtime (see `models/README.md`). Peak memory is about 300 MB, so it fits a 512 MB instance.

## Deploy on Render

1. Push this folder to GitHub (or set Render's Root Directory to the folder that contains `package.json`).
2. **New → Web Service**, runtime **Node**. Build: `npm ci`. Start: `npm start`. (Or use `render.yaml` as a Blueprint.)
3. Environment variables: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (needs Workers AI permission), `ONNXRUNTIME_NODE_INSTALL=skip` and `MALLOC_ARENA_MAX=2`.
4. Health check: `/health`. Scene list: `/api/scenes`.

`ONNXRUNTIME_NODE_INSTALL=skip` stops `onnxruntime-node` from downloading CUDA libraries during `npm ci` (the CPU build is already in the package). Set it locally too: `ONNXRUNTIME_NODE_INSTALL=skip npm ci` (PowerShell: `$env:ONNXRUNTIME_NODE_INSTALL='skip'; npm ci`).

Optional: `FLUX_MODEL` (e.g. `@cf/black-forest-labs/flux-2-klein-9b` for stronger likeness at higher cost), `JUDGE_MODEL`, `IDENTITY_MIN_SIMILARITY`, `MAX_ATTEMPTS`, `RATE_LIMIT` (generations per IP per 10 minutes, default 6).

The Cloudflare-Worker-only route (`src/worker.js`) no longer generates: the face check needs Node, so generation is Render-only.

## Tests

```bash
npm ci
npm test        # unit + integration tests, including the real face models
```

`npm test` covers: only the two scenes can be requested; prompts and the scene check; the retry / fail-closed loop; HTTP behaviour (400/405/413/422/429/502/503); and the real face models — different people (every pair in the sample group photos) are rejected, the same person in two different photos is accepted, and bad uploads (no face, several faces, tiny face) are refused.

### Live test against a deployment

Put a few face photos in `eval-faces/` (only of people who agreed; this folder is git-ignored), then:

```bash
node scripts/eval-live.mjs --url https://<your-app>.onrender.com --faces eval-faces --runs 2
```

It generates both scenes for each face, saves them to `eval-out/`, re-scores likeness locally — also against every *other* test face, so a generic face can't pass — and writes `eval-out/report.html` to review scene fidelity by eye.

## Privacy

Photos are sent to Cloudflare Workers AI for generation and checking; the server does not store them. Users need permission to upload the photos they use.

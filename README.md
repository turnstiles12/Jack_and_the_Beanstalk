# Beanstalk Character Studio — Render + Cloudflare Workers AI

A web app to upload a portrait and transform the person into a Jack and the Beanstalk character.

## Deploy on Render

1. Push **the contents of this folder** to the root of a GitHub repository (or set Render's Root Directory to `beanstalk-studio` if your repo wraps it).
2. In Render, choose **New → Web Service**, connect your repository and select **Node**.
3. Enter **Build Command:** `npm install` and **Start Command:** `npm start` (or **Build:** `yarn install`, **Start:** `yarn start`).
4. Set environment variables in Render (Environment tab):
   - `CLOUDFLARE_ACCOUNT_ID`: Cloudflare account ID.
   - `CLOUDFLARE_API_TOKEN`: A Cloudflare API token authorized to call Workers AI / AI Run on your account.
5. Deploy. Render supplies `PORT` automatically; the app listens on `0.0.0.0:$PORT`.
6. Open your Render URL. Health check: `/health`.

The included `render.yaml` also supports Render Blueprint creation; Render prompts for the two secret environment variables.

## Local run

Requires Node.js 20+.

```bash
npm install
cp .env.example .env
# Set values in your shell (Node doesn't automatically load .env unless started with --env-file)
CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... npm start
```

Open http://localhost:10000.

For Yarn, use `yarn install` and `yarn start`.

## How it works

The browser resizes the reference portrait to under 512px and uploads it to the Render backend via `/api/generate`. The backend calls Cloudflare's REST endpoint for `@cf/black-forest-labs/flux-2-klein-4b` with multipart form data, then returns the generated image. Keep Cloudflare credentials **only in Render environment variables**, never in the frontend or git.

## Notes

- Render hosts the frontend and API. Cloudflare hosts the image-generation model. You do **not** need to deploy a Cloudflare Worker for this Render setup.
- The existing `src/worker.js` and `wrangler.jsonc` are retained for Cloudflare-only deployment, but Render uses `server.js` instead.
- Users must have permission to upload the photos they use. Render itself does not intentionally store uploaded photos; the reference is sent to Cloudflare to generate an image.
- Public production use needs abuse protection, rate limits and/or authentication to control AI costs.
- A valid Cloudflare account and token are required to test real generation; without them the UI serves but generation returns a setup error.

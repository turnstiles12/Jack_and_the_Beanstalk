# Once Upon a Face — Jack and the Beanstalk AI portrait studio

A responsive website and server-side Cloudflare Worker that edits a user-provided photo into a Jack and the Beanstalk storybook character.

## Requirements
- Node.js 20+
- Cloudflare account with Workers AI access

## Run locally

```bash
npm install
npx wrangler login
npm run dev
```

Open the local URL printed by Wrangler (typically http://localhost:8787). Upload a face photo, choose a character and style, then generate.

## Deploy

```bash
npm run deploy
```

Wrangler deploys the static assets and backend Worker together. Add your own Cloudflare account during Wrangler authentication. The Worker uses an **AI binding** (`env.AI`), so no API key is exposed in browser code and no API token needs to be pasted into the site.

## Model

`@cf/black-forest-labs/flux-2-klein-4b` handles image editing with a source portrait as `input_image_0`. Client-side downscaling keeps the source image below 512x512, per Cloudflare docs. Output is 768x1024. Model cost is usage-based; see https://developers.cloudflare.com/workers-ai/platform/pricing/ .

## Important

- The current version **does not store** uploaded or generated photos. They are processed by the Worker and the Cloudflare AI model, then returned to the browser.
- Identity preservation is **best effort**, not guaranteed. For stronger face likeness, a specialized face-ID workflow may be needed.
- Before making a public deployment, implement authentication, abuse protection, and rate limiting to limit usage costs.
- Faces should be uploaded with the person's consent.
- A deployed Cloudflare account is required for real generations; this starter cannot simulate API generation offline.

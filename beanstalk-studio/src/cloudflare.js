// Thin Cloudflare Workers AI REST client used by the Render server.
import { JUDGE_SCHEMA, buildJudgePrompt } from './scenes.js';

export const IMAGE_MODEL = process.env.FLUX_MODEL || '@cf/black-forest-labs/flux-2-klein-4b';
export const JUDGE_MODEL = process.env.JUDGE_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';

export class UpstreamError extends Error {
  constructor(message, detail) {
    super(message);
    this.status = 502;
    this.detail = detail;
  }
}

export function createCloudflareClient({ accountId, apiToken, fetchImpl = fetch }) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/`;

  async function call(model, init, timeoutMs) {
    const res = await fetchImpl(base + model, {
      ...init,
      headers: { Authorization: `Bearer ${apiToken}`, ...(init.headers || {}) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    if (!res.ok || !json || json.success === false) {
      throw new UpstreamError(`Cloudflare ${model} failed (${res.status}).`, text.slice(0, 1000));
    }
    return json.result ?? json;
  }

  return {
    // Returns the generated image as a Buffer.
    async generateImage({ prompt, referencePng, width = 768, height = 1024 }) {
      const form = new FormData();
      form.append('prompt', prompt);
      form.append('input_image_0', new Blob([referencePng], { type: 'image/png' }), 'reference.png');
      form.append('width', String(width));
      form.append('height', String(height));
      const result = await call(IMAGE_MODEL, { method: 'POST', body: form }, 110_000);
      const encoded = result?.image;
      if (typeof encoded !== 'string' || !encoded) throw new UpstreamError('The image model returned no image.');
      return Buffer.from(encoded, 'base64');
    },

    // Asks a vision model whether the picture shows the scene's caption. Returns the parsed verdict.
    async judgeScene({ sceneId, jpeg }) {
      const body = (structured) => JSON.stringify({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildJudgePrompt(sceneId) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${jpeg.toString('base64')}` } }
          ]
        }],
        ...(structured ? { response_format: { type: 'json_schema', json_schema: JUDGE_SCHEMA } } : {}),
        temperature: 0,
        max_tokens: 300
      });
      const init = (structured) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: body(structured) });
      let result;
      try {
        result = await call(JUDGE_MODEL, init(true), 45_000);
      } catch (err) {
        // Some vision models reject structured output with images; the prompt already asks for JSON.
        if (!(err instanceof UpstreamError)) throw err;
        result = await call(JUDGE_MODEL, init(false), 45_000);
      }
      return parseVerdict(result?.response ?? result);
    }
  };
}

export function parseVerdict(response) {
  if (response && typeof response === 'object') return response;
  if (typeof response !== 'string') return null;
  const match = response.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

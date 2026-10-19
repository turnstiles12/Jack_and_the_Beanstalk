import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const MAX_UPLOAD = 7 * 1024 * 1024;
const CHARACTERS = {
  jack: 'Jack, the brave young adventurer, wearing a weathered green tunic, leather belt, brown boots and a small satchel, standing near an enormous magical beanstalk',
  giant: 'the legendary friendly storybook giant, wearing a rustic oversized vest and boots, in a magnificent castle among clouds',
  princess: 'a courageous fairy-tale princess, wearing a beautiful emerald-and-gold medieval gown, in the magical castle above the clouds',
  harper: 'the magical golden-harp musician, dressed in an elegant medieval fantasy outfit, holding a luminous enchanted golden harp',
  guardian: 'the mysterious guardian of the enchanted beanstalk, wearing a deep-green cloak embroidered with leaves, standing in a magical garden'
};
const STYLES = {
  storybook: 'beautiful hand-painted classic children’s storybook illustration, painterly watercolor and gouache textures, rich magical details',
  cinematic: 'cinematic high-end fantasy film still, atmospheric lighting, detailed costume design, realistic skin texture',
  animated: 'charming polished 3D animated family movie character design, expressive face, whimsical proportions, detailed lighting',
  watercolor: 'soft whimsical watercolor illustration on textured paper, delicate pen details, dreamy pastel palette'
};
const TYPES = { '/': 'text/html; charset=utf-8', '/index.html':'text/html; charset=utf-8', '/app.js': 'text/javascript; charset=utf-8', '/styles.css':'text/css; charset=utf-8' };
function reply(res, status, data) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD) { const e = new Error('Uploaded image is too large (6 MB max).'); e.status = 413; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function generate(req, res) {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!account || !token) return reply(res, 503, {error:'Cloudflare credentials are not configured on the server.'});
  try {
    const body = await readBody(req);
    const parsed = new Request('http://localhost/api/generate', {method:'POST', headers:{'content-type':req.headers['content-type'] || ''}, body});
    const data = await parsed.formData();
    const image = data.get('image');
    const character = String(data.get('character') || 'jack');
    const style = String(data.get('style') || 'storybook');
    if (!(image instanceof Blob) || !['image/png','image/jpeg','image/webp'].includes(image.type)) return reply(res,400,{error:'Upload a PNG, JPEG, or WebP portrait.'});
    if (image.size > 6 * 1024 * 1024) return reply(res,413,{error:'Image must be at most 6 MB.'});
    if (!CHARACTERS[character] || !STYLES[style]) return reply(res,400,{error:'Unknown character or art style.'});
    const prompt = [
      'Use input image 0 as the facial identity reference. Create a new image of THE SAME PERSON from image 0 as',
      CHARACTERS[character] + '.',
      'Preserve the recognizable facial identity, eye shape, nose, smile and other distinctive facial characteristics of the person in image 0.',
      'Show the character as a waist-up portrait with face unobstructed, facing camera, expressive and warm.',
      'Jack and the Beanstalk fairy tale atmosphere: huge twisting magical vine, golden glowing light, lush green leaves, fluffy clouds, storybook magic.',
      STYLES[style] + '.',
      'Portrait composition, single person, beautiful detailed scene. No typography, no logos, no watermark.'
    ].join(' ');
    const form = new FormData();
    form.append('prompt',prompt);
    form.append('input_image_0', image, 'portrait.png');
    form.append('width', '768'); form.append('height','1024');
    const upstream = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/run/${MODEL}`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`}, body:form, signal:AbortSignal.timeout(110000)
    });
    const result = await upstream.json();
    if (!upstream.ok || result.success === false) {
      console.error('Cloudflare AI error:', upstream.status, JSON.stringify(result).slice(0, 1000));
      return reply(res, 502, {error: 'Cloudflare could not generate the image. Check your API permissions, account usage, and server logs.'});
    }
    const encoded = result?.result?.image || result?.image;
    if (typeof encoded !== 'string' || !encoded) return reply(res,502,{error:'The AI service returned no image.'});
    return reply(res,200,{image:`data:image/png;base64,${encoded}`});
  } catch(err) {
    console.error('Generation error:', err);
    return reply(res,err.status || 500,{error:err.status ? err.message : 'Generation failed. Check the server logs and try again.'});
  }
}
const server = http.createServer(async(req,res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (pathname === '/health' && req.method === 'GET') return reply(res, 200, {status:'ok'});
  if (pathname === '/api/generate') {
    if (req.method !== 'POST') return reply(res,405,{error:'Use POST.'});
    return generate(req,res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res,405,{error:'Method not allowed.'});
  if (!Object.hasOwn(TYPES, pathname)) return reply(res,404,{error:'Not found.'});
  try {
    const filename = pathname === '/' ? 'index.html' : pathname.slice(1);
    const contents = await readFile(path.join(root,filename));
    res.writeHead(200, {'content-type':TYPES[pathname], 'x-content-type-options':'nosniff'});
    res.end(req.method === 'HEAD' ? undefined : contents);
  } catch(err) {console.error(err); reply(res,500,{error:'Could not serve file.'});}
});
const port = Number(process.env.PORT || 10000);
server.listen(port, '0.0.0.0', () => console.log(`Beanstalk Studio listening on 0.0.0.0:${port}`));

const MODEL = '@cf/black-forest-labs/flux-2-klein-4b';
const MAX_BYTES = 6 * 1024 * 1024;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/generate') return env.ASSETS.fetch(request);
    if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
    if (!env.AI) return json({ error: 'Cloudflare Workers AI is not configured.' }, 503);
    try {
      const data = await request.formData();
      const image = data.get('image');
      const character = String(data.get('character') || 'jack');
      const style = String(data.get('style') || 'storybook');
      if (!image || typeof image === 'string' || !image.type?.startsWith('image/')) return json({ error: 'Please upload an image.' }, 400);
      if (!['image/png','image/jpeg','image/webp'].includes(image.type)) return json({error:'Only PNG, JPEG and WebP images are supported.'},400);
      if (image.size > MAX_BYTES) return json({ error: 'Image too large. Maximum is 6 MB.' }, 413);
      if (!CHARACTERS[character] || !STYLES[style]) return json({ error: 'Unknown character or art style.' }, 400);

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
      form.append('prompt', prompt);
      form.append('input_image_0', image, 'portrait.png');
      form.append('width', '768');
      form.append('height', '1024');
      const encoded = new Response(form);
      const result = await env.AI.run(MODEL, {
        multipart: { body: encoded.body, contentType: encoded.headers.get('content-type') }
      });
      if (!result?.image) return json({ error: 'Model did not return an image. Please try again.' }, 502);
      return json({ image: `data:image/png;base64,${result.image}` });
    } catch (err) {
      console.error('Generation failed', err);
      return json({ error: 'Image generation failed. Try again or check Workers AI limits.' }, 500);
    }
  }
};
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options':'nosniff' } });
}

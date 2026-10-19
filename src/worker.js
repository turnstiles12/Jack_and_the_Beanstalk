// Cloudflare-Workers-only deployment is no longer supported for generation.
// Every picture must pass a face-likeness check and a scene check before it is returned,
// and the face check runs in Node (TensorFlow.js + sharp), so deploy server.js on Render.
// This Worker still serves the static site so the old route doesn't break outright.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return new Response(JSON.stringify({ error: 'Generation runs on the Render server (server.js), which checks likeness and scene before returning a picture.' }), {
        status: 501,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      });
    }
    return env.ASSETS.fetch(request);
  }
};

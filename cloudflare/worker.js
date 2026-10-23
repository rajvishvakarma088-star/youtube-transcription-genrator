const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PATH = /^\/(health|inspect|jobs(?:\/[0-9a-f]{32}(?:\/cancel)?)?|files\/[0-9a-f]{32})$/;

function cors(origin, env) {
  const allowed = [env.FRONTEND_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:3000'];
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Client-ID, Range',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Disposition',
    'Vary': 'Origin',
  };
}

function jsonError(message, status, headers) {
  return new Response(JSON.stringify({error: message}), {status, headers: {'Content-Type': 'application/json', ...headers}});
}

async function backend(env, path, method, clientId, body, range) {
  const headers = {'X-Backend-Key': env.BACKEND_SHARED_SECRET, 'X-Client-ID': clientId};
  if (body) headers['Content-Type'] = 'application/json';
  if (range) headers.Range = range;
  return fetch(`${env.BACKEND_URL.replace(/\/$/, '')}${path}`, {method, headers, body, redirect: 'manual'});
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allow = cors(origin, env);
    if (origin && !allow) return jsonError('This website is not allowed to use the downloader.', 403);
    if (request.method === 'OPTIONS') return new Response(null, {status: 204, headers: allow || {}});
    const url = new URL(request.url);
    if (!PATH.test(url.pathname)) return jsonError('Not found.', 404, allow || {});
    if (!env.BACKEND_URL?.startsWith('https://') || !env.BACKEND_SHARED_SECRET) {
      return jsonError('Cloud downloader is not configured yet.', 503, allow || {});
    }
    // Native browser downloads cannot set headers; the unguessable client ID
    // is carried in the file link only in that case.
    const clientId = request.headers.get('X-Client-ID') || (url.pathname.startsWith('/files/') ? url.searchParams.get('client') : '') || '';
    if (!UUID.test(clientId)) return jsonError('A valid client ID is required.', 400, allow || {});
    if (!['GET', 'POST'].includes(request.method)) return jsonError('Method not allowed.', 405, allow || {});
    try {
      if (url.pathname.startsWith('/files/')) {
        if (request.method !== 'GET') return jsonError('Method not allowed.', 405, allow || {});
        const metaResponse = await backend(env, `${url.pathname}/meta`, 'GET', clientId);
        if (!metaResponse.ok) {
          const headers = new Headers(metaResponse.headers);
          Object.entries(allow || {}).forEach(([key, value]) => headers.set(key, value));
          return new Response(metaResponse.body, {status: metaResponse.status, headers});
        }
        const meta = await metaResponse.json();
        const headers = new Headers(allow || {});
        headers.set('Content-Type', meta.contentType || 'application/octet-stream');
        headers.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(meta.filename)}`);
        headers.set('Cache-Control', 'private, no-store');
        headers.set('Accept-Ranges', 'bytes');
        if (meta.storage === 'r2') {
          if (!env.MEDIA_BUCKET) return jsonError('R2 storage is not connected to this Worker.', 503, allow || {});
          const object = await env.MEDIA_BUCKET.get(meta.storageKey, {range: request.headers});
          if (!object || !('body' in object)) return jsonError('The temporary file has expired.', 410, allow || {});
          headers.set('ETag', object.httpEtag);
          headers.set('Content-Length', String(object.range?.length ?? object.size));
          if (request.headers.has('Range') && object.range) {
            headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + object.range.length - 1}/${object.size}`);
            return new Response(object.body, {status: 206, headers});
          }
          return new Response(object.body, {status: 200, headers});
        }
        const file = await backend(env, url.pathname, 'GET', clientId, null, request.headers.get('Range'));
        for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Accept-Ranges', 'Content-Type']) {
          if (file.headers.has(name)) headers.set(name, file.headers.get(name));
        }
        if (!file.ok) {
          headers.delete('Content-Disposition');
          headers.set('Content-Type', 'application/json');
        }
        return new Response(file.body, {status: file.status, headers});
      }
      const body = request.method === 'POST' ? await request.text() : null;
      if (body && body.length > 100000) return jsonError('Request is too large.', 413, allow || {});
      const upstream = await backend(env, url.pathname, request.method, clientId, body);
      const headers = new Headers(upstream.headers);
      Object.entries(allow || {}).forEach(([key, value]) => headers.set(key, value));
      headers.set('Cache-Control', 'no-store');
      return new Response(upstream.body, {status: upstream.status, headers});
    } catch {
      return jsonError('Cloud downloader is temporarily unavailable. Try again shortly.', 502, allow || {});
    }
  },
};

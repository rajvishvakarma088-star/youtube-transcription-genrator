import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from './worker.js';

const env = {FRONTEND_ORIGIN: 'https://youtube-transcription-generator.vercel.app', BACKEND_URL: 'https://backend.example', BACKEND_SHARED_SECRET: 'secret'};
const clientId = '11111111-1111-4111-8111-111111111111';

test('rejects another website and keeps the backend secret private', async () => {
  const denied = await worker.fetch(new Request('https://worker.example/jobs', {headers: {Origin: 'https://evil.example', 'X-Client-ID': clientId}}), env);
  assert.equal(denied.status, 403);
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers['X-Backend-Key'], 'secret');
    return new Response(JSON.stringify({jobs: []}), {headers: {'Content-Type': 'application/json'}});
  };
  try {
    const allowed = await worker.fetch(new Request('https://worker.example/jobs', {headers: {Origin: env.FRONTEND_ORIGIN, 'X-Client-ID': clientId}}), env);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), env.FRONTEND_ORIGIN);
  } finally { globalThis.fetch = oldFetch; }
});

test('forwards byte ranges without buffering the backend file', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/meta')) return new Response(JSON.stringify({storage: 'backend', filename: 'clip.mp4', size: 10, contentType: 'video/mp4'}));
    assert.equal(options.headers.Range, 'bytes=3-6');
    return new Response('3456', {status: 206, headers: {'Content-Range': 'bytes 3-6/10', 'Content-Length': '4'}});
  };
  try {
    const response = await worker.fetch(new Request('https://worker.example/files/' + 'a'.repeat(32), {headers: {'X-Client-ID': clientId, Range: 'bytes=3-6'}}), env);
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
    assert.equal(await response.text(), '3456');
  } finally { globalThis.fetch = oldFetch; }
});

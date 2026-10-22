import { videoId, captions } from '../lib/transcript.js';

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const id = videoId(params.get('url') || '');
  if (!id) return Response.json({ error: 'Enter a valid YouTube video URL.' }, { status: 400 });
  try {
    return Response.json(await captions(id, params.get('lang')));
  } catch (error) {
    return Response.json({ error: error.message }, { status: 502 });
  }
}

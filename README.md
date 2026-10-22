# YouTube Transcription Generator

A minimal web app for reading, translating, editing, and downloading transcripts from YouTube videos with captions.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://localhost:3000`.

## Deploy to Vercel

The `public/` folder contains the website and `api/transcript.js` is the Vercel function. Import this repository into Vercel with the **Other** framework preset; no build command is needed.

Vercel's server addresses can be blocked by YouTube. The deployed function uses FreeTranscriptAPI as its caption source. Anonymous access is rate limited. To use an API key, set `FREETRANSCRIPT_API_KEY` in the Vercel project's environment variables. Local development first tries YouTube directly and falls back to the provider.

The app reads available caption tracks; it does not generate speech-to-text for videos without captions.

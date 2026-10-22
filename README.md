# YouTube Transcription Generator

A minimal web app for reading, editing, and downloading transcripts. Choose YouTube caption mode for a video link, or use the free open-source Whisper mode to transcribe an audio file on your own device.

## Run locally

Requires Node.js 20 or newer.

```sh
npm start
```

Open `http://localhost:3000`.

## Deploy to Vercel

The `public/` folder contains the website and `api/transcript.js` is the Vercel function. Import this repository into Vercel with the **Other** framework preset; no build command is needed.

Vercel's server addresses can be blocked by YouTube. The deployed function uses FreeTranscriptAPI as its caption source. Anonymous access is rate limited. To use an API key, set `FREETRANSCRIPT_API_KEY` in the Vercel project's environment variables. Local development first tries YouTube directly and falls back to the provider.

The YouTube mode reads available caption tracks. The open-source mode runs `Xenova/whisper-tiny` in a browser worker through Transformers.js and has no application usage quota or paid API key. The model downloads on first use. Processing speed and practical audio length depend on the browser and device. For videos without captions, upload an audio file you have permission to use; a YouTube URL alone cannot provide its audio to the browser model.

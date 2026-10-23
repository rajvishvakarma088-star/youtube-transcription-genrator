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

The Translate control uses compact, open-source OPUS translation models in a browser worker. It supports English, Hindi, Spanish, French, German, Portuguese, Arabic, Chinese, Japanese, Russian, Italian, Dutch, Indonesian, Vietnamese, Ukrainian, and Swedish. Translation is separate from YouTube caption-track selection and works for uploaded-audio transcripts too. Each new language pair downloads its model on first use. Non-English to non-English translation goes through English and may lose some nuance. Select the source language manually if it is not detected from the caption track.

## Media downloader

The downloader uses a local companion because Vercel functions cannot persist long-running download jobs or save files into a visitor's device folder. Start it on the computer where you use the website:

```sh
./start-downloader.sh
```

On macOS, install FFmpeg with `brew install ffmpeg` to enable audio conversion and merged video formats. The first run installs yt-dlp into an isolated environment in `work/`. The companion listens only on `127.0.0.1:8765`, accepts requests only from this app's local origins and the production domain, and saves to `~/Downloads/YouTube Transcription Generator`.

Paste up to 10 public URLs, inspect the available items, choose a listed exact quality for each, and start the batch. The UI shows size when the source provides it, progress, pause/resume, cancellation, and clear errors. MP3 conversion is lossy; M4A may also require conversion. The downloader does not use cookies or credentials, does not access private posts, and never substitutes a lower format if the selected format disappears. Individual site extractors can break when a platform changes; yt-dlp should be updated when needed.

When using the Vercel website in Chrome or Edge, click **Connect local downloader** and allow the site's loopback network request. This permission lets the website talk only to the companion on your own computer. The site waits for your click before requesting access.

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

The cloud downloader uses the existing Vercel frontend, a Cloudflare Worker, a Python yt-dlp service, and optional Cloudflare R2 temporary storage. It previews public media and exact available formats, supports up to 5 GiB per file, and streams direct HTTP formats without saving the whole file on the server. Merged and converted formats use temporary disk and optional R2 storage. See [cloud backend setup](cloud_backend/README.md) for deployment, storage, limits, and costs.

The deployed frontend uses the Cloudflare Worker by default. The downloader's Cloud / Local fallback switch lets each visitor choose the original local companion when cloud extraction is unavailable. Local mode requires that visitor to run `./start-downloader.sh` on their own computer; the selected mode and pasted links are kept when switching. Set `CLOUD_DOWNLOADER_URL` on Vercel only to replace the Worker URL. Neither mode bypasses private content or platform restrictions. Use only media you are authorized to save.

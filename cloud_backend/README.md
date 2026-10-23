# Cloud media downloader

The Vercel frontend calls a Cloudflare Worker. The Worker checks the allowed site origin, authenticates to the Python service, and streams file responses. The Python service uses yt-dlp to inspect public URLs and prepare exact selected formats. A single HTTP file can stream from the source through the service and Worker with HTTP Range support and about 1 MB per connection of application buffering. Merged or converted files use temporary disk and can optionally upload to private R2 storage. The Worker reads R2 directly by byte range after asking the Python service to authorize the job.

## Deployment

1. Deploy this repository to Render using `render.yaml`. It builds `cloud_backend/Dockerfile`. Set a long random `BACKEND_SHARED_SECRET`. The `/health` endpoint is public for Render health checks; all other Python routes require the secret. Use one service instance because job metadata is in memory.
2. Create a Cloudflare Worker from `cloudflare/wrangler.toml` and `cloudflare/worker.js`. Set `BACKEND_URL` to the HTTPS Render URL and `BACKEND_SHARED_SECRET` to the same secret using Wrangler secrets. Never put these values in `wrangler.toml` or Vercel variables.
3. Optionally create a private R2 Standard bucket. Add the `MEDIA_BUCKET` binding to `wrangler.toml`. Give the Python service scoped R2 S3 credentials via the four `R2_*` environment variables in `.env.example`. Configure an R2 lifecycle rule to expire `temp/` objects after one day as a backup to application cleanup.
4. The Vercel frontend is configured with the deployed Worker URL. Set `CLOUD_DOWNLOADER_URL` only to replace that URL. The original local downloader remains in the repository as a fallback if cloud configuration is removed.

The backend needs FFmpeg for merged video and MP3/M4A conversion; it is installed in the Docker image. Only public accessible URLs from the existing allowlist are accepted. Private, login restricted, and unsupported URLs return errors. Some platforms also block public extraction from cloud datacenter IPs; the service reports that restriction and does not use user cookies or bypass it. Downloads are capped at 5 GiB, with no quality substitution. The service limits concurrent processing and queued jobs. A restarted container loses its in memory job list; a completed R2 object remains until its lifecycle expires but its download link is invalid after a restart. For reliable large processed jobs, use a persistent service and disk or add a durable job store.

## Capacity and cost

Render Free is useful for testing small jobs, and direct HTTP streaming does not require a 5 GB temporary file. Render Free sleeps after idle, has ephemeral disk, and does not promise enough disk or uninterrupted runtime for a 5 GB merge. To support a 5 GB merge, choose a paid Render instance with enough temporary disk for the separate streams plus the final file (roughly 12 GB or more), and monitor CPU, transfer, and disk usage. R2's free monthly storage is limited; two 5 GB temporary objects can consume that allowance. Browser progress and pause/resume use the File System Access API where available. Other browsers use their native download manager, which controls resume and progress.

Only save media you are authorized to keep, and respect each platform's access rules.

"""Local-only media download companion for the web app.

Run this service on the same computer as the browser. It intentionally never
uses cookies, credentials, proxies, or private-network URLs.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

import imageio_ffmpeg
import yt_dlp


PORT = int(os.environ.get("DOWNLOADER_PORT", "8765"))
SAVE_DIR = Path.home() / "Downloads" / "YouTube Transcription Generator"
ALLOWED_ORIGINS = {
    "https://youtube-transcription-generator.vercel.app",
    "http://localhost:3000", "http://localhost:3001", "http://localhost:3002",
    "http://127.0.0.1:3000", "http://127.0.0.1:3001", "http://127.0.0.1:3002",
}
HOSTS = (
    "youtube.com", "youtu.be", "instagram.com", "facebook.com", "fb.watch",
    "x.com", "twitter.com", "tiktok.com", "reddit.com", "vimeo.com",
    "dailymotion.com", "soundcloud.com", "pinterest.com", "twitch.tv",
    "streamable.com", "rumble.com",
)
IMAGE_EXTS = {"jpg", "jpeg", "png", "webp", "avif", "gif"}
INSPECTIONS: dict[str, dict] = {}
JOBS: dict[str, dict] = {}
LOCK = threading.RLock()
SLOTS = threading.Semaphore(2)


def validate_url(raw: str) -> str:
    """Accept only public HTTPS media URLs from the supported host list."""
    if not isinstance(raw, str) or len(raw) > 2048:
        raise ValueError("Enter a valid public media URL.")
    parsed = urlsplit(raw.strip())
    host = (parsed.hostname or "").lower().rstrip(".")
    try:
        port = parsed.port
    except ValueError:
        raise ValueError("Use a public HTTPS link from a supported site.") from None
    if parsed.scheme != "https" or not host or parsed.username or parsed.password or port:
        raise ValueError("Use a public HTTPS link from a supported site.")
    if not any(host == allowed or host.endswith("." + allowed) for allowed in HOSTS):
        raise ValueError("This website is not supported by the local downloader.")
    if host.startswith("localhost") or re.match(r"^\d+(?:\.\d+){3}$", host):
        raise ValueError("Private network links are not supported.")
    return raw.strip()


def ffmpeg_directory() -> str | None:
    ffmpeg = shutil.which("ffmpeg")
    ffprobe = shutil.which("ffprobe")
    if ffmpeg and ffprobe:
        return str(Path(ffmpeg).parent)
    # The packaged FFmpeg handles simple remuxing. Audio conversion needs
    # ffprobe as well, and is hidden from format choices until it is installed.
    return str(Path(imageio_ffmpeg.get_ffmpeg_exe()).parent)


def can_convert_audio() -> bool:
    return bool(shutil.which("ffmpeg") and shutil.which("ffprobe"))


def ydl_options(**extra) -> dict:
    options = {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "noplaylist": False, "playlistend": 20, "socket_timeout": 20,
        "retries": 2, "extractor_retries": 2,
        "ffmpeg_location": ffmpeg_directory(),
        "nocheckcertificate": False,
        "ignoreerrors": False,
    }
    options.update(extra)
    return options


def format_size(fmt: dict) -> int | None:
    value = fmt.get("filesize") or fmt.get("filesize_approx")
    return int(value) if isinstance(value, (int, float)) and value > 0 else None


def options_for(info: dict) -> tuple[str, list[dict]]:
    formats = [f for f in info.get("formats", []) if f.get("format_id")]
    videos = [f for f in formats if f.get("vcodec") not in (None, "none") and f.get("ext") not in IMAGE_EXTS]
    audios = [f for f in formats if f.get("acodec") not in (None, "none") and f.get("vcodec") in (None, "none")]
    images = [f for f in formats if f.get("ext") in IMAGE_EXTS]
    if not formats and info.get("url") and info.get("ext") in IMAGE_EXTS:
        images = [{"format_id": info.get("format_id") or "0", "ext": info["ext"], "url": info["url"], "filesize": info.get("filesize")}]
    def video_rank(f):
        return (int(f.get("height") or 0), float(f.get("tbr") or 0), format_size(f) or 0)
    def audio_rank(f):
        return (float(f.get("abr") or f.get("tbr") or 0), format_size(f) or 0)
    if videos:
        best_audio = max(audios, key=audio_rank) if audios else None
        by_height = {}
        for fmt in videos:
            height = int(fmt.get("height") or 0)
            if height not in by_height or video_rank(fmt) > video_rank(by_height[height]):
                by_height[height] = fmt
        choices = []
        for height, fmt in sorted(by_height.items(), reverse=True):
            audio = best_audio if fmt.get("acodec") in (None, "none") else None
            format_id = str(fmt["format_id"]) + ("+" + str(audio["format_id"]) if audio else "")
            size_parts = [format_size(fmt)] + ([format_size(audio)] if audio else [])
            size = sum(size_parts) if all(part is not None for part in size_parts) else None
            label = f'{height}p · {fmt.get("ext", "video").upper()}' if height else f'Original video · {fmt.get("ext", "video").upper()}'
            if fmt.get("acodec") in (None, "none") and not audio:
                label += " · video only"
            choices.append({"id": f"video:{height}", "label": label, "format": format_id, "size": size, "resolution": height or None, "kind": "video"})
        if choices:
            choices[0]["label"] = "Highest available · " + choices[0]["label"]
        if best_audio:
            choices.append({"id": "audio:original", "label": "Original audio · " + best_audio.get("ext", "audio").upper(), "format": str(best_audio["format_id"]), "size": format_size(best_audio), "kind": "audio"})
            if can_convert_audio():
                choices.extend([
                    {"id": "audio:m4a", "label": "M4A · converted if needed", "format": str(best_audio["format_id"]), "size": None, "kind": "audio", "convert": "m4a"},
                    {"id": "audio:mp3", "label": "MP3 · converted (lossy)", "format": str(best_audio["format_id"]), "size": None, "kind": "audio", "convert": "mp3"},
                ])
        return "video", choices
    if images:
        choices = []
        for fmt in sorted(images, key=lambda f: ((f.get("width") or 0) * (f.get("height") or 0), format_size(f) or 0), reverse=True):
            choices.append({"id": "image:" + str(fmt["format_id"]), "label": "Original image · " + fmt.get("ext", "image").upper(), "format": str(fmt["format_id"]), "size": format_size(fmt), "kind": "image"})
        return "image", choices
    if audios:
        best = max(audios, key=audio_rank)
        choices = [{"id": "audio:original", "label": "Original audio · " + best.get("ext", "audio").upper(), "format": str(best["format_id"]), "size": format_size(best), "kind": "audio"}]
        if can_convert_audio():
            choices.extend([
                {"id": "audio:m4a", "label": "M4A · converted if needed", "format": str(best["format_id"]), "size": None, "kind": "audio", "convert": "m4a"},
                {"id": "audio:mp3", "label": "MP3 · converted (lossy)", "format": str(best["format_id"]), "size": None, "kind": "audio", "convert": "mp3"},
            ])
        return "audio", choices
    raise ValueError("No downloadable public media formats were found for this item.")


def flatten_items(info: dict) -> list[dict]:
    if info.get("_type") in ("playlist", "multi_video"):
        return [item for item in info.get("entries", []) if isinstance(item, dict)][:20]
    return [info]


def inspect_media(url: str) -> dict:
    url = validate_url(url)
    with yt_dlp.YoutubeDL(ydl_options()) as ydl:
        info = ydl.extract_info(url, download=False)
    if not info:
        raise ValueError("No public media was found at that URL.")
    items = []
    for index, entry in enumerate(flatten_items(info), start=1):
        if entry.get("availability") in {"private", "premium_only", "subscriber_only", "needs_auth"}:
            continue
        try:
            kind, choices = options_for(entry)
        except ValueError:
            continue
        thumbnail = entry.get("thumbnail")
        items.append({
            "index": index, "id": str(entry.get("id") or index),
            "title": entry.get("title") or info.get("title") or "Untitled media",
            "thumbnail": thumbnail if isinstance(thumbnail, str) and thumbnail.startswith("https://") else None,
            "duration": entry.get("duration"), "kind": kind,
            "choices": [{k: v for k, v in choice.items() if k != "format"} for choice in choices],
            "_choices": choices,
        })
    if not items:
        raise ValueError("No public downloadable media was found. Private or restricted posts are not supported.")
    inspection_id = uuid.uuid4().hex
    with LOCK:
        for key, value in list(INSPECTIONS.items()):
            if time.time() - value["created"] > 3600:
                del INSPECTIONS[key]
        INSPECTIONS[inspection_id] = {"url": url, "items": items, "created": time.time(), "is_playlist": len(flatten_items(info)) > 1}
    return {"inspectionId": inspection_id, "site": urlsplit(url).hostname, "items": [{k: v for k, v in item.items() if k != "_choices"} for item in items]}


class Cancelled(Exception):
    pass


def run_job(job_id: str):
    with SLOTS:
        with LOCK:
            job = JOBS[job_id]
            if job["cancel"].is_set():
                job["state"] = "cancelled"
                return
            job["state"] = "running" if job["resume"].is_set() else "paused"
        def progress(data):
            if job["cancel"].is_set():
                raise Cancelled()
            job["resume"].wait()
            if job["cancel"].is_set():
                raise Cancelled()
            if data.get("status") == "downloading":
                size = data.get("total_bytes") or data.get("total_bytes_estimate")
                done = data.get("downloaded_bytes") or 0
                with LOCK:
                    job["progress"] = round(done / size * 100, 1) if size else None
                    job["downloadedBytes"] = done
                    job["totalBytes"] = size
                    job["speed"] = data.get("speed")
                    job["eta"] = data.get("eta")
            elif data.get("status") == "finished":
                with LOCK:
                    job["state"] = "processing"
        try:
            SAVE_DIR.mkdir(parents=True, exist_ok=True)
            choice = job["choice"]
            options = ydl_options(
                skip_download=False, format=choice["format"],
                paths={"home": str(SAVE_DIR)},
                outtmpl="%(title).180B [%(id)s].%(ext)s",
                continuedl=True, part=True, overwrites=False,
                progress_hooks=[progress],
                playlist_items=str(job["index"]) if job["is_playlist"] else None,
            )
            if choice.get("convert"):
                options["postprocessors"] = [{"key": "FFmpegExtractAudio", "preferredcodec": choice["convert"], "preferredquality": "0"}]
            try:
                with yt_dlp.YoutubeDL(options) as ydl:
                    result = ydl.download([job["url"]])
            except IndexError as error:
                # yt-dlp can raise an IndexError after both streams finish when
                # FFmpeg exits without an error message. Retrying reuses the
                # downloaded streams and keeps the exact selected quality.
                if choice["kind"] != "video" or "+" not in choice["format"] or job["state"] != "processing":
                    raise
                try:
                    with yt_dlp.YoutubeDL(options) as ydl:
                        result = ydl.download([job["url"]])
                except IndexError as retry_error:
                    raise RuntimeError("The video and audio downloaded, but merging them failed. Check FFmpeg and retry the download.") from retry_error
            if result:
                raise ValueError("The selected quality is no longer available. Inspect the URL again; no lower quality was downloaded.")
            with LOCK:
                job["state"] = "cancelled" if job["cancel"].is_set() else "completed"
                if job["state"] == "completed":
                    job["progress"] = 100
        except Cancelled:
            with LOCK:
                job["state"] = "cancelled"
        except Exception as error:
            with LOCK:
                job["state"] = "error"
                job["error"] = str(error)[:500] or "Download failed."


def public_job(job: dict) -> dict:
    return {key: job.get(key) for key in ("id", "title", "state", "progress", "downloadedBytes", "totalBytes", "speed", "eta", "error", "kind")}


class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, data: dict):
        body = json.dumps(data).encode()
        self.send_response(status)
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _allowed(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or origin in ALLOWED_ORIGINS

    def _json(self) -> dict:
        if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
            raise ValueError("Expected application/json.")
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= 100_000:
            raise ValueError("Request is too large or empty.")
        value = json.loads(self.rfile.read(size))
        if not isinstance(value, dict):
            raise ValueError("Expected a JSON object.")
        return value

    def do_OPTIONS(self):
        if not self._allowed():
            self._send(403, {"error": "This website is not allowed to use the local downloader."})
            return
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self):
        if not self._allowed():
            return self._send(403, {"error": "This website is not allowed to use the local downloader."})
        if self.path == "/health":
            return self._send(200, {"ok": True, "saveFolder": str(SAVE_DIR), "audioConversion": can_convert_audio(), "extractor": yt_dlp.version.__version__})
        if self.path == "/jobs":
            with LOCK:
                return self._send(200, {"jobs": [public_job(job) for job in JOBS.values()]})
        return self._send(404, {"error": "Not found."})

    def do_POST(self):
        if not self._allowed():
            return self._send(403, {"error": "This website is not allowed to use the local downloader."})
        try:
            data = self._json()
            if self.path == "/inspect":
                return self._send(200, inspect_media(data.get("url")))
            if self.path == "/jobs":
                inspection_id = data.get("inspectionId")
                selections = data.get("selections")
                with LOCK:
                    inspection = INSPECTIONS.get(inspection_id)
                    if not inspection or time.time() - inspection["created"] > 3600:
                        raise ValueError("This preview has expired. Inspect the URL again.")
                    if not isinstance(selections, list) or not 0 < len(selections) <= 20:
                        raise ValueError("Choose between 1 and 20 media items.")
                    prepared = []
                    for selection in selections:
                        item = next((x for x in inspection["items"] if x["index"] == selection.get("index")), None)
                        choice = next((x for x in item["_choices"] if x["id"] == selection.get("choice")), None) if item else None
                        if not choice:
                            raise ValueError("Selected format is no longer available. Inspect the URL again.")
                        prepared.append((item, choice))
                    created = []
                    for item, choice in prepared:
                        job_id = uuid.uuid4().hex
                        job = {"id": job_id, "url": inspection["url"], "index": item["index"], "is_playlist": inspection["is_playlist"], "choice": choice,
                               "title": item["title"], "kind": choice["kind"], "state": "queued", "progress": 0, "downloadedBytes": 0,
                               "totalBytes": choice.get("size"), "speed": None, "eta": None, "error": None,
                               "resume": threading.Event(), "cancel": threading.Event()}
                        job["resume"].set()
                        JOBS[job_id] = job
                        created.append(public_job(job))
                for job in created:
                    threading.Thread(target=run_job, args=(job["id"],), daemon=True).start()
                return self._send(202, {"jobs": created})
            action = re.fullmatch(r"/jobs/([0-9a-f]{32})/(pause|resume|cancel)", self.path)
            if action:
                with LOCK:
                    job = JOBS.get(action.group(1))
                    if not job:
                        return self._send(404, {"error": "Download job was not found."})
                    name = action.group(2)
                    if name == "pause" and job["state"] in ("queued", "running"):
                        job["state"] = "paused"; job["resume"].clear()
                    elif name == "resume" and job["state"] == "paused":
                        job["state"] = "running"; job["resume"].set()
                    elif name == "cancel" and job["state"] not in ("completed", "error", "cancelled"):
                        job["state"] = "cancelled"; job["cancel"].set(); job["resume"].set()
                    return self._send(200, public_job(job))
            return self._send(404, {"error": "Not found."})
        except (ValueError, json.JSONDecodeError) as error:
            return self._send(400, {"error": str(error)})
        except yt_dlp.utils.DownloadError as error:
            return self._send(422, {"error": "This public URL could not be inspected. The platform may block it, or it may be private or restricted. " + str(error)[:250]})
        except Exception as error:
            return self._send(500, {"error": str(error)[:300] or "Unexpected downloader error."})


def main():
    SAVE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Local downloader running at http://127.0.0.1:{PORT}")
    print(f"Saving media to {SAVE_DIR}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()

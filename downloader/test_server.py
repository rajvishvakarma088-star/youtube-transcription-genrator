import unittest
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

import server


class DownloaderTests(unittest.TestCase):
    def test_rejects_private_and_unlisted_hosts(self):
        for url in (
            "http://www.youtube.com/watch?v=abc",
            "https://127.0.0.1/video.mp4",
            "https://youtube.com.evil.example/watch?v=abc",
            "https://www.youtube.com:443/watch?v=abc",
            "https://user:password@www.youtube.com/watch?v=abc",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                server.validate_url(url)

    def test_exact_video_quality_and_unknown_combined_size(self):
        info = {"formats": [
            {"format_id": "v1080", "height": 1080, "ext": "mp4", "vcodec": "avc1", "acodec": "none", "tbr": 2800},
            {"format_id": "v720", "height": 720, "ext": "mp4", "vcodec": "avc1", "acodec": "none", "tbr": 1300, "filesize": 15_000_000},
            {"format_id": "a1", "ext": "m4a", "vcodec": "none", "acodec": "aac", "abr": 128, "filesize": 5_000_000},
        ]}
        kind, choices = server.options_for(info)
        self.assertEqual(kind, "video")
        self.assertEqual(choices[0]["format"], "v1080+a1")
        self.assertIsNone(choices[0]["size"])
        self.assertEqual(choices[1]["format"], "v720+a1")
        self.assertEqual(choices[1]["size"], 20_000_000)
        self.assertTrue(any(choice["id"] == "audio:original" for choice in choices))

    def test_preserves_original_image_format(self):
        kind, choices = server.options_for({"formats": [
            {"format_id": "jpg-original", "ext": "jpg", "width": 2000, "height": 1500, "filesize": 500_000},
            {"format_id": "webp-small", "ext": "webp", "width": 640, "height": 480, "filesize": 80_000},
        ]})
        self.assertEqual(kind, "image")
        self.assertEqual(choices[0]["format"], "jpg-original")

    def test_job_uses_exact_selected_format_and_completes(self):
        captured = {}
        class FakeYoutubeDL:
            def __init__(self, options):
                captured.update(options)
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def download(self, urls):
                captured["urls"] = urls
                captured["progress_hooks"][0]({"status": "downloading", "downloaded_bytes": 50, "total_bytes": 100})
                captured["progress_hooks"][0]({"status": "finished"})
                return 0
        job_id = "a" * 32
        job = {"id": job_id, "url": "https://www.youtube.com/watch?v=example", "index": 1,
               "is_playlist": False, "choice": {"format": "v1080+a1", "kind": "video"},
               "title": "Example", "kind": "video", "state": "queued", "progress": 0,
               "downloadedBytes": 0, "totalBytes": None, "speed": None, "eta": None,
               "error": None, "resume": threading.Event(), "cancel": threading.Event()}
        job["resume"].set()
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "SAVE_DIR", Path(folder)), patch.object(server.yt_dlp, "YoutubeDL", FakeYoutubeDL):
            server.JOBS[job_id] = job
            try:
                server.run_job(job_id)
            finally:
                del server.JOBS[job_id]
        self.assertEqual(captured["format"], "v1080+a1")
        self.assertEqual(captured["urls"], [job["url"]])
        self.assertEqual(job["state"], "completed")
        self.assertEqual(job["progress"], 100)

    def test_cancel_releases_a_paused_download(self):
        started = threading.Event()
        class FakeYoutubeDL:
            def __init__(self, options):
                self.progress = options["progress_hooks"][0]
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def download(self, urls):
                started.set()
                self.progress({"status": "downloading", "downloaded_bytes": 10, "total_bytes": 100})
                return 0
        job_id = "b" * 32
        job = {"id": job_id, "url": "https://www.youtube.com/watch?v=example", "index": 1,
               "is_playlist": False, "choice": {"format": "v1080+a1", "kind": "video"},
               "title": "Example", "kind": "video", "state": "paused", "progress": 0,
               "downloadedBytes": 0, "totalBytes": None, "speed": None, "eta": None,
               "error": None, "resume": threading.Event(), "cancel": threading.Event()}
        with tempfile.TemporaryDirectory() as folder, patch.object(server, "SAVE_DIR", Path(folder)), patch.object(server.yt_dlp, "YoutubeDL", FakeYoutubeDL):
            server.JOBS[job_id] = job
            try:
                thread = threading.Thread(target=server.run_job, args=(job_id,))
                thread.start()
                self.assertTrue(started.wait(3))
                job["cancel"].set()
                job["resume"].set()
                thread.join(3)
                self.assertFalse(thread.is_alive())
            finally:
                job["resume"].set()
                del server.JOBS[job_id]
        self.assertEqual(job["state"], "cancelled")


if __name__ == "__main__":
    unittest.main()

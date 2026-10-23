#!/bin/sh
set -eu
cd "$(dirname "$0")"
if [ ! -x work/downloader-venv/bin/python ]; then
  python3 -m venv work/downloader-venv
fi
if ! work/downloader-venv/bin/python -c 'import yt_dlp, imageio_ffmpeg' >/dev/null 2>&1; then
  work/downloader-venv/bin/python -m pip install --disable-pip-version-check -r downloader/requirements.txt
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  printf '%s\n' 'FFmpeg and FFprobe are needed for MP3/M4A conversion and some video formats.' 'On macOS, install them with: brew install ffmpeg'
fi
exec work/downloader-venv/bin/python downloader/server.py

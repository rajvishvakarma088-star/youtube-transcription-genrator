FROM python:3.12-slim
COPY --from=denoland/deno:bin-2.9.6 /deno /usr/local/bin/deno
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY cloud_backend/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
RUN deno --version
COPY downloader /app/downloader
COPY cloud_backend /app/cloud_backend
ENV PYTHONUNBUFFERED=1 MEDIA_TEMP_DIR=/tmp/media
EXPOSE 8080
CMD ["sh", "-c", "uvicorn cloud_backend.app:app --host 0.0.0.0 --port ${PORT:-8080}"]

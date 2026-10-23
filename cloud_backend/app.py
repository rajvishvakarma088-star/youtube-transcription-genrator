"""Private extractor service behind the Cloudflare Worker.

One persistent container is required: in-memory job metadata is intentionally
small, while media is streamed or held on disk/R2 for a short TTL.
"""
from __future__ import annotations

import ipaddress
import os
import secrets
import shutil
import socket
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from downloader.server import flatten_items, options_for, validate_url, ydl_options

MAX_BYTES = 5 * 1024 ** 3
TTL = int(os.getenv('MEDIA_TTL_SECONDS', '3600'))
TEMP = Path(os.getenv('MEDIA_TEMP_DIR', '/tmp/media'))
SECRET = os.getenv('BACKEND_SHARED_SECRET', '')
MAX_WORKERS = int(os.getenv('MEDIA_WORKERS', '2'))
MAX_QUEUE = int(os.getenv('MEDIA_QUEUE', '20'))
LOCK = threading.RLock()
INSPECTIONS = {}
JOBS = {}
EXECUTOR = ThreadPoolExecutor(max_workers=MAX_WORKERS)
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class InspectInput(BaseModel):
    url: str


class Selection(BaseModel):
    index: int
    choice: str


class JobsInput(BaseModel):
    inspectionId: str
    selections: list[Selection] = Field(min_length=1, max_length=20)


def owner(request: Request) -> str:
    value = request.headers.get('x-client-id', '')
    if len(value) != 36 or not all(c in '0123456789abcdef-' for c in value.lower()):
        raise HTTPException(400, 'A valid client ID is required.')
    return value


@app.middleware('http')
async def private_api(request: Request, call_next):
    if request.url.path == '/health' and request.method == 'GET':
        return await call_next(request)
    if not SECRET or not secrets.compare_digest(request.headers.get('x-backend-key', ''), SECRET):
        return JSONResponse({'error': 'Backend authentication is not configured or failed.'}, status_code=403)
    return await call_next(request)


def cleanup():
    while True:
        time.sleep(60)
        now = time.time()
        with LOCK:
            stale = [key for key, value in JOBS.items() if value['state'] not in ('queued', 'running', 'processing') and now - value['created'] > TTL]
            for key in stale:
                job = JOBS.pop(key)
                if job.get('storage') == 'r2':
                    try:
                        r2_client().delete_object(Bucket=os.environ['R2_BUCKET'], Key=job['storageKey'])
                    except Exception:
                        pass
                shutil.rmtree(TEMP / key, ignore_errors=True)
            for key in list(INSPECTIONS):
                if now - INSPECTIONS[key]['created'] > 1200:
                    del INSPECTIONS[key]
            active = set(JOBS)
        # A restart can leave files on a persistent disk with no in-memory job.
        for folder in TEMP.iterdir():
            if folder.is_dir() and folder.name not in active and now - folder.stat().st_mtime > TTL:
                shutil.rmtree(folder, ignore_errors=True)


@app.on_event('startup')
def start_cleanup():
    TEMP.mkdir(parents=True, exist_ok=True)
    threading.Thread(target=cleanup, daemon=True).start()


def r2_client():
    import boto3
    return boto3.client('s3', endpoint_url=os.environ['R2_ENDPOINT'],
                        aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
                        aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'], region_name='auto')


def public_job(job):
    return {key: job.get(key) for key in ('id', 'title', 'state', 'progress', 'downloadedBytes', 'totalBytes', 'error', 'kind', 'filename', 'size')}


def get_job(job_id, client):
    with LOCK:
        job = JOBS.get(job_id)
        if not job or job['owner'] != client:
            raise HTTPException(404, 'Download job was not found.')
        return job


def safe_source(url):
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('The media source is not a public HTTPS URL.')
    try:
        addresses = socket.getaddrinfo(parsed.hostname, 443, type=socket.SOCK_STREAM)
        if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
            raise ValueError('The media source resolves to a private address.')
    except OSError as error:
        raise ValueError('Could not resolve the media source.') from error
    return url


def extract(url):
    with yt_dlp.YoutubeDL(ydl_options(noplaylist=False, playlistend=20)) as ydl:
        return ydl.extract_info(validate_url(url), download=False)


def extraction_error(error):
    message = str(error).lower()
    if 'sign in to confirm' in message or 'cookies' in message or 'login required' in message:
        return 'This platform is blocking automated access from the cloud server. Private or restricted media cannot be downloaded.'
    return f'This public URL could not be inspected: {str(error)[:250]}'


@app.get('/health')
def health():
    return {'ok': True, 'maxBytes': MAX_BYTES, 'storage': 'r2' if os.getenv('R2_BUCKET') else 'temporary', 'extractor': yt_dlp.version.__version__}


@app.post('/inspect')
def inspect(data: InspectInput, request: Request):
    client = owner(request)
    try:
        info = extract(data.url)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    except yt_dlp.utils.DownloadError as error:
        raise HTTPException(422, extraction_error(error)) from error
    if not info:
        raise HTTPException(422, 'No public media was found at that URL.')
    items = []
    for index, entry in enumerate(flatten_items(info), 1):
        if entry.get('availability') in {'private', 'premium_only', 'subscriber_only', 'needs_auth'}:
            continue
        try:
            kind, choices = options_for(entry)
        except ValueError:
            continue
        choices = [choice for choice in choices if not choice.get('size') or choice['size'] <= MAX_BYTES]
        if not choices:
            continue
        items.append({'index': index, 'title': entry.get('title') or 'Untitled media', 'thumbnail': entry.get('thumbnail'),
                      'duration': entry.get('duration'), 'kind': kind,
                      'choices': [{k: v for k, v in choice.items() if k != 'format'} for choice in choices],
                      '_choices': choices, '_entry': entry})
    if not items:
        raise HTTPException(422, 'No accessible public media under 5 GB was found.')
    inspection_id = uuid.uuid4().hex
    with LOCK:
        INSPECTIONS[inspection_id] = {'url': data.url, 'items': items, 'owner': client, 'created': time.time(), 'is_playlist': len(flatten_items(info)) > 1}
    return {'inspectionId': inspection_id, 'site': urlsplit(data.url).hostname,
            'items': [{k: v for k, v in item.items() if not k.startswith('_')} for item in items]}


def selected_format(info, format_id):
    for item in info.get('formats') or []:
        if item.get('format_id') == format_id:
            return item
    raise ValueError('The selected quality is no longer available. Inspect the URL again.')


def filename(title, ext):
    title = ''.join(c if c.isalnum() or c in ' -_().' else '_' for c in title).strip(' .')[:140] or 'media'
    ext = ''.join(c for c in ext.lower() if c.isalnum())[:8] or 'bin'
    return f'{title}.{ext}'


def inspect_selected(job):
    info = extract(job['url'])
    entries = flatten_items(info)
    if job['index'] > len(entries):
        raise ValueError('This item is no longer available. Inspect the URL again.')
    return selected_format(entries[job['index'] - 1], job['choice']['format'])


def direct_format(job):
    if '+' in job['choice']['format'] or job['choice'].get('convert'):
        return None
    try:
        fmt = selected_format(job['entry'], job['choice']['format'])
        if fmt.get('protocol') not in ('http', 'https') or not fmt.get('url'):
            return None
        safe_source(fmt['url'])
        return fmt
    except (ValueError, yt_dlp.utils.DownloadError):
        return None


def run_job(job_id):
    with LOCK:
        job = JOBS[job_id]
        job['state'] = 'running'
    folder = TEMP / job_id
    folder.mkdir(parents=True, exist_ok=True)
    try:
        def progress(data):
            if job['cancel'].is_set():
                raise ValueError('Download cancelled.')
            if data.get('status') == 'finished':
                with LOCK:
                    job['state'] = 'processing'
                return
            if data.get('status') == 'downloading':
                done = int(data.get('downloaded_bytes') or 0)
                total = int(data.get('total_bytes') or data.get('total_bytes_estimate') or 0)
                if done > MAX_BYTES:
                    raise ValueError('This file exceeds the 5 GB limit.')
                with LOCK:
                    job['downloadedBytes'] = done
                    job['totalBytes'] = total or job['totalBytes']
                    job['progress'] = min(99, round(done / total * 100, 1)) if total else None
        opts = ydl_options(skip_download=False, format=job['choice']['format'], paths={'home': str(folder)},
                           outtmpl='%(id)s.%(ext)s', playlist_items=str(job['index']) if job['is_playlist'] else None,
                           progress_hooks=[progress], max_filesize=MAX_BYTES, nopart=False)
        if job['choice'].get('convert'):
            opts['postprocessors'] = [{'key': 'FFmpegExtractAudio', 'preferredcodec': job['choice']['convert'], 'preferredquality': '0'}]
        with yt_dlp.YoutubeDL(opts) as ydl:
            if ydl.download([job['url']]):
                raise ValueError('The selected quality is no longer available. Inspect the URL again.')
        files = [p for p in folder.iterdir() if p.is_file() and not p.name.endswith(('.part', '.ytdl'))]
        if len(files) != 1:
            raise ValueError('The selected media could not be assembled into one file.')
        path = files[0]
        size = path.stat().st_size
        if not size or size > MAX_BYTES:
            raise ValueError('The finished file is empty or exceeds 5 GB.')
        with LOCK:
            job['size'] = size
            job['filename'] = filename(job['title'], path.suffix.lstrip('.'))
            job['state'] = 'processing'
        if os.getenv('R2_BUCKET'):
            from boto3.s3.transfer import TransferConfig
            key = f'temp/{job_id}/{job["filename"]}'
            r2_client().upload_file(str(path), os.environ['R2_BUCKET'], key,
                                    ExtraArgs={'ContentType': 'application/octet-stream'},
                                    Config=TransferConfig(multipart_threshold=16 * 1024 ** 2, multipart_chunksize=16 * 1024 ** 2))
            path.unlink()
            job['storage'] = 'r2'
            job['storageKey'] = key
        else:
            job['storage'] = 'disk'
            job['path'] = str(path)
        with LOCK:
            job['state'] = 'ready'
            job['created'] = time.time()
            job['progress'] = 100
            job['downloadedBytes'] = size
            job['totalBytes'] = size
    except Exception as error:
        with LOCK:
            job['state'] = 'cancelled' if job['cancel'].is_set() else 'error'
            job['error'] = None if job['cancel'].is_set() else extraction_error(error) if isinstance(error, yt_dlp.utils.DownloadError) else str(error)[:350]
        shutil.rmtree(folder, ignore_errors=True)


@app.post('/jobs')
def create_jobs(data: JobsInput, request: Request):
    client = owner(request)
    with LOCK:
        inspection = INSPECTIONS.get(data.inspectionId)
        if not inspection or inspection['owner'] != client or time.time() - inspection['created'] > 1200:
            raise HTTPException(400, 'This preview expired. Inspect the URL again.')
        active = sum(j['state'] in ('queued', 'running', 'processing') for j in JOBS.values())
        if active + len(data.selections) > MAX_QUEUE:
            raise HTTPException(429, 'The downloader is busy. Try again shortly.')
        if sum(j['owner'] == client and j['state'] in ('queued', 'running', 'processing') for j in JOBS.values()) + len(data.selections) > 20:
            raise HTTPException(429, 'Finish your current downloads before starting more.')
        prepared = []
        for selection in data.selections:
            item = next((x for x in inspection['items'] if x['index'] == selection.index), None)
            choice = next((x for x in item['_choices'] if x['id'] == selection.choice), None) if item else None
            if not choice:
                raise HTTPException(400, 'Selected quality is no longer available. Inspect the URL again.')
            if choice.get('size') and choice['size'] > MAX_BYTES:
                raise HTTPException(413, 'The selected file exceeds 5 GB.')
            prepared.append((item, choice))
        jobs = []
        for item, choice in prepared:
            job_id = uuid.uuid4().hex
            job = {'id': job_id, 'owner': client, 'url': inspection['url'], 'index': item['index'],
                   'is_playlist': inspection['is_playlist'], 'choice': choice, 'entry': item['_entry'], 'title': item['title'], 'kind': choice['kind'],
                   'state': 'queued', 'progress': 0, 'downloadedBytes': 0, 'totalBytes': choice.get('size'),
                   'size': choice.get('size'), 'error': None, 'created': time.time(),
                   'source_created': inspection['created'], 'cancel': threading.Event()}
            JOBS[job_id] = job
            jobs.append(job)
    for job in jobs:
        fmt = direct_format(job)
        if fmt:
            with LOCK:
                job['direct'] = True
                job['state'] = 'ready'
                job['filename'] = filename(job['title'], fmt.get('ext') or 'bin')
                job['size'] = fmt.get('filesize') or fmt.get('filesize_approx') or job['size']
                job['totalBytes'] = job['size']
                job['progress'] = 100
                job['created'] = time.time()
        else:
            EXECUTOR.submit(run_job, job['id'])
    return {'jobs': [public_job(job) for job in jobs]}


@app.get('/jobs')
def list_jobs(request: Request):
    client = owner(request)
    with LOCK:
        return {'jobs': [public_job(job) for job in JOBS.values() if job['owner'] == client]}


@app.get('/jobs/{job_id}')
def job_status(job_id: str, request: Request):
    return public_job(get_job(job_id, owner(request)))


@app.post('/jobs/{job_id}/cancel')
def cancel_job(job_id: str, request: Request):
    job = get_job(job_id, owner(request))
    job['cancel'].set()
    with LOCK:
        if job['state'] in ('queued', 'ready'):
            job['state'] = 'cancelled'
            job['created'] = time.time() - TTL - 1
    return public_job(job)


@app.get('/files/{job_id}/meta')
def file_meta(job_id: str, request: Request):
    job = get_job(job_id, owner(request))
    if job['state'] != 'ready':
        raise HTTPException(409, 'The file is not ready.')
    job['created'] = time.time()
    return {'storage': 'r2' if job.get('storage') == 'r2' else 'backend', 'storageKey': job.get('storageKey'),
            'filename': job['filename'], 'size': job.get('size'), 'contentType': 'application/octet-stream'}


def parse_range(raw, size):
    if not raw:
        return None
    if not raw.startswith('bytes=') or ',' in raw:
        raise HTTPException(416, 'Only one byte range is supported.')
    try:
        first, last = raw[6:].split('-', 1)
        if not first:
            length = int(last)
            if length <= 0:
                raise ValueError()
            return max(0, size - length), size - 1
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
        if start < 0 or start > end or start >= size:
            raise ValueError()
        return start, end
    except (ValueError, TypeError):
        raise HTTPException(416, 'The requested range is not available.') from None


def file_chunks(path, start, end):
    with open(path, 'rb') as file:
        file.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


@app.get('/files/{job_id}')
def serve_file(job_id: str, request: Request):
    job = get_job(job_id, owner(request))
    if job['state'] != 'ready':
        raise HTTPException(409, 'The file is not ready.')
    job['created'] = time.time()
    if job.get('direct'):
        try:
            fmt = selected_format(job['entry'], job['choice']['format']) if time.time() - job['source_created'] < 1200 else inspect_selected(job)
            source = safe_source(fmt['url'])
            headers = {k: v for k, v in (fmt.get('http_headers') or {}).items() if k.lower() in ('user-agent', 'referer', 'accept', 'accept-language')}
            headers['Accept-Encoding'] = 'identity'
            if request.headers.get('range'):
                headers['Range'] = request.headers['range']
            client = httpx.Client(timeout=httpx.Timeout(30, read=120), follow_redirects=False)
            for _ in range(4):
                response = client.send(client.build_request('GET', source, headers=headers), stream=True)
                if response.status_code not in (301, 302, 303, 307, 308):
                    break
                source = safe_source(urljoin(source, response.headers.get('location', '')))
                response.close()
            if response.status_code not in (200, 206):
                response.close(); client.close()
                raise HTTPException(502, 'The source no longer permits this download. Inspect the URL again.')
            length = int(response.headers.get('content-length') or 0)
            if length > MAX_BYTES or (request.headers.get('range') and response.status_code != 206):
                response.close(); client.close()
                raise HTTPException(502, 'The source could not provide the selected byte range or exceeds 5 GB.')
            def chunks():
                try:
                    sent = 0
                    for chunk in response.iter_bytes(chunk_size=1024 * 1024):
                        sent += len(chunk)
                        if sent > MAX_BYTES:
                            raise RuntimeError('The source exceeded the 5 GB limit.')
                        yield chunk
                finally:
                    response.close(); client.close()
            pass_headers = {name: response.headers[name] for name in ('content-length', 'content-range', 'etag') if name in response.headers}
            pass_headers['Accept-Ranges'] = 'bytes'
            return StreamingResponse(chunks(), status_code=response.status_code, headers=pass_headers, media_type='application/octet-stream')
        except (ValueError, yt_dlp.utils.DownloadError) as error:
            raise HTTPException(502, extraction_error(error)) from error
    if job.get('storage') == 'r2':
        raise HTTPException(409, 'Cloudflare Worker serves this R2 file.')
    path = Path(job['path'])
    if not path.is_file():
        raise HTTPException(410, 'The temporary file has expired.')
    size = path.stat().st_size
    byte_range = parse_range(request.headers.get('range'), size)
    start, end = byte_range or (0, size - 1)
    headers = {'Accept-Ranges': 'bytes', 'Content-Length': str(end - start + 1)}
    if byte_range:
        headers['Content-Range'] = f'bytes {start}-{end}/{size}'
    return StreamingResponse(file_chunks(path, start, end), status_code=206 if byte_range else 200,
                             headers=headers, media_type='application/octet-stream')

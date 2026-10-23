import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from cloud_backend import app as media

CLIENT_ID = '11111111-1111-4111-8111-111111111111'
HEADERS = {'X-Backend-Key': 'test-secret', 'X-Client-ID': CLIENT_ID}


class CloudBackendTests(unittest.TestCase):
    def setUp(self):
        self.secret = patch.object(media, 'SECRET', 'test-secret')
        self.secret.start()
        self.client = TestClient(media.app)
        media.JOBS.clear()
        media.INSPECTIONS.clear()

    def tearDown(self):
        self.client.close()
        self.secret.stop()
        media.JOBS.clear()
        media.INSPECTIONS.clear()

    def test_private_api_requires_worker_secret(self):
        response = self.client.get('/jobs', headers={'X-Client-ID': CLIENT_ID})
        self.assertEqual(response.status_code, 403)

    def test_platform_bot_wall_has_clear_message(self):
        message = media.extraction_error(Exception('Sign in to confirm you are not a bot. Use cookies'))
        self.assertIn('blocking automated access', message)
        self.assertNotIn('cookies', message)

    def test_youtube_cloud_restriction_has_clear_message(self):
        message = media.extraction_error(Exception('ERROR: [youtube] h3mMpyCSgAg: Failed to extract any player response'))
        self.assertIn('refusing requests from this cloud server', message)
        self.assertNotIn('report this issue', message)

    def test_range_streams_only_requested_bytes_and_checks_owner(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'clip.bin'
            path.write_bytes(b'0123456789')
            job_id = 'a' * 32
            media.JOBS[job_id] = {'id': job_id, 'owner': CLIENT_ID, 'state': 'ready', 'path': str(path),
                                  'storage': 'disk', 'filename': 'clip.bin', 'size': 10, 'created': 0,
                                  'cancel': threading.Event()}
            response = self.client.get(f'/files/{job_id}', headers={**HEADERS, 'Range': 'bytes=3-6'})
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.content, b'3456')
            self.assertEqual(response.headers['content-range'], 'bytes 3-6/10')
            self.assertEqual(self.client.get(f'/files/{job_id}', headers={**HEADERS, 'Range': 'bytes=20-'}).status_code, 416)
            self.assertEqual(self.client.get(f'/files/{job_id}', headers={**HEADERS, 'X-Client-ID': '22222222-2222-4222-8222-222222222222'}).status_code, 404)

    def test_inspection_keeps_exact_quality_and_private_choices_server_side(self):
        info = {'id': 'one', 'title': 'Clip', 'formats': [
            {'format_id': 'v1', 'height': 720, 'ext': 'mp4', 'vcodec': 'avc1', 'acodec': 'none', 'tbr': 1000},
            {'format_id': 'a1', 'ext': 'm4a', 'vcodec': 'none', 'acodec': 'aac', 'abr': 128},
        ]}
        with patch.object(media, 'extract', return_value=info), patch.object(media, 'direct_format', return_value=None), patch.object(media.EXECUTOR, 'submit') as submit:
            response = self.client.post('/inspect', json={'url': 'https://www.youtube.com/watch?v=example'}, headers=HEADERS)
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertNotIn('_choices', str(payload))
            self.assertEqual(payload['items'][0]['choices'][0]['id'], 'video:720')
            created = self.client.post('/jobs', json={'inspectionId': payload['inspectionId'], 'selections': [{'index': 1, 'choice': 'video:720'}]}, headers=HEADERS)
            self.assertEqual(created.status_code, 200)
            job_id = created.json()['jobs'][0]['id']
            self.assertEqual(media.JOBS[job_id]['choice']['format'], 'v1+a1')
            submit.assert_called_once()


if __name__ == '__main__':
    unittest.main()

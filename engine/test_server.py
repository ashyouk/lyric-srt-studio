import time
import unittest
from fastapi.testclient import TestClient
from engine import server


class LocalBoundaryTests(unittest.TestCase):
    def setUp(self):
        server.LAN = False
        self.client = TestClient(server.app, base_url='http://127.0.0.1', client=('127.0.0.1', 40000))

    def tearDown(self):
        self.client.close()
        server.LAN = False

    def test_health_and_beta_remain_available(self):
        self.assertEqual(self.client.get('/api/health').json()['engine'], 'local-pc')
        self.assertIn('v2.3.3', self.client.get('/').text)

    def test_source_jobs_and_secrets_are_not_static(self):
        for path in ['/.git/config', '/engine/server.py', '/.studio-data/jobs', '/.env']:
            self.assertEqual(self.client.get(path).status_code, 404)

    def test_cross_origin_upload_is_rejected(self):
        self.assertEqual(self.client.post('/api/media', headers={'Origin':'https://other.invalid'}).status_code, 403)

    def test_dns_rebinding_hostname_is_rejected(self):
        self.assertEqual(self.client.get('/api/health', headers={'Host':'other.invalid'}).status_code, 403)

    def test_file_extension_and_invalid_media_are_rejected(self):
        self.assertEqual(self.client.post('/api/media', files={'file':('test.exe',b'no')}).status_code, 415)
        self.assertEqual(self.client.post('/api/media', files={'file':('test.wav',b'not a wav')}).status_code, 400)

    def test_job_requires_an_object(self):
        self.assertEqual(self.client.post('/api/jobs/align', json=[]).status_code, 400)

    def test_queued_job_cancels_without_starting_a_model(self):
        with server.worker_lock:
            job = self.client.post('/api/jobs/align', json={'mediaId':'missing'}).json()['id']
            self.assertEqual(self.client.post(f'/api/jobs/{job}/cancel').json()['status'], 'cancelled')
        time.sleep(.02)
        self.assertEqual(self.client.get(f'/api/jobs/{job}').json()['status'], 'cancelled')

    def test_lan_requires_session_access_and_sets_http_only_cookie(self):
        server.LAN = True
        self.assertEqual(self.client.get('/api/health').status_code, 401)
        response = self.client.get('/video/?token='+server.TOKEN, follow_redirects=False)
        self.assertIn('HttpOnly', response.headers['set-cookie'])
        self.assertEqual(self.client.get('/api/health').status_code, 200)


if __name__ == '__main__':
    unittest.main()

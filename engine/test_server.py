import time
import unittest
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import MagicMock, patch
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

    def test_model_choice_rejects_external_sources_before_job_creation(self):
        for model in ['https://example.invalid/model', '../model', 'unknown', ['small'], {'name':'small'}]:
            self.assertEqual(self.client.post('/api/jobs/align', json={'asrModel':model}).status_code, 400)

    def test_complete_is_published_only_after_result_is_ready(self):
        with TemporaryDirectory(prefix='lyric-job-test-') as temporary:
            source={'id':'source', 'path':Path(temporary)/'input.wav', 'duration':2, 'hasAudio':True}
            process=MagicMock();process.stdout=[json.dumps({'stage':'complete'})+'\n'];process.wait.return_value=0
            job={'id':'publish-test', 'status':'queued', 'started':time.monotonic()}
            def result_probe(path):
                self.assertEqual(job['status'], 'running')
                self.assertNotIn('result', job)
                return {'hasAudio':True, 'hasVideo':True, 'duration':2}
            with patch.dict(server.jobs, {'publish-test':job}, clear=True), \
                 patch.object(server,'JOBS',Path(temporary)), patch.object(server,'asset',return_value=source), \
                 patch.object(server.subprocess,'Popen',return_value=process), patch.object(server,'probe',side_effect=result_probe):
                server.run_job('publish-test','export',{'project':{},'includeUnreviewed':True})
            self.assertEqual(job['status'],'complete')
            self.assertEqual(job['result']['reviewMode'],'audition')

    def test_cancel_during_result_validation_does_not_publish_complete(self):
        with TemporaryDirectory(prefix='lyric-cancel-test-') as temporary:
            source={'id':'source', 'path':Path(temporary)/'input.wav', 'duration':2, 'hasAudio':True}
            process=MagicMock();process.stdout=[];process.wait.return_value=0
            job={'id':'cancel-test', 'status':'queued', 'started':time.monotonic()}
            def cancel_while_probing(path):
                job.update(status='cancelled',cancelRequested=True)
                return {'hasAudio':True,'hasVideo':True}
            with patch.dict(server.jobs, {'cancel-test':job}, clear=True), \
                 patch.object(server,'JOBS',Path(temporary)), patch.object(server,'asset',return_value=source), \
                 patch.object(server.subprocess,'Popen',return_value=process), patch.object(server,'probe',side_effect=cancel_while_probing):
                server.run_job('cancel-test','export',{'project':{}})
            self.assertEqual(job['status'],'cancelled')
            self.assertNotIn('result',job)

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

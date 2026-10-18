import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location("worker", Path(__file__).parents[1] / "worker.py")
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_long_article_is_not_truncated(self):
        text = " ".join(f"word{i}" for i in range(7000))
        clean = worker.clean_text(text)
        chunks = worker.split_text(clean)
        self.assertEqual(" ".join(chunks).split(), text.split())
        self.assertGreater(len(chunks), 20)
        self.assertIn("word6999", chunks[-1])

    def test_markup_preserves_economic_meaning(self):
        cleaned = worker.clean_text("# Prices\n\n**Inflation** is 2.5%; wages rose $1.50.\n\n[Source](https://example.org).", "Report")
        self.assertIn("2.5%", cleaned)
        self.assertIn("$1.50", cleaned)
        self.assertIn("Source.", cleaned)
        self.assertNotIn("https://", cleaned)
        self.assertTrue(cleaned.startswith("Report."))

    def test_html_and_images(self):
        cleaned = worker.clean_text('<p>Before <strong>tax</strong>.</p><script>bad()</script><p>After tax.</p>')
        self.assertIn("Before tax.", cleaned)
        self.assertNotIn("bad()", cleaned)
        self.assertEqual(worker.clean_text("![chart](image.png)\n\nText"), "Text")

    def test_empty_input_fails(self):
        with self.assertRaises(ValueError):
            worker.clean_text("   ")

    def test_long_unbroken_token_is_retained(self):
        text = "x" * 800
        self.assertEqual(worker.split_text(text), [text])

    def test_stale_worker_cannot_continue(self):
        api = Mock()
        api.rpc.return_value = False
        lease = worker.JobLease(api, {"id": "job"}, "token")
        with self.assertRaises(worker.LeaseLost):
            lease.progress(1, 3)
        self.assertTrue(lease.lost.is_set())

    def test_cached_sections_are_reused_after_interruption(self):
        import numpy as np
        import soundfile as sf
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            text = "First section.\n\nSecond section."
            digest = worker.hashlib.sha256((worker.PIPELINE_VERSION + "\n" + text).encode()).hexdigest()
            work = cache / digest
            work.mkdir()
            sf.write(work / "00000.wav", np.sin(np.arange(24000) * .1) * .1, 24000)
            calls = []
            def generate(command, **kwargs):
                if "--render-chunk" in command:
                    calls.append(command[-1])
                    sf.write(command[-1], np.sin(np.arange(24000) * .1) * .1, 24000)
                    return Mock(returncode=0)
                Path(command[-1]).write_bytes(b"test-mp3" * 500)
                return Mock(returncode=0)
            progress = []
            with patch.object(worker.subprocess, "run", side_effect=generate):
                result = worker.generate_recording(text, "", cache, lambda n, total: progress.append((n,total)))
            self.assertEqual(len(calls), 1)
            self.assertTrue(calls[0].endswith("00001.wav"))
            self.assertTrue(result.exists())
            self.assertEqual(progress[-1], (2,2))

    def test_timeout_fails_loudly(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(worker.subprocess, "run", side_effect=worker.subprocess.TimeoutExpired("render", 180)):
                with self.assertRaisesRegex(RuntimeError, "three-minute"):
                    worker.generate_recording("A paragraph that will time out.", "", Path(directory))

    def test_storage_budget_blocks_upload_without_deleting_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            recording = state / 'trial.mp3'
            recording.write_bytes(b'audio' * 1000)
            api = Mock(user='user')
            api.rpc.return_value = worker.STORAGE_BUDGET
            job = {'id': 'job', 'source_content': 'article', 'title': 'Title'}
            lease = Mock()
            lease.__enter__ = Mock(return_value=lease)
            lease.__exit__ = Mock(return_value=False)
            with patch.object(worker, 'generate_recording', return_value=recording), patch.object(worker, 'JobLease', return_value=lease):
                with self.assertRaisesRegex(RuntimeError, 'free limit'):
                    worker.process_job(api, job, 'token', state)
            api.call.assert_not_called()
            self.assertTrue(recording.exists())


if __name__ == "__main__":
    unittest.main()

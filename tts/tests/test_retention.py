import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('retention', Path(__file__).parents[1] / 'retention.py')
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)
USER = '10000000-0000-4000-8000-000000000001'
KEY = USER + '/20000000-0000-4000-8000-000000000001.mp3'


class RetentionTests(unittest.TestCase):
    def test_no_expired_audio_does_not_delete_anything(self):
        api = Mock(user=USER)
        api.rpc.return_value = []
        self.assertEqual(retention.cleanup_expired_audio(api), 0)
        api.call.assert_not_called()

    def test_exact_private_paths_only_and_ack_after_delete(self):
        api = Mock(user=USER)
        api.rpc.side_effect = [[{'id':'outbox-id', 'object_name':KEY}], 1]
        self.assertEqual(retention.cleanup_expired_audio(api), 1)
        api.call.assert_called_once_with('/storage/v1/object/stash-audio',
            {'prefixes':[KEY]}, method='DELETE', timeout=120)
        self.assertEqual(api.rpc.call_args_list[-1].args[0], 'ack_stash_audio_deletions')

    def test_delete_failure_leaves_outbox_unacknowledged(self):
        api = Mock(user=USER)
        api.rpc.return_value = [{'id':'outbox-id','object_name':KEY}]
        api.call.side_effect = RuntimeError('Network unavailable')
        with self.assertRaises(RuntimeError):
            retention.cleanup_expired_audio(api)
        self.assertEqual(api.rpc.call_count, 1)

    def test_unexpected_paths_never_reach_storage_api(self):
        for key in ['other-user/file.mp3', USER+'/', USER+'/../file.mp3', USER+'/recording.mp3']:
            with self.subTest(key=key):
                api = Mock(user=USER)
                api.rpc.return_value = [{'id':'outbox-id','object_name':key}]
                with self.assertRaisesRegex(RuntimeError,'unexpected object path'):
                    retention.cleanup_expired_audio(api)
                api.call.assert_not_called()


if __name__ == '__main__':
    unittest.main()

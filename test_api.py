import asyncio
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import intent

spec = importlib.util.spec_from_file_location('handoff_api', Path(__file__).parent / 'dashboard' / 'plugin_api.py')

class ApiTest(unittest.TestCase):
    def test_registered_request_can_poll_and_ack_but_unknown_token_cannot(self):
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp, patch.object(module.intent, 'database_path', return_value=Path(tmp) / 'intent.db'):
            identity = dict(requestId='nonce', profile='default', oldId='old', oldTitle='Old', title='Old 2')
            asyncio.run(module.register_request(identity))
            assert asyncio.run(module.get_request('nonce', 'default'))['status'] == 'preparing'
            with self.assertRaises(Exception):
                asyncio.run(module.register_request({**identity, 'requestId': 'other', 'profile': 'other'}))
            with self.assertRaises(Exception):
                asyncio.run(module.get_request('nonce', 'other'))
            with self.assertRaises(Exception):
                asyncio.run(module.get_request('other', 'default'))
            module.intent.deliver({**identity, 'handoff': 'Facts'})
            assert asyncio.run(module.get_request('nonce', 'default'))['handoff'] == 'Facts'
            asyncio.run(module.ack_request('nonce', dict(profile='default', status='writing', claim='test-owner')))
            assert module.intent.read('nonce', 'default')['status'] == 'writing'

if __name__ == '__main__':
    unittest.main()

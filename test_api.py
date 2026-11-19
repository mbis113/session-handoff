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

    def test_failed_diagnostic_is_profile_scoped_and_rejects_raw_error(self):
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as tmp, patch.object(module.intent, 'database_path', return_value=Path(tmp) / 'intent.db'):
            identity = dict(requestId='nonce', profile='default', oldId='old', oldTitle='Old', title='Old 2')
            asyncio.run(module.register_request(identity))
            module.intent.deliver({**identity, 'handoff': 'SECRET HANDOFF'})
            asyncio.run(module.ack_request('nonce', dict(profile='default', status='writing', claim='owner')))
            with self.assertRaises(Exception):
                asyncio.run(module.ack_request('nonce', dict(profile='default', status='failed', claim='owner', stage='open', reason='operation_failed', error='https://private.example/SECRET')))
            assert module.intent.read('nonce', 'default')['status'] == 'writing'
            asyncio.run(module.ack_request('nonce', dict(profile='default', status='failed', claim='owner', stage='open', reason='operation_failed')))
            result = asyncio.run(module.get_request('nonce', 'default'))
            assert result['stage'] == 'open' and result['reason'] == 'operation_failed'
            assert result['handoff'] is None
            with self.assertRaises(Exception):
                asyncio.run(module.get_request('nonce', 'other'))

if __name__ == '__main__':
    unittest.main()

import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('session_handoff_review', Path(__file__).with_name('__init__.py'))
assert spec is not None and spec.loader is not None
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / 'state.db'
        conn = sqlite3.connect(self.db)
        try:
            conn.execute('CREATE TABLE sessions (id TEXT, title TEXT, source TEXT, created_source TEXT, profile_name TEXT, archived INTEGER, pinned INTEGER, runtime_revision INTEGER)')
            conn.execute('INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)', ('old', 'Старый чат', 'desktop', 'desktop', 'default', 0, 1, 1))
            conn.commit()
        finally:
            conn.close()
        self.args = {'old_id': 'old', 'old_title': 'Старый чат', 'profile': 'default', 'title': 'Старый чат 2', 'handoff': 'Проверено: тест. Далее: работа.', 'request_id': 'abc-123'}

    def test_valid_agent_content_is_broadcast_with_request_id_without_second_yes(self):
        with patch.object(bridge, 'broadcast_plugin_event') as emit:
            result = json.loads(bridge.prepare_handoff(self.args, db_path=self.db))
        self.assertEqual(result['status'], 'sent_unacknowledged')
        emit.assert_called_once()
        self.assertEqual(emit.call_args.args[2]['requestId'], 'abc-123')
        self.assertNotIn('confirmed', emit.call_args.args[2])

    def test_missing_request_id_never_emits(self):
        with patch.object(bridge, 'broadcast_plugin_event') as emit:
            result = json.loads(bridge.prepare_handoff({k:v for k,v in self.args.items() if k != 'request_id'}, db_path=self.db))
        self.assertEqual(result['status'], 'rejected')
        emit.assert_not_called()

    def test_wrong_old_title_never_emits(self):
        with patch.object(bridge, 'broadcast_plugin_event') as emit:
            result = json.loads(bridge.prepare_handoff({**self.args, 'old_title': 'wrong'}, db_path=self.db))
        self.assertEqual(result['status'], 'rejected')
        emit.assert_not_called()


if __name__ == '__main__':
    unittest.main()

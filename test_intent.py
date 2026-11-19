import importlib.util
import json
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('handoff_intent', Path(__file__).with_name('intent.py'))
intent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intent)


class IntentTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'intent.db'
        self.identity = dict(requestId='token-1', oldId='old', oldTitle='Старый чат',
                             profile='default', title='Старый чат 2')
        self.payload = {**self.identity, 'handoff': 'Проверено'}

    def test_registered_intent_survives_new_store_instance_and_ack_is_idempotent(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver(self.payload)
            self.assertEqual(intent.read('token-1', 'default')['status'], 'ready')
            self.assertEqual(intent.read('wrong', 'default'), None)
            self.assertEqual(intent.read('token-1', 'other'), None)
            intent.ack('token-1', 'default', 'writing', claim='owner-1')
            intent.ack('token-1', 'default', 'completed', 'new', claim='owner-1')
            self.assertEqual(intent.read('token-1', 'default')['status'], 'completed')
            self.assertEqual(intent.read('token-1', 'default')['newId'], 'new')
            with self.assertRaises(ValueError):
                intent.ack('token-1', 'default', 'failed', None)

    def test_unregistered_or_mismatched_delivery_is_rejected(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            with self.assertRaises(ValueError):
                intent.deliver(self.payload)
            intent.register(self.identity)
            with self.assertRaises(ValueError):
                intent.deliver({**self.payload, 'title': 'Неверно 2'})
            self.assertEqual(intent.read('token-1', 'default')['status'], 'preparing')
            intent.deliver(self.payload)
            intent.deliver(self.payload)
            with self.assertRaises(ValueError):
                intent.deliver({**self.payload, 'handoff': 'Другое'})

    def test_cancel_invalidates_delivery_and_expired_intent(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity, now=1)
            with self.assertRaises(ValueError):
                intent.deliver(self.payload, now=400)
            intent.register({**self.identity, 'requestId': 'token-2'}, now=400)
            intent.ack('token-2', 'default', 'cancelled', None)
            with self.assertRaises(ValueError):
                intent.deliver({**self.payload, 'requestId': 'token-2'}, now=401)

    def test_registration_cannot_replace_existing_intent(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            with self.assertRaises(ValueError):
                intent.register(self.identity)

    def test_claim_is_single_owner_and_mismatched_completion_is_rejected(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver(self.payload)
            intent.ack('token-1', 'default', 'writing', claim='owner-1')
            with self.assertRaises(ValueError):
                intent.ack('token-1', 'default', 'writing', claim='owner-2')
            with self.assertRaises(ValueError):
                intent.ack('token-1', 'default', 'completed', 'new', claim='owner-2')
            intent.ack('token-1', 'default', 'completed', 'new', claim='owner-1')

    def test_concurrent_claim_has_only_one_winner(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver(self.payload)
            def claim(owner):
                try:
                    intent.ack('token-1', 'default', 'writing', claim=owner)
                    return True
                except ValueError:
                    return False
            with ThreadPoolExecutor(max_workers=2) as pool:
                winners = list(pool.map(claim, ('owner-1', 'owner-2')))
            self.assertEqual(winners.count(True), 1)

    def test_durable_read_after_completed_ack_has_no_handoff_text(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver(self.payload)
            intent.ack('token-1', 'default', 'writing', claim='owner')
            intent.ack('token-1', 'default', 'completed', 'new', claim='owner')
            self.assertIsNone(intent.read('token-1', 'default')['handoff'])

    def test_failed_ack_migrates_legacy_db_and_persists_only_bounded_diagnostic(self):
        with sqlite3.connect(self.path) as db:
            db.execute('''CREATE TABLE intents (request_id TEXT PRIMARY KEY, profile TEXT NOT NULL,
                identity TEXT NOT NULL, status TEXT NOT NULL, handoff TEXT, new_id TEXT,
                created_at REAL NOT NULL, claim TEXT)''')
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver({**self.payload, 'handoff': 'PRIVATE HANDOFF'})
            intent.ack('token-1', 'default', 'writing', claim='owner')
            intent.ack('token-1', 'default', 'failed', claim='owner', stage='create', reason='operation_failed')
            row = intent.read('token-1', 'default')
            self.assertEqual((row['status'], row['stage'], row['reason']), ('failed', 'create', 'operation_failed'))
            self.assertIsNone(row['handoff'])
            self.assertIsNone(intent.read('token-1', 'other'))
            with sqlite3.connect(self.path) as db:
                stored = db.execute('SELECT stage, reason, handoff FROM intents').fetchone()
            self.assertEqual(stored, ('create', 'operation_failed', None))

    def test_failed_ack_rejects_unbounded_or_non_failure_diagnostics(self):
        with patch.object(intent, 'database_path', return_value=self.path):
            intent.register(self.identity)
            intent.deliver(self.payload)
            intent.ack('token-1', 'default', 'writing', claim='owner')
            for stage, reason in [('https://secret', 'operation_failed'), ('create', 'PRIVATE HANDOFF')]:
                with self.assertRaises(ValueError):
                    intent.ack('token-1', 'default', 'failed', claim='owner', stage=stage, reason=reason)
            self.assertEqual(intent.read('token-1', 'default')['status'], 'writing')
            with self.assertRaises(ValueError):
                intent.ack('token-1', 'default', 'completed', 'new', claim='owner', stage='create')

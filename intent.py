"""Durable, single-request Desktop handoff mailbox (not a session store)."""
import json
import sqlite3
import time
from contextlib import closing

from plugins.plugin_storage import plugin_data_dir

TTL = 300
FIELDS = ('requestId', 'oldId', 'oldTitle', 'profile', 'title')


def database_path():
    return plugin_data_dir('session-handoff-review') / 'intent.db'


def _db():
    db = sqlite3.connect(database_path(), timeout=10)
    db.execute('''CREATE TABLE IF NOT EXISTS intents (
        request_id TEXT PRIMARY KEY, profile TEXT NOT NULL, identity TEXT NOT NULL,
        status TEXT NOT NULL, handoff TEXT, new_id TEXT, created_at REAL NOT NULL,
        claim TEXT)''')
    return db


def _identity(data):
    value = {key: data.get(key) for key in FIELDS}
    if any(not isinstance(v, str) or not v.strip() for v in value.values()):
        raise ValueError('Incomplete handoff identity')
    return value


def register(data, now=None):
    value = _identity(data)
    with closing(_db()) as db:
        try:
            with db:
                db.execute('INSERT INTO intents (request_id,profile,identity,status,handoff,new_id,created_at) VALUES (?,?,?,?,?,?,?)',
                           (value['requestId'], value['profile'], json.dumps(value, ensure_ascii=False),
                            'preparing', None, None, time.time() if now is None else now))
        except sqlite3.IntegrityError as exc:
            raise ValueError('Request already registered') from exc
    return {'status': 'preparing', 'requestId': value['requestId']}


def read(request_id, profile):
    with closing(_db()) as db:
        row = db.execute('SELECT identity,status,handoff,new_id,created_at FROM intents WHERE request_id=? AND profile=?',
                         (request_id, profile)).fetchone()
    if not row:
        return None
    identity, status, handoff, new_id, created = row
    return {**json.loads(identity), 'status': status, 'handoff': handoff,
            'newId': new_id, 'createdAt': created}


def deliver(data, now=None):
    identity = _identity(data)
    handoff = data.get('handoff')
    if not isinstance(handoff, str) or not handoff.strip():
        raise ValueError('Missing handoff')
    with closing(_db()) as db:
        with db:
            row = db.execute('SELECT identity,status,handoff,created_at FROM intents WHERE request_id=? AND profile=?',
                             (identity['requestId'], identity['profile'])).fetchone()
            if not row or json.loads(row[0]) != identity:
                raise ValueError('No matching Desktop request')
            if (time.time() if now is None else now) - row[3] > TTL:
                raise ValueError('Desktop request expired')
            if row[1] == 'ready' and row[2] == handoff:
                return {'status': 'ready'}
            if row[1] != 'preparing':
                raise ValueError('Request already delivered or closed')
            updated = db.execute('UPDATE intents SET status=?, handoff=? WHERE request_id=? AND profile=? AND status=?',
                                 ('ready', handoff.strip(), identity['requestId'], identity['profile'], 'preparing'))
            if updated.rowcount != 1:
                raise ValueError('Request changed concurrently')
    return {'status': 'ready'}


def ack(request_id, profile, status, new_id=None, claim=None):
    if status not in ('cancelled', 'writing', 'completed', 'failed'):
        raise ValueError('Invalid acknowledgement')
    with closing(_db()) as db:
        with db:
            row = db.execute('SELECT status,claim FROM intents WHERE request_id=? AND profile=?', (request_id, profile)).fetchone()
            if not row:
                raise ValueError('Request not found')
            current, owner = row
            allowed = {'preparing': ('cancelled',), 'ready': ('cancelled', 'writing'),
                       'writing': ('completed', 'failed')}
            if status not in allowed.get(current, ()):
                raise ValueError(f'Invalid transition {current} → {status}')
            if status == 'writing':
                if not isinstance(claim, str) or not claim.strip():
                    raise ValueError('Missing claim ID')
            elif current == 'writing' and (not claim or claim != owner):
                raise ValueError('Claim owner mismatch')
            if status == 'completed' and (not isinstance(new_id, str) or not new_id.strip()):
                raise ValueError('Completed request needs verified new ID')
            updated = db.execute('''UPDATE intents SET status=?, new_id=?, claim=?,
                                    handoff=CASE WHEN ? IN ('completed','failed','cancelled') THEN NULL ELSE handoff END
                                    WHERE request_id=? AND profile=? AND status=?''',
                                 (status, new_id, claim if status == 'writing' else owner,
                                  status, request_id, profile, current))
            if updated.rowcount != 1:
                raise ValueError('Request state changed concurrently')
    return {'status': status, 'requestId': request_id}

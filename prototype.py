"""Read-only session inventory and pure handoff decisions; no gateway writes."""
import argparse
from contextlib import closing
import json
import re
import sqlite3
from pathlib import Path

DEFAULT_DB = Path.home() / '.hermes' / 'state.db'
CONTEXT_UNKNOWN = 'unavailable: state.db has no reliable live prompt/window occupancy'
ACTIONS = ['create desktop session (RPC, after approval)',
           'submit handoff and verify target transcript (RPC)',
           'pin new after verification (revision-fenced RPC)',
           'unpin old after new pin read-back (revision-fenced RPC)']


def _read_db(path):
    path = Path(path).expanduser().resolve(strict=True)
    # immutable=1 avoids WAL writes, but ignores uncheckpointed live writes; mode=ro sees live WAL.
    return sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True)


def inventory(path=DEFAULT_DB, profile='default'):
    """Only explicit Desktop rows in the selected profile; no token-percent inference."""
    path = Path(path).expanduser().resolve(strict=True)
    with closing(_read_db(path)) as db:
        db.row_factory = sqlite3.Row
        records = db.execute('''SELECT id,title,source,created_source,profile_name,pinned,archived,hidden,
                                  started_at,last_activity_at,runtime_revision FROM sessions
                                  WHERE source='desktop' AND created_source='desktop'
                                    AND profile_name=? ORDER BY last_activity_at DESC, started_at DESC, id''', (profile,)).fetchall()
    return [{**dict(r), 'provenance': {'database': str(path), 'table': 'sessions',
             'source': r['source'], 'created_source': r['created_source'],
             'profile_name': r['profile_name']}, 'context_percent': None,
             'context_status': CONTEXT_UNKNOWN} for r in records]


def decide(percent, previous_percent=None, ack_level=0, surface='desktop'):
    """Pure monitor transition. Caller persists acknowledgement only after actual delivery."""
    for value in (percent, previous_percent):
        if value is not None and (not isinstance(value, (int, float)) or not 0 <= value <= 100):
            raise ValueError('percent must be in [0, 100] or unknown')
    if ack_level not in (0, 35, 40, 45):
        raise ValueError('invalid acknowledgement level')
    target = {'desktop': 'desktop_current_session',
              'telegram_dm': 'telegram_same_dm_no_topic'}.get(surface)
    if percent is None:
        return {'level': None, 'ack_level': ack_level, 'notification_target': target}
    if percent < 35:
        return {'level': None, 'ack_level': 0, 'notification_target': target}
    highest = max((n for n in (35, 40, 45) if percent >= n), default=0)
    level = highest if target and highest > ack_level else None
    return {'level': level, 'ack_level': ack_level, 'notification_target': target}


def plan_handoff(path, profile, old_id, suggested_title, handoff):
    """Validate a selected Desktop row and return an inert proposal only."""
    if not profile or not old_id:
        raise ValueError('profile and old session ID required')
    if not isinstance(handoff, str) or not handoff.strip():
        raise ValueError('nonempty verified handoff required')
    if not isinstance(suggested_title, str) or not re.fullmatch(r'.*\S\s+[1-9][0-9]*', suggested_title.strip()):
        raise ValueError('suggested title must end in a positive numeric suffix')
    with closing(_read_db(path)) as db:
        db.row_factory = sqlite3.Row
        row = db.execute('SELECT id,title,source,created_source,profile_name,pinned,archived,runtime_revision FROM sessions WHERE id=?', (old_id,)).fetchone()
        if row is None:
            raise ValueError('old session ID not found')
        if row['profile_name'] != profile:
            raise ValueError('profile mismatch')
        if row['source'] != 'desktop' or row['created_source'] != 'desktop' or row['archived']:
            raise ValueError('old session is not an active desktop session')
        collision = db.execute('SELECT id FROM sessions WHERE profile_name=? AND title=? LIMIT 1',
                               (profile, suggested_title.strip())).fetchone()
        if collision:
            raise ValueError('title collision: ' + collision['id'])
    return {'status': 'proposal_only', 'profile': profile, 'old_session_id': old_id,
            'old_session_revision': row['runtime_revision'], 'suggested_title': suggested_title.strip(),
            'handoff': handoff.strip(), 'actions': ACTIONS, 'archive': False}


def main():
    parser = argparse.ArgumentParser(description='Dry-run only; reads state.db without changing sessions')
    parser.add_argument('--db', type=Path, default=DEFAULT_DB)
    parser.add_argument('--profile', default='default')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('inventory')
    monitor = sub.add_parser('monitor')
    monitor.add_argument('--percent', type=float, help='RPC-supplied live context percentage; absent means unknown')
    monitor.add_argument('--previous-percent', type=float)
    monitor.add_argument('--ack-level', type=int, default=0)
    monitor.add_argument('--surface', choices=['desktop', 'telegram_dm', 'telegram_topic'], default='desktop')
    plan = sub.add_parser('plan')
    plan.add_argument('--old-id', required=True)
    plan.add_argument('--title', required=True)
    plan.add_argument('--handoff', required=True)
    args = parser.parse_args()
    if args.command == 'inventory':
        result = inventory(args.db, args.profile)
    elif args.command == 'monitor':
        result = decide(args.percent, args.previous_percent, args.ack_level, args.surface)
    else:
        result = plan_handoff(args.db, args.profile, args.old_id, args.title, args.handoff)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

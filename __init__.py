"""Agent tool → gateway plugin event → Desktop renderer. No Hermes source edits."""
import json
from pathlib import Path

from hermes_cli.plugin_events import broadcast_plugin_event
try:
    from .prototype import DEFAULT_DB, plan_handoff
except ImportError:  # standalone test module in the prototype root
    from prototype import DEFAULT_DB, plan_handoff

PLUGIN_ID = 'session-handoff-review'


def prepare_handoff(args: dict, db_path: Path = DEFAULT_DB, **kwargs) -> str:
    """Validate a confirmed proposal; event delivery itself is unacknowledged."""
    try:
        if args.get('confirmed') is not True:
            raise ValueError('Explicit user confirmation after the proposed title is required')
        old_id = args['old_id']
        old_title = args['old_title']
        profile = args['profile']
        title = args['title']
        handoff = args['handoff']
        plan = plan_handoff(db_path, profile, old_id, title, handoff)
        if not old_title or old_title == title:
            raise ValueError('Old and new titles must differ')
        # plan_handoff validates profile/source/archive/title collision; check exact old title.
        import sqlite3
        with sqlite3.connect(f'{Path(db_path).resolve(strict=True).as_uri()}?mode=ro', uri=True) as db:
            actual = db.execute('SELECT title FROM sessions WHERE id=?', (old_id,)).fetchone()
        if actual is None or actual[0] != old_title:
            raise ValueError('Old session title mismatch')
        broadcast_plugin_event(PLUGIN_ID, 'prepare', {
            'oldId': old_id, 'oldTitle': old_title, 'profile': profile,
            'title': plan['suggested_title'], 'handoff': plan['handoff'], 'confirmed': True})
        return json.dumps({'status': 'sent_unacknowledged', 'old_id': old_id,
                           'instruction': 'Check target transcript and Desktop before claiming success.'}, ensure_ascii=False)
    except (KeyError, ValueError, TypeError, OSError) as exc:
        return json.dumps({'status': 'rejected', 'error': str(exc)}, ensure_ascii=False)
    except Exception as exc:
        return json.dumps({'status': 'rejected', 'error': f'Bridge failed: {type(exc).__name__}'})


SCHEMA = {
    'name': 'prepare_desktop_handoff',
    'description': 'After proposing the numbered title and receiving explicit user yes IN THIS Desktop chat, send the verified handoff to the Desktop renderer. Never call for Telegram or before confirmation. Event is unacknowledged; verify outcome separately.',
    'parameters': {
        'type': 'object',
        'properties': {
            'old_id': {'type': 'string'}, 'old_title': {'type': 'string'},
            'profile': {'type': 'string'}, 'title': {'type': 'string'},
            'handoff': {'type': 'string'}, 'confirmed': {'type': 'boolean'},
        },
        'required': ['old_id', 'old_title', 'profile', 'title', 'handoff', 'confirmed'],
    },
}


def register(ctx):
    ctx.register_tool(name='prepare_desktop_handoff', toolset='session_handoff',
                      schema=SCHEMA, handler=prepare_handoff)

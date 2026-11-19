"""Profile-scoped, authenticated Hermes plugin REST namespace."""
import importlib.util
from pathlib import Path
from fastapi import APIRouter, HTTPException
from hermes_cli.profiles import get_active_profile_name

# Hermes imports plugin_api.py under an isolated synthetic name, not as a package.
_spec = importlib.util.spec_from_file_location('session_handoff_review_intent', Path(__file__).resolve().parent.parent / 'intent.py')
if _spec is None or _spec.loader is None:
    raise ImportError('Handoff intent module missing')
intent = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(intent)

router = APIRouter()


def _owner(profile):
    if profile != (get_active_profile_name() or 'default'):
        raise HTTPException(403, 'Profile does not own this request')


@router.post('/request')
async def register_request(body: dict):
    _owner(body.get('profile'))
    try:
        return intent.register(body)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get('/request/{request_id}')
async def get_request(request_id: str, profile: str):
    _owner(profile)
    result = intent.read(request_id, profile)
    if result is None:
        raise HTTPException(404, 'Unknown request')
    return result


@router.post('/request/{request_id}/ack')
async def ack_request(request_id: str, body: dict):
    _owner(body.get('profile'))
    try:
        if set(body) - {'profile', 'status', 'newId', 'claim', 'stage', 'reason'}:
            raise ValueError('Unknown acknowledgement field')
        return intent.ack(request_id, body['profile'], body['status'], body.get('newId'), body.get('claim'),
                          body.get('stage'), body.get('reason'))
    except (ValueError, KeyError) as exc:
        raise HTTPException(409, str(exc)) from exc

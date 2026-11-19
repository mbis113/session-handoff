# Session Handoff — private prototype

Hermes Agent plugin prototype for moving a Desktop chat into a fresh named session. **Not production-ready; do not publish yet.**

## Current status

- The agent tool validates the old Desktop row and title in read-only `state.db`, then writes a durable, profile-scoped handoff intent in plugin-data SQLite. An event is only an optional wake-up hint; the Desktop polls the authenticated `ctx.rest` plugin namespace every 3 seconds (including OAuth remotes, where plugin sockets may be unavailable).
- Desktop `↗` presents an editable numbered title. One click registers a random request ID **before** the composer sends the agent's factual-preparation instruction. The agent tool accepts only an exact registered identity and refuses cancelled, expired or mismatched requests. A single claim owns the write phase. There is no second chat confirmation.
- The chip distinguishes registration, factual preparation and migration verification. Preparation has a 5-minute deadline, a failure toast and no automatic retry. Desktop reads the durable handoff, verifies focused profile/old ID and title collision, creates and reads back the new session, submits and reads back its first message, pins and verifies the new chat, opens it, then unpins and verifies the old. It never archives/deletes. Completion is reported only after the server acknowledgement is read back; uncertain failures stop without repeating writes.
- On a claimed `writing → failed` transition, the plugin persists only allowlisted stage/reason codes (not exception strings, URLs or handoff text) in additive intent DB columns. Profile-scoped REST readback exposes these codes. The chip retains the last request reference and displays a failed or still-writing status after renderer reload; an existing local handoff latch can also resolve its earlier request. This is a diagnostic, **not a repair** or proof of the cause of any earlier failure. If the failure acknowledgement itself cannot be confirmed, `writing` remains uncertain; never retry writes automatically. A renderer without a saved request reference/latch cannot discover arbitrary historical requests from this UI.
- Backend plugin REST routes are mounted by Hermes under `/api/plugins/session-handoff-review` with gateway authentication and profile routing; the Desktop client uses its scoped SDK `ctx.rest`. The intent DB lives in the profile's `plugin-data/session-handoff-review/`, separate from user sessions. Both agent and Desktop halves must be separately enabled on remote setups.
- **Not installed or exercised against a real connected Desktop.** Local pending approval remains renderer memory: hot reload/restart or window closure after registration requires manual inspection (the status chip is read-only and never resumes migration); the server does not claim migration completed merely because a tool stored the handoff. Tests with fakes do not prove live remote authentication/routing or native renderer behavior. The original lost/rejected event root cause remains unproven. Do not enable for unrelated sessions.
- The 35/40/45% context alerts are **not implemented**; `prototype.py` contains only read-only inventory and pure threshold decisions.

## Tests

From this repository:

```sh
node --test test_flow.mjs
python -m unittest -v test_bridge test_intent test_api
hermes plugins doctor . --ci
```

These tests exercise the plugin modules against a fake Desktop/gateway and temporary SQLite database; they do not mutate live sessions. They do not prove live remote REST authentication/routing or renderer behavior.

## Privacy / scope

The repository must remain private while the prototype is tested. Do not add session transcripts, tokens, `state.db`, user-specific session identifiers, or gateway secrets. The plugin does not contact GitHub itself.

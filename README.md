# Session Handoff — private prototype

Hermes Agent plugin prototype for moving a Desktop chat into a fresh named session. **Not production-ready; do not publish yet.**

## Current status

- Python agent tool `prepare_desktop_handoff` validates a selected old Desktop session in the server's read-only `state.db`, checks the new title, and broadcasts a gateway event after the user has approved a proposed title.
- Desktop `↗` shows an editable numbered title. Clicking «Переезд» is the only confirmation: the agent is asked for a concise factual handoff, sends it through `prepare_desktop_handoff` with a request ID, and the Desktop half matches the currently pending approval before any write. No second chat «да» or manual paste. The UI shows «Начался переезд…» with «Стоп» while preparation/preflight is still reversible; after the write latch it shows «Завершаю перенос…». After verified migration it says «Вы можете продолжить работу в новой сессии».
- Desktop checks the old profile/title, title collisions, creates the target, submits and reads back the handoff, pins and verifies the new chat, opens and verifies focus, then unpins the old. It never archives/deletes. On uncertain writes it does not automatically retry.
- Agent tool broadcasts an unacknowledged event; only the renderer holding the matching in-memory approval and focused old chat can act. Stopping preparation invalidates that approval, but cannot cancel the already-running agent turn.
- No live end-to-end migration has been tested. The agent half and Desktop half still require separate enable/install on a remote setup; this checkout is not deployed. Gateway event delivery is fire-and-forget, so a lost event can leave preparation pending; hot reload loses the in-memory approval. Cross-window/remote behavior and the factual accuracy of agent-written content still need live verification. **Do not enable for unrelated sessions.**
- The 35/40/45% context alerts are **not implemented** by this plugin. `prototype.py` contains only read-only inventory and pure threshold decisions.

## Tests

From this repository:

```sh
node --test test_flow.mjs
python -m unittest -q test_bridge
```

These tests exercise the real plugin modules against a fake Desktop/gateway and temporary SQLite database; they do not mutate live sessions. They do not prove live event delivery or renderer behavior. The separate development prototype's older tests assume a second confirmation and are not the acceptance tests for this flow.

## Privacy / scope

The repository must remain private while the prototype is tested. Do not add session transcripts, tokens, `state.db`, user-specific session identifiers, or gateway secrets. The plugin does not contact GitHub itself.

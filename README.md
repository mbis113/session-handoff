# Session Handoff — private prototype

Hermes Agent plugin prototype for moving a Desktop chat into a fresh named session. **Not production-ready; do not publish yet.**

## Current status

- Python agent tool `prepare_desktop_handoff` validates a selected old Desktop session in the server's read-only `state.db`, checks the new title, and broadcasts a gateway event after the user has approved a proposed title.
- Desktop half `desktop/plugin.js` adds a compact `↗` + context-occupancy percentage beside the quota chip (gray below 35%, green 35–39%, yellow 40–44%, red from 45%; `≈` for estimates and `↗` alone when unknown). Clicking it opens an editable next-title proposal; the button asks the agent in that chat to prepare a factual handoff. A separate explicit approval of the agent's handoff is still needed. The Desktop half then listens on the gateway event stream, checks the focused old session/profile, creates the new session, submits and checks the handoff message, pins the new session, opens it, and then unpins the old session (if pinned). It never archives or deletes.
- The agent half is installed but disabled on the server; this Desktop half must be installed separately on the computer that runs Hermes Desktop when connected to a remote gateway.
- No live end-to-end migration has been tested. Event delivery is fire-and-forget and the explicit approval gate is currently an agent instruction, not a cryptographically bound confirmation. Multiple windows and remote Desktop connectivity require live testing. **Do not enable for unrelated sessions.**
- The 35/40/45% context alerts are **not implemented** by this plugin. `prototype.py` contains only read-only inventory and pure threshold decisions.

## Tests

From the development directory `/home/hermes/platform/session-handoff-prototype` on the server:

```sh
node --test test_live.mjs
python -m unittest -q test_agent_bridge test_prototype
hermes plugins doctor /home/hermes/platform/session-handoff
```

This repository contains only the installable plugin, not the development tests or the inventory of private sessions.

## Privacy / scope

The repository must remain private while the prototype is tested. Do not add session transcripts, tokens, `state.db`, user-specific session identifiers, or gateway secrets. The plugin does not contact GitHub itself.

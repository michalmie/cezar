# Muse MSP fixtures

`echo-live.ndjson` contains owner-stream frames captured on 2026-10-27 from
Muse Code 1.4.13 with `muse serve --provider echo --no-session-log` in a temporary
workspace. Irrelevant reminders and protocol replies are omitted. No paid model
turn or credentials appear. Item snapshots, usage ordering and terminal framing
are live evidence.

`schema-capabilities.ndjson` is explicitly schema-derived, not a live paid-model
capture. It uses `muse schema generate-ts` from that same binary (stable MSP v1:
Item, ItemKind, SessionTodoListChangedParams, SessionTokenUsageParams and
TurnCompletedParams). The patch is the agent's apply_patch input format.
Official protocol and SDK: https://meta-models.github.io/muse-code-sdk/ .
It verifies plan, reasoning, tool failure, patch and subagent rendering separately
from the live echo transcript. MSP's Item has no parent-item field; subagent
items are shown as task-kind tools without fabricated parent attribution.

The mapper tests replay both inputs against the checked-in expected events;
ui-parity.test.ts checks the same expected events for every supported capability.

`session/setModel` takes `{ commandId, sessionId, model: { modelId } }` per the
exported stable schema (`muse schema generate-json-schema`); a bare `modelId`
param is rejected as invalid params by the real host and the mock alike.

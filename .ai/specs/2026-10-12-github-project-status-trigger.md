GitHub Project Status trigger

Extends the GitHub automation poller with `project.item.status_changed` and
`projectTrigger: { url, targetStatus }`. The event is selected alone. Personal and
organization Project URLs are accepted; the configured repository remains the
project's GitHub remote. The native editor exposes both settings. No webhook,
external scheduler, extra environment variable or model is needed for polling.

The first complete observation establishes a board snapshot and skips existing
Ready cards, consistent with the existing baseline contract. Later observed
entries into the exact named Status option, including newly added matching cards,
create pending events. Only open, unarchived issues from the remote repository
qualify. Existing author/assignee/label filters apply to the current issue. All
field and item pages must validate before a checkpoint; repeated/missing cursors,
GraphQL errors, missing Status options, changed field/option identities or the
100-page ceiling fail closed. The status identity is pinned until re-enabling.

Snapshots and pending events are persisted through the shared event poll cycle's
checkpoint hook before any launch receipt is reserved. The board generation and
monotonic transition sequence give pending events stable identities after a
restart. Receipt reservation, durable run provenance, reconciliation, backoff and
manual retry reuse the existing machinery. At most one event launches per check;
the server defers further launches while this automation has queued/running/
waiting work. Deferred events remain pending, and cards that leave the target
status or stop matching are discarded. Preview never checkpoints or launches.
Source edits, re-enable and an idle rebaseline clear the board snapshot.

Polling observes states rather than reconstructing every historical transition:
changes that occur entirely between observations may be missed. Losing runtime
state safely establishes a new snapshot instead of launching historical Ready
cards. A baseline is established by the first full check, which is due immediately
after enabling. Cadence remains configurable, with five minutes as the default.

Validation covers full pagination, baseline/entry/re-entry, queued identity,
repository/type/state/archive/label eligibility, malformed URLs, partial responses,
pre-launch checkpoints, busy deferral, read-only preview, receipt recovery and the
editor's exclusive event selection. Existing schedule and GitHub event behavior
is unchanged.

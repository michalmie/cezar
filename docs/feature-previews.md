# Feature previews in Vibe Factory

Completed Ready tasks in a Vibe Factory project offer **Build preview** beside
the task's git action. The button POSTs the exact task, issue and commit to the
connected Factory in a new window. Factory validates the existing result gate,
builds an isolated Preview environment and opens the application when healthy.
Repeated handoffs reuse the same active version. A different active feature must
be stopped or cancelled before another can build.

Open the project's Environments page in Factory once to publish its managed
discovery record (`config/feature-preview-bridge.json`). Discovery requires the
Factory workspace layout, a committed preview adapter and a completed result
In review; ordinary Cezar projects keep their existing header.

**Cancel preview** in Factory removes disposable preview data and services.
**Review / merge in Cezar** returns to the task. Building or cancelling a preview
does not accept a task, create or merge a PR, close an issue, or deploy Local.

`GET /api/v1/p/:projectId/runs/:id/feature-preview` only discovers the handoff;
it never starts a build. Its request and response are defined in the contract.
The POST form uses `rel="noopener"`; `noreferrer` would replace its browser Origin
with `null`, preventing Factory from verifying the connected Cezar origin.

# Feature previews in Vibe Factory

Finished tasks in a Vibe Factory project offer **Build preview** beside
the task's git action. The button POSTs the exact task version to the
connected Factory in a new window: Ready results hand off task, issue and
commit; tasks without a Ready claim hand off task, branch and commit instead.
Factory validates the selection, builds an isolated Preview environment and
opens the application when healthy.
Repeated handoffs reuse the same active version. A different active feature is
automatically stopped before the selected version builds; its data is retained
until Cancel.

The second action is **Merge PR into main**. Preview is optional; GitHub checks
and review requirements still apply. The merge screen shows the selected commit,
PR and requirements. **Reviews: not required** is valid when GitHub confirms
there is no review requirement; unreadable requirements block merging until the
operator explicitly confirms **Merge without waiting for requirements**. GitHub
remains authoritative and may still refuse. A branch that fell behind its target
stays blocked while protection demands an up-to-date branch; update it on
GitHub, then Refresh. A merged PR shows a confirmation
with the merge commit instead of the requirements. A conflicting PR offers
**Resolve conflicts in PR #N** instead of merge controls, asking the task's
agent to resolve and push; when the PR moves to a new version, **Review
updated version** adopts it after review.
If no PR exists, **Create PR for main** publishes only the
selected clean commit, then lets the operator review and merge. It never silently
autosaves or publishes another version, changes a PR's target, or bypasses rules.
The server rechecks the expected head and target before merging.
If the worktree was removed, the saved task branch can publish the pinned commit
from the repository without autosaving or changing the local checkout.

Completed supported Ready results include **Build preview** and **Merge PR into
main** links in their existing GitHub issue summary. Opening either link only
opens its Cezar action screen; a further explicit button submits the build,
creates a PR or merges. Links pin the result's issue/commit. Older result links
show a message rather than silently selecting a newer version. Existing result
links can be added with `node scripts/cezar-result-actions.mjs sync PROJECT`
from the Factory root; edited summaries and existing preview blocks are preserved.

Open the project's Environments page in Factory once to publish its managed
discovery record (`config/feature-preview-bridge.json`). Discovery requires the
Factory workspace layout, a committed preview adapter and a finished task;
ordinary Cezar projects keep their existing header.

**Cancel preview** in Factory removes disposable preview data and services.
**Review / merge in Cezar** returns to the task. Building or cancelling a preview
does not accept a task, create or merge a PR, close an issue, or deploy Local.

`GET /api/v1/p/:projectId/runs/:id/feature-preview` only discovers the handoff;
it never starts a build. Its request and response are defined in the contract.
The POST form uses `rel="noopener"`; `noreferrer` would replace its browser Origin
with `null`, preventing Factory from verifying the connected Cezar origin.

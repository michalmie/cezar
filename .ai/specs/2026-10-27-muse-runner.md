# Muse Code runner

Add Meta Muse Code as an additive `muse` backend in the custom Cezar fork.
Use one persistent `muse serve` stdio host per run; no SDK/runtime dependency.
The existing JSON-RPC transport carries MSP methods rather than ACP methods.

Verified against installed Muse Code 1.4.13 (1.4.13-R6996.1), its offline
`muse schema generate-ts` export (MSP schema v1), and live echo-provider traffic.
Official entry points: https://dev.meta.ai/docs/muse-code and
https://meta-models.github.io/muse-code-sdk/ . Command ids must be UUIDv7.
The stdio connection automatically receives the owner's live view events;
`view/subscribe` is not implemented on this build and is not required.

Start with `session/start`, continue with `turn/start` (`ifBusy: queue`), and
restore with `session/resume` without replaying old items. Forward system
instructions in the first user block, images as `base64Data`/`mediaType`, and
additional directories as `workspaceRoots`. Persist the actual native session
id and hand it off with `muse resume <id>`.

Preserve Muse's native sandbox. Select `allowAll` approvals for unattended
turns, reapply on resume, and answer an unexpected approval using its offered
once-only approved choice; unsupported requests fail explicitly. Disable the
native question tool and cancel any unexpected question. Timeout, cancellation
and graceful EOF all have bounded process shutdown with SIGKILL escalation.

Normalize message/reasoning/tool lifecycles, plans, token usage and terminal
states into both Cezar event streams. `session/tokenUsage` carries directional
usage even when `turn/completed` omits it. Unknown/malformed frames are ignored.
Golden fixtures distinguish live echo output from schema-derived capability
frames. Never infer success from the foreground-completed notification.

Discover models through `model/list`, without a session or a billable turn.
Probe login through `muse usage --json`; inconclusive responses remain unknown.
Forward only Muse/Meta credential families in addition to Cezar's shared env.
`CEZ_MUSE_BIN` is optional; dry-run uses the bundled offline MSP mock.
No extra account profiles, native config editor or private project MCP support
is advertised yet; the existing unsupported-MCP note names omitted servers.

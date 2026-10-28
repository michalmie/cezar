import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleCheckIcon, CircleIcon, CircleXIcon, LoaderCircleIcon } from 'lucide-react'
import { useState } from 'react'
import type { ApiRun, GithubMergeMethod } from '@open-mercato/cezar-api-client'
import { createRunPr, getGithubPrMergeState, getProjects, mergeGithubPr, publishRunBranch, updateGithubPrBranch } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys, workspaceQueryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from '@/components/ui/toaster'
import { ownedTaskPr } from '@/lib/tasks-table'
import { cn } from '@/lib/utils'
import { useAskAnswer } from './ask-answer'
import { resolveConflictsPrompt } from './run-actions'

type RequirementState = 'passing' | 'failing' | 'pending' | 'unknown'

// Same icon vocabulary as the GitHub tab merge box.
function RequirementIcon({ state }: { state: RequirementState }) {
  const iconClass = 'size-4 shrink-0'
  if (state === 'passing') return <CircleCheckIcon aria-hidden="true" className={cn(iconClass, 'text-success')} />
  if (state === 'failing') return <CircleXIcon aria-hidden="true" className={cn(iconClass, 'text-danger')} />
  if (state === 'pending') return <LoaderCircleIcon aria-hidden="true" className={cn(iconClass, 'animate-spin text-warning')} />
  return <CircleIcon aria-hidden="true" className={cn(iconClass, 'text-soft-foreground')} />
}

function methodLabel(value: GithubMergeMethod) {
  return value === 'squash' ? 'Squash and merge' : value === 'rebase' ? 'Rebase and merge' : 'Create a merge commit'
}

// The completion nudge: a merge-commit link so the landed result can be verified on main.
// Derived from the PR URL's shape (`/pull/N` → `/commit/<sha>`); null unless both halves are
// known and the URL has the expected shape — the panel simply shows no link then.
function mergeCommitUrl(prUrl: string | undefined, sha: string | undefined) {
  if (!prUrl || !sha) return null
  try {
    const url = new URL(prUrl)
    if (!/\/pull\/\d+\/?$/.test(url.pathname)) return null
    url.pathname = url.pathname.replace(/\/pull\/\d+\/?$/, `/commit/${sha}`)
    return url.toString()
  } catch { return null }
}

export function FeatureMergeDialog({ run, commit, open, onOpenChange, onAdoptCommit }: {
  run: ApiRun; commit: string; open: boolean; onOpenChange: (open: boolean) => void; onAdoptCommit: (commit: string) => void
}) {
  const { projectId } = useProjectScope()
  const client = useQueryClient()
  const [createdNumber, setCreatedNumber] = useState<number | null>(null)
  const [publishOpen, setPublishOpen] = useState(false)
  const [publishProjectId, setPublishProjectId] = useState('')
  const [publishBranchName, setPublishBranchName] = useState(run.branch ?? '')
  const projects = useQuery({ queryKey: workspaceQueryKeys.projects, queryFn: () => getProjects(), enabled: open && publishOpen, retry: false })
  const targets = (projects.data?.projects ?? []).filter(entry => entry.id !== projectId && entry.status === 'ok' && entry.forge === 'github')
  const targetId = publishProjectId || targets[0]?.id || ''
  const target = targets.find(entry => entry.id === targetId)
  const publish = useMutation({
    mutationFn: () => {
      if (!target || !publishBranchName.trim()) throw new Error('Choose a project and a branch to publish.')
      return publishRunBranch(run.id, { projectId: target.id, branch: publishBranchName.trim() })
    },
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.runs.all }) },
  })
  // A published PR lives in ANOTHER project's repo, while merge-state here is scoped to this
  // run's project — so the published panel owns the dialog until close and never hands off to
  // the merge flow, even if the run prop refreshes with the new pullRequestUrl mid-dialog.
  const publishedPr = publish.isSuccess ? publish.data ?? null : null
  const number = publishedPr ? undefined : createdNumber ?? ownedTaskPr(run)?.number
  const [method, setMethod] = useState<GithubMergeMethod | null>(null)
  const [overrideRules, setOverrideRules] = useState(false)
  const status = useQuery({
    queryKey: [projectId, 'feature-merge', run.id, number, commit],
    queryFn: () => getGithubPrMergeState(number!, { refresh: true }),
    enabled: open && number !== undefined && number !== null,
    retry: false,
  })
  const state = status.data?.available ? status.data.mergeState : null
  const selected = method && state?.methods.includes(method) ? method : state?.defaultMethod ?? state?.methods[0]
  const wrongVersion = state && state.headSha !== commit
  const wrongBase = state && state.baseRef !== 'main'
  const mismatched = Boolean(wrongVersion || wrongBase)
  const mergeAllowed = Boolean(state && selected && !mismatched && (state.canMerge || (state.canOverride && overrideRules)))
  const create = useMutation({
    mutationFn: () => createRunPr(run.id, { draft: false, baseBranch: 'main', expectedHeadSha: commit }),
    onSuccess: result => {
      const value = Number(new URL(result.url).pathname.match(/\/pull\/(\d+)$/)?.[1])
      if (Number.isSafeInteger(value) && value > 0) setCreatedNumber(value)
      void client.invalidateQueries({ queryKey: queryKeys.runs.all })
    },
  })
  const merge = useMutation({
    mutationFn: () => {
      if (!number || !state || !selected || wrongVersion || wrongBase || !(state.canMerge || (state.canOverride && overrideRules))) throw new Error('This selected version is not ready to merge into main.')
      return mergeGithubPr(number, { method: selected, expectedHeadSha: commit, expectedBaseRef: 'main', overrideRules: overrideRules && state.canOverride, runId: run.id })
    },
    onSuccess: () => { void status.refetch(); void client.invalidateQueries({ queryKey: queryKeys.runs.all }) },
    onError: () => { void status.refetch() },
  })
  const update = useMutation({
    mutationFn: () => {
      if (!number || !state || mismatched || !state.blockers.some(blocker => blocker.code === 'behind')) throw new Error('This pull request is not waiting for a branch update.')
      return updateGithubPrBranch(number, { expectedHeadSha: commit })
    },
    onSuccess: () => { void status.refetch(); void client.invalidateQueries({ queryKey: queryKeys.runs.all }) },
    onError: () => { void status.refetch() },
  })
  const agent = useAskAnswer(run, undefined, 'git_step')
  const [resolving, setResolving] = useState(false)
  const busy = create.isPending || merge.isPending || resolving || update.isPending || publish.isPending
  // Server truth first; the fresh mutation covers the refetch gap. Reset on close so a reopen never replays a stale success.
  const showSuccess = Boolean(!mismatched && (merge.isSuccess || state?.state === 'merged'))
  const openPr = state?.state === 'open'
  const conflicting = Boolean(openPr && state?.mergeable === 'conflicting')
  const behindBlocker = state?.blockers.find(blocker => blocker.code === 'behind')
  const behindBox = Boolean(openPr && !mismatched && behindBlocker)
  const showMergeAction = !state || (openPr && !mismatched && !conflicting)
  const publishedProjectName = publishedPr ? targets.find(entry => entry.id === publishedPr.projectId)?.name ?? publishedPr.projectId : ''
  const title = publishedPr ? `Published to ${publishedProjectName}` : showSuccess ? 'Merged into main' : state?.state === 'closed' ? 'Pull request closed' : state?.state === 'merged' ? 'Already merged' : 'Merge PR into main'
  const description = publishedPr
    ? `Version ${publishedPr.sha.slice(0, 8)} is proposed to main in ${publishedProjectName}.`
    : showSuccess
    ? `Version ${commit.slice(0, 8)} of this task is now on main.`
    : state?.state === 'closed'
      ? 'This pull request was closed without merging.'
      : state?.state === 'merged'
        ? 'This pull request is merged, but not at this task\u2019s selected version.'
        : 'Preview is optional. GitHub checks and review requirements still apply. Merge this task\u2019s selected version after reviewing its changes.'
  const close = () => { merge.reset(); update.reset(); publish.reset(); onOpenChange(false) }
  const resolve = async () => {
    if (!number || agent.isPending || resolving) return
    setResolving(true)
    const failure = await agent.send(resolveConflictsPrompt(number))
    setResolving(false)
    // One-shot caller: the panel closes, so the answer toasts where it acted.
    if (failure) toast(failure, { tone: 'danger' })
    else { toast(`Resolving conflicts in PR #${number} — reopen Merge when the agent pushes.`); close() }
  }
  const reviewState: RequirementState = !state || state.reviewDecision === 'unknown' ? 'unknown' : state.reviewDecision === 'approved' || state.reviewDecision === 'not-required' ? 'passing' : 'failing'
  const conflictState: RequirementState = !state || state.mergeable === 'unknown' ? 'unknown' : state.mergeable === 'mergeable' ? 'passing' : 'failing'
  const prNumber = state?.number ?? merge.data?.number ?? number
  const prUrl = state?.url ?? merge.data?.url
  const commitLink = mergeCommitUrl(prUrl, merge.data?.mergeCommitSha)
  return <Dialog open={open} onOpenChange={value => { if (!busy) { if (!value) { merge.reset(); update.reset(); publish.reset() } onOpenChange(value) } }}>
    <DialogContent className="max-h-[85svh] overflow-y-auto">
      <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
      <p className="break-all font-mono text-xs">Commit {commit}</p>
      {!number && !publishedPr ? <p className="text-sm">This task has no pull request yet. Create a PR for main, then review its merge requirements here.</p> : null}
      {!number && !publishedPr && !publishOpen ? <div><Button size="sm" variant="outline" onClick={() => setPublishOpen(true)}>Publish to another project…</Button></div> : null}
      {!number && !publishedPr && publishOpen ? <div className="grid gap-2 rounded-md border border-border bg-card p-3 text-xs">
        <label className="grid gap-1">Project<select aria-label="Target project" className="rounded border border-border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={targetId} onChange={e => setPublishProjectId(e.target.value)}>{targets.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select></label>
        <label className="grid gap-1">Branch<input aria-label="Branch" className="rounded border border-border bg-background p-2 font-mono outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={publishBranchName} onChange={e => setPublishBranchName(e.target.value)} placeholder="cez/task-branch" /></label>
        {projects.isPending ? <p role="status">Loading projects…</p> : null}
        {projects.data && targets.length === 0 ? <p>No other GitHub project is registered.</p> : null}
        <p className="text-soft-foreground">Sync this task&apos;s branch into that project&apos;s checkout first — publishing pins its current version and opens a PR for main.</p>
        <div><Button size="sm" disabled={busy || !target || !publishBranchName.trim()} onClick={() => publish.mutate()}>{publish.isPending ? 'Publishing…' : 'Publish branch'}</Button></div>
      </div> : null}
      {number && status.isPending ? <p role="status">Loading PR merge requirements…</p> : null}
      {number && status.data?.available === false ? <p role="alert">{status.data.reason}</p> : null}
      {status.error ? <p role="alert">{status.error.message}</p> : null}
      {showSuccess ? <div role="status" className="flex items-start gap-4 rounded-lg border border-success/50 bg-success/10 p-5">
        <CircleCheckIcon aria-hidden="true" className="size-10 shrink-0 text-success" />
        <div className="grid min-w-0 gap-1 text-sm">
          <p className="text-lg font-semibold">PR #{prNumber} merged into main.</p>
          {state ? <p className="text-soft-foreground">{state.headRef} → {state.baseRef}</p> : null}
          <p className="break-all font-mono text-xs" title={commit}>Version {commit.slice(0, 8)}{merge.data?.mergeCommitSha ? ` · Merge commit ${merge.data.mergeCommitSha.slice(0, 8)}` : ''}</p>
          {prUrl ? <a href={prUrl} target="_blank" rel="noopener noreferrer" className="underline">View PR #{prNumber} ↗</a> : null}
          {commitLink ? <a href={commitLink} target="_blank" rel="noopener noreferrer" className="underline">Verify merge commit {merge.data?.mergeCommitSha?.slice(0, 8)} on main ↗</a> : null}
        </div>
      </div> : null}
      {!showSuccess && state ? <div className="grid gap-3 text-sm">
        <a href={state.url} target="_blank" rel="noopener noreferrer" className="underline">Review PR #{state.number} ↗</a>
        <p>{state.headRef} → {state.baseRef} · {state.state}{state.isDraft ? ' · draft' : ''}</p>
        {wrongVersion ? <p role="alert" className="text-danger">The PR commit differs from this task version. Review the updated task before merging.</p> : null}
        {wrongBase ? <p role="alert" className="text-danger">This PR targets {state.baseRef}. It must target main before using this action.</p> : null}
        {openPr && wrongVersion && !wrongBase ? <div className="grid gap-2 rounded-md border border-border bg-card p-3 text-xs">
          <p><span className="font-medium">This PR has moved to a new version.</span> <span className="text-soft-foreground">Review its updated changes above, then merge {state.headSha.slice(0, 8)} instead of {commit.slice(0, 8)}.</span></p>
          <div><Button size="sm" variant="outline" onClick={() => onAdoptCommit(state.headSha)}>Review updated version</Button></div>
        </div> : null}
        {conflicting ? <div className="grid gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
          <p className="font-medium">Conflicts with main must be resolved first.</p>
          {agent.blockedBy
            ? <p className="text-soft-foreground">{agent.reason ?? 'The agent cannot be reached.'} Resolve them on GitHub, then Refresh.</p>
            : <><p className="text-soft-foreground">The task&apos;s agent can resolve them and push. Reopen this dialog after it finishes.</p>
              <div><Button size="sm" disabled={resolving || agent.isPending} onClick={() => { void resolve() }}>{resolving || agent.isPending ? 'Sending…' : `Resolve conflicts in PR #${number}`}</Button></div></>}
        </div> : null}
        {behindBox ? <div className="grid gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs">
          <p className="font-medium">{behindBlocker?.message ?? 'This branch is behind.'}</p>
          <p className="text-soft-foreground">Updating merges {state.baseRef} into {state.headRef} and re-runs the checks. Merge unlocks when they pass.</p>
          <div><Button size="sm" disabled={busy} onClick={() => update.mutate()}>{update.isPending ? 'Updating…' : 'Update branch'}</Button></div>
        </div> : null}
        {openPr && !mismatched ? <ul className="grid gap-2 text-sm">
          <li className="flex items-center gap-2"><RequirementIcon state={reviewState} /><span>Reviews: {state.reviewDecision.replaceAll('-', ' ')}</span></li>
          <li className="flex items-center gap-2"><RequirementIcon state={state.mergeable === 'unknown' ? 'pending' : conflictState} /><span>Conflicts: {state.mergeable === 'conflicting' ? 'present' : state.mergeable === 'mergeable' ? 'none' : 'waiting for an update from GitHub…'}</span></li>
          {state.checks.length === 0 && state.checksTier !== 'none' ? <li>No checks configured</li> : state.checks.map(check => <li key={check.name} className="flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2"><RequirementIcon state={check.state} /><span>{check.name} · {check.state}{check.required === true ? ' · required' : check.required === null ? ' · requiredness unknown' : ''}</span></span>{check.url ? <a href={check.url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-muted-foreground underline">details</a> : null}</li>)}
          {state.checksTier !== 'detailed' ? <li className="flex items-start gap-2"><RequirementIcon state="unknown" /><span>{state.checksTier === 'aggregate' ? 'Only the rolled-up check state is readable here — per-check detail is not.' : 'This token cannot read the checks on this pull request.'}{state.checksReason ? ` ${state.checksReason}` : ''}</span></li> : null}
        </ul> : null}
        {state.blockers.filter(blocker => blocker.code !== 'behind' || !behindBox).map(blocker => <p key={blocker.code}>{blocker.message}</p>)}
        {openPr && state.canOverride && !mismatched ? <label className="flex cursor-pointer items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs"><input type="checkbox" checked={overrideRules} onChange={e => setOverrideRules(e.target.checked)} className="mt-0.5 size-4 accent-primary" /><span><span className="block font-medium">Merge without waiting for requirements</span><span className="mt-0.5 block text-soft-foreground">GitHub will allow this only if your permissions can bypass the repository rules.</span></span></label> : null}
        {openPr && !mismatched && !conflicting && state.methods.length ? <label className="grid gap-1">Merge method<select aria-label="Merge method" className="rounded border border-border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={selected ?? ''} onChange={e => setMethod(e.target.value as GithubMergeMethod)}>{state.methods.map(value => <option key={value} value={value}>{methodLabel(value)}</option>)}</select></label> : null}
      </div> : null}
      {publishedPr ? <div role="status" className="flex items-start gap-4 rounded-lg border border-success/50 bg-success/10 p-5">
        <CircleCheckIcon aria-hidden="true" className="size-10 shrink-0 text-success" />
        <div className="grid min-w-0 gap-1 text-sm">
          <p className="text-lg font-semibold">PR opened in {publishedProjectName}.</p>
          <p className="text-soft-foreground">{publishedPr.branch} → main</p>
          <p className="break-all font-mono text-xs" title={publishedPr.sha}>Version {publishedPr.sha.slice(0, 8)}</p>
          <a href={publishedPr.url} target="_blank" rel="noopener noreferrer" className="underline">View PR ↗</a>
          <p className="text-soft-foreground">Review and merge happen in that project&apos;s repo — this dialog only follows PRs opened here.</p>
        </div>
      </div> : null}
      {create.error || merge.error || update.error || publish.error ? <p role="alert" className="text-danger">{create.error?.message ?? merge.error?.message ?? update.error?.message ?? publish.error?.message}</p> : null}
      <DialogFooter>
        {showSuccess || publishedPr ? <Button onClick={close}>Done</Button> : <>
          <Button variant="outline" disabled={busy} onClick={close}>Close</Button>
          {!number ? <Button disabled={busy} onClick={() => create.mutate()}>{create.isPending ? 'Creating PR…' : 'Create PR for main'}</Button> : <>
            <Button variant="outline" disabled={busy || status.isFetching} onClick={() => { void status.refetch() }}>Refresh</Button>
            {showMergeAction ? <Button disabled={busy || !mergeAllowed} onClick={() => merge.mutate()}>{merge.isPending ? 'Merging…' : 'Merge PR into main'}</Button> : null}
          </>}
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ApiRun, GithubMergeMethod } from '@open-mercato/cezar-api-client'
import { createRunPr, getGithubPrMergeState, mergeGithubPr } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { queryKeys } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ownedTaskPr } from '@/lib/tasks-table'

export function FeatureMergeDialog({ run, commit, open, onOpenChange }: {
  run: ApiRun; commit: string; open: boolean; onOpenChange: (open: boolean) => void
}) {
  const { projectId } = useProjectScope()
  const client = useQueryClient()
  const [createdNumber, setCreatedNumber] = useState<number | null>(null)
  const number = createdNumber ?? ownedTaskPr(run)?.number
  const [method, setMethod] = useState<GithubMergeMethod | null>(null)
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
      if (!number || !state || !selected || wrongVersion || wrongBase || !state.canMerge) throw new Error('This selected version is not ready to merge into main.')
      return mergeGithubPr(number, { method: selected, expectedHeadSha: commit, expectedBaseRef: 'main', overrideRules: false })
    },
    onSuccess: () => { void status.refetch(); void client.invalidateQueries({ queryKey: queryKeys.runs.all }) },
    onError: () => { void status.refetch() },
  })
  const busy = create.isPending || merge.isPending
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value) }}>
    <DialogContent className="max-h-[85svh] overflow-y-auto">
      <DialogHeader><DialogTitle>Merge PR into main</DialogTitle><DialogDescription>Preview is optional. GitHub checks and review requirements still apply. Merge this task&apos;s selected version after reviewing its changes.</DialogDescription></DialogHeader>
      <p className="break-all font-mono text-xs">Commit {commit}</p>
      {!number ? <p className="text-sm">This task has no pull request yet. Create a PR for main, then review its merge requirements here.</p> : null}
      {number && status.isPending ? <p role="status">Loading PR merge requirements…</p> : null}
      {number && status.data?.available === false ? <p role="alert">{status.data.reason}</p> : null}
      {status.error ? <p role="alert">{status.error.message}</p> : null}
      {state ? <div className="grid gap-3 text-sm">
        <a href={state.url} target="_blank" rel="noopener noreferrer" className="underline">Review PR #{state.number} ↗</a>
        <p>{state.headRef} → {state.baseRef} · {state.state}{state.isDraft ? ' · draft' : ''}</p>
        {wrongVersion ? <p role="alert" className="text-danger">The PR commit differs from this task version. Review the updated task before merging.</p> : null}
        {wrongBase ? <p role="alert" className="text-danger">This PR targets {state.baseRef}. It must target main before using this action.</p> : null}
        <p>Reviews: {state.reviewDecision.replaceAll('-', ' ')} · Conflicts: {state.mergeable}</p>
        {state.checks.map(check => <p key={check.name}>{check.name}: {check.state}{check.required ? ' (required)' : ''}</p>)}
        {state.checksReason ? <p>{state.checksReason}</p> : null}
        {state.blockers.map(blocker => <p key={blocker.code}>{blocker.message}</p>)}
        {state.methods.length ? <label className="grid gap-1">Merge method<select aria-label="Merge method" className="rounded border border-border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={selected ?? ''} onChange={e => setMethod(e.target.value as GithubMergeMethod)}>{state.methods.map(value => <option key={value} value={value}>{value === 'squash' ? 'Squash and merge' : value === 'rebase' ? 'Rebase and merge' : 'Create a merge commit'}</option>)}</select></label> : null}
      </div> : null}
      {create.error || merge.error ? <p role="alert" className="text-danger">{create.error?.message ?? merge.error?.message}</p> : null}
      {merge.isSuccess ? <p role="status">PR merged into main.</p> : null}
      <DialogFooter>
        <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Close</Button>
        {!number ? <Button disabled={busy} onClick={() => create.mutate()}>{create.isPending ? 'Creating PR…' : 'Create PR for main'}</Button> : <>
          <Button variant="outline" disabled={busy || status.isFetching} onClick={() => { void status.refetch() }}>Refresh</Button>
          <Button disabled={busy || merge.isSuccess || !state?.canMerge || !selected || !!wrongVersion || !!wrongBase} onClick={() => merge.mutate()}>{merge.isPending ? 'Merging…' : 'Merge PR into main'}</Button>
        </>}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

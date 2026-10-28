import { useQuery } from '@tanstack/react-query'
import { ExternalLinkIcon, GitMergeIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router'
import type { ApiRun, FeaturePreviewResponse } from '@open-mercato/cezar-api-client'
import { featurePreviewResponseSchema } from '@open-mercato/cezar-api-client'
import { getFeaturePreview } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FeatureMergeDialog } from './feature-merge-dialog'

export function FeaturePreviewButton({ run }: { run: ApiRun }) {
  const { projectId } = useProjectScope()
  const location = useLocation()
  const [mergeOpen, setMergeOpen] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [mergeCommit, setMergeCommit] = useState<string | null>(null)
  const [previewSelection, setPreviewSelection] = useState<Extract<FeaturePreviewResponse, { available: true }> | null>(null)
  const [linkError, setLinkError] = useState('')
  const handled = useRef('')
  const preview = useQuery({
    queryKey: [projectId, 'feature-preview', run.id, run.status, run.finishedAt],
    queryFn: async () => featurePreviewResponseSchema.parse(await getFeaturePreview(run.id)),
    enabled: run.status === 'done',
    refetchInterval: run.status === 'done' ? 30_000 : false,
    retry: false,
  })
  const data = preview.data
  useEffect(() => {
    const query = new URLSearchParams(location.search)
    const action = query.get('featureAction')
    const key = `${run.id}:${location.search}`
    if (!['preview', 'merge'].includes(action || '') || !data || handled.current === key) return
    handled.current = key
    if (!data.available) { setLinkError(data.reason); return }
    if (query.get('commit') !== data.commit || (data.mode === 'claim' && Number(query.get('number')) !== data.number)) {
      setLinkError('This result link points to an older task version. Review the current task version before choosing an action.'); return
    }
    if (action === 'preview') { setPreviewSelection(data); setPreviewOpen(true) }
    if (action === 'merge') { setMergeCommit(data.commit); setMergeOpen(true) }
  }, [location.search, run.id, data])
  if (!data?.available || run.status !== 'done') return linkError ? <p role="alert" className="my-2 text-xs text-danger">{linkError}</p> : null
  const url = new URL(data.factoryUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  const form = (selection: Extract<FeaturePreviewResponse, { available: true }> = data) => <form method="post" action={selection.factoryUrl} target="_blank" rel="noopener">
    <input type="hidden" name="taskId" value={selection.taskId} />
    <input type="hidden" name="commit" value={selection.commit} />
    {selection.mode === 'manual' ? <>
      <input type="hidden" name="manual" value="true" />
      <input type="hidden" name="branch" value={selection.branch ?? ''} />
      <input type="hidden" name="title" value={selection.title ?? ''} />
      <input type="hidden" name="cezarProjectId" value={projectId ?? ''} />
    </> : <input type="hidden" name="number" value={selection.number} />}
    <Button type="submit" variant="outline" size="sm" title="Build this task version in Factory and open it when healthy">
      <ExternalLinkIcon aria-hidden="true" />Build preview
    </Button>
  </form>
  return <div className="my-2 flex flex-wrap items-center gap-2" aria-label="Feature actions">
    {form()}
    <Button variant="outline" size="sm" title="Preview optional; GitHub checks and review requirements still apply" onClick={() => { setMergeCommit(data.commit); setMergeOpen(true) }}><GitMergeIcon aria-hidden="true" />Merge PR into main</Button>
    {linkError ? <p role="alert" className="w-full text-xs text-danger">{linkError}</p> : null}
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}><DialogContent><DialogHeader><DialogTitle>Build preview</DialogTitle><DialogDescription>{previewSelection?.mode === 'manual' ? <>Build branch {previewSelection.branch}, version {previewSelection?.commit.slice(0, 8)} in Factory.</> : <>Build issue #{previewSelection?.number}, version {previewSelection?.commit.slice(0, 8)} in Factory.</>} Any previous preview will stop first. The preview opens in a new window when ready.</DialogDescription></DialogHeader>{form(previewSelection ?? data)}</DialogContent></Dialog>
    <FeatureMergeDialog key={`${run.id}:${mergeCommit ?? data.commit}`} run={run} commit={mergeCommit ?? data.commit} open={mergeOpen} onOpenChange={setMergeOpen} onAdoptCommit={setMergeCommit} />
  </div>
}

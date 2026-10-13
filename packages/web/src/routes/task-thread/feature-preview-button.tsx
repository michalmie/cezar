import { useQuery } from '@tanstack/react-query'
import { ExternalLinkIcon } from 'lucide-react'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { featurePreviewResponseSchema } from '@open-mercato/cezar-api-client'
import { getFeaturePreview } from '@/api/client'
import { useProjectScope } from '@/api/project-scope-context'
import { Button } from '@/components/ui/button'

export function FeaturePreviewButton({ run }: { run: ApiRun }) {
  const { projectId } = useProjectScope()
  const preview = useQuery({
    queryKey: [projectId, 'feature-preview', run.id, run.status, run.finishedAt],
    queryFn: async () => featurePreviewResponseSchema.parse(await getFeaturePreview(run.id)),
    enabled: run.status === 'done',
    refetchInterval: run.status === 'done' ? 30_000 : false,
    retry: false,
  })
  const data = preview.data
  if (!data?.available || run.status !== 'done') return null
  const url = new URL(data.factoryUrl)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
  return <form method="post" action={data.factoryUrl} target="_blank" rel="noopener">
    <input type="hidden" name="taskId" value={data.taskId} />
    <input type="hidden" name="commit" value={data.commit} />
    <input type="hidden" name="number" value={data.number} />
    <Button type="submit" variant="outline" size="sm" title="Build this task version in Factory and open it when healthy">
      <ExternalLinkIcon aria-hidden="true" />Build preview
    </Button>
  </form>
}

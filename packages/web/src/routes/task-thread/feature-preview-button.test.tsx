import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { getFeaturePreview } from '@/api/client'
import { FeaturePreviewButton } from './feature-preview-button'

vi.mock('@/api/client', () => ({ getFeaturePreview: vi.fn() }))
const taskId = 'a1234567-1234-4123-8123-123456789abc'
const run: ApiRun = { id: taskId, title: 'Feature', workflow: 'quick-task', task: 'Feature', status: 'done', createdAt: '', tokensUsed: 0, steps: [], archived: false }
afterEach(() => { cleanup(); vi.clearAllMocks() })
function show(task = run) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><FeaturePreviewButton run={task} /></QueryClientProvider>)
}
it('opens a Factory POST handoff in a new window with the exact version', async () => {
  vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit: 'a'.repeat(40) })
  show()
  const form = (await screen.findByRole('button', { name: 'Build preview' })).closest('form')!
  expect(form.method).toBe('post'); expect(form.target).toBe('_blank'); expect(form.getAttribute('rel')).toBe('noopener')
  expect(form.action).toBe('http://factory.example:3000/api/projects/demo/feature-preview')
  expect(Object.fromEntries(new FormData(form))).toEqual({ taskId, number: '9', commit: 'a'.repeat(40) })
})
it('does not offer a build for active or unsupported tasks', async () => {
  show({ ...run, status: 'running' })
  expect(getFeaturePreview).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Build preview' })).toBeNull()
  cleanup()
  vi.mocked(getFeaturePreview).mockResolvedValue({ available: false, reason: 'No adapter' })
  show()
  await vi.waitFor(() => expect(getFeaturePreview).toHaveBeenCalledOnce())
  expect(screen.queryByRole('button', { name: 'Build preview' })).toBeNull()
})

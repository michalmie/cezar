import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, fireEvent, within, act } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { getFeaturePreview, createRunPr, getGithubPrMergeState, mergeGithubPr } from '@/api/client'
import { FeaturePreviewButton } from './feature-preview-button'
import { MemoryRouter } from 'react-router'

vi.mock('@/api/client', () => ({ getFeaturePreview: vi.fn(), createRunPr: vi.fn(), getGithubPrMergeState: vi.fn(), mergeGithubPr: vi.fn() }))
const taskId = 'a1234567-1234-4123-8123-123456789abc'
const run: ApiRun = { id: taskId, title: 'Feature', workflow: 'quick-task', task: 'Feature', status: 'done', createdAt: '', tokensUsed: 0, steps: [], archived: false }
afterEach(() => { cleanup(); vi.clearAllMocks() })
function show(task = run, search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { ...render(<MemoryRouter initialEntries={[`/tasks/${task.id}${search}`]}><QueryClientProvider client={client}><FeaturePreviewButton run={task} /></QueryClientProvider></MemoryRouter>), client }
}
it('opens a Factory POST handoff in a new window with the exact version', async () => {
  vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit: 'a'.repeat(40) })
  show()
  const form = (await screen.findByRole('button', { name: 'Build preview' })).closest('form')!
  expect(form.method).toBe('post'); expect(form.target).toBe('_blank'); expect(form.getAttribute('rel')).toBe('noopener')
  expect(form.action).toBe('http://factory.example:3000/api/projects/demo/feature-preview')
  expect(Object.fromEntries(new FormData(form))).toEqual({ taskId, number: '9', commit: 'a'.repeat(40) })
  expect(screen.getByRole('button', { name: 'Merge PR into main' })).toBeTruthy()
})
const commit = 'a'.repeat(40)
function available() { vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit }) }
const ready = { number: 9, title: 'Feature', url: 'https://github.com/acme/demo/pull/9', state: 'open' as const, isDraft: false, headRef: 'cez/task', baseRef: 'main', headSha: commit,
  mergeable: 'mergeable' as const, reviewDecision: 'approved' as const, checks: [], checksTier: 'detailed' as const, methods: ['squash' as const], defaultMethod: 'squash' as const, eligibility: 'ready' as const, blockers: [], canMerge: true, canOverride: false }
it('opens GitHub result links without creating a PR, merging or submitting a preview', async () => {
  available(); show(run, `?featureAction=preview&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  const form = within(dialog).getByRole('button', { name: 'Build preview' }).closest('form')!
  expect(new FormData(form).get('commit')).toBe(commit)
  expect(createRunPr).not.toHaveBeenCalled(); expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('rejects stale GitHub result links instead of selecting the current version silently', async () => {
  available(); show(run, `?featureAction=merge&commit=${'b'.repeat(40)}&number=9`)
  expect((await screen.findByRole('alert')).textContent).toContain('older task version')
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mergeGithubPr).not.toHaveBeenCalled()
})
it.each(['approved', 'not-required'] as const)('merges the selected PR into main with reviews %s without a preview or rule override', async reviewDecision => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: { ...ready, reviewDecision } })
  vi.mocked(mergeGithubPr).mockResolvedValue({ merged: true, number: 9, url: ready.url, method: 'squash' })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  const button = within(dialog).getByRole('button', { name: 'Merge PR into main' })
  await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  expect(mergeGithubPr).not.toHaveBeenCalled()
  fireEvent.click(button)
  await vi.waitFor(() => expect(mergeGithubPr).toHaveBeenCalledWith(9, { method: 'squash', expectedHeadSha: commit, expectedBaseRef: 'main', overrideRules: false }))
})
it.each([{ ...ready, baseRef: 'develop' }, { ...ready, headSha: 'b'.repeat(40) }, { ...ready, canMerge: false, canOverride: true }])('withholds merging when the base, commit or GitHub requirements differ', async state => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: state })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).getByRole('button', { name: 'Merge PR into main' }).hasAttribute('disabled')).toBe(true)
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('keeps a GitHub preview link pinned while task discovery refreshes', async () => {
  available(); const { client } = show(run, `?featureAction=preview&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await act(async () => { client.setQueryData([null, 'feature-preview', run.id, run.status, run.finishedAt], { available: true, factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit: 'b'.repeat(40) }) })
  const form = within(dialog).getByRole('button', { name: 'Build preview' }).closest('form')!
  expect(new FormData(form).get('commit')).toBe(commit)
})
it('creates a missing PR for the selected commit only after the explicit Create click', async () => {
  available(); vi.mocked(createRunPr).mockResolvedValue({ url: ready.url, dryRun: false })
  vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: ready })
  show(run, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  expect(createRunPr).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Create PR for main' }))
  await vi.waitFor(() => expect(createRunPr).toHaveBeenCalledWith(taskId, { draft: false, baseBranch: 'main', expectedHeadSha: commit }))
  expect(mergeGithubPr).not.toHaveBeenCalled()
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

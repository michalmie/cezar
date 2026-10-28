import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, fireEvent, within, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ApiRun } from '@open-mercato/cezar-api-client'
import { getFeaturePreview, createRunPr, getGithubPrMergeState, mergeGithubPr } from '@/api/client'
import { toast } from '@/components/ui/toaster'
import { FeaturePreviewButton } from './feature-preview-button'
import { useAskAnswer, type AskAnswerDelivery } from './ask-answer'
import { MemoryRouter } from 'react-router'

vi.mock('@/api/client', () => ({ getFeaturePreview: vi.fn(), createRunPr: vi.fn(), getGithubPrMergeState: vi.fn(), mergeGithubPr: vi.fn() }))
vi.mock('./ask-answer', () => ({ useAskAnswer: vi.fn() }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
const taskId = 'a1234567-1234-4123-8123-123456789abc'
const run: ApiRun = { id: taskId, title: 'Feature', workflow: 'quick-task', task: 'Feature', status: 'done', createdAt: '', tokensUsed: 0, steps: [], archived: false }
const send = vi.fn()
beforeEach(() => {
  send.mockResolvedValue(undefined)
  vi.mocked(useAskAnswer).mockReturnValue({ mode: 'live', isPending: false, send } as AskAnswerDelivery)
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
function show(task = run, search = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { ...render(<MemoryRouter initialEntries={[`/tasks/${task.id}${search}`]}><QueryClientProvider client={client}><FeaturePreviewButton run={task} /></QueryClientProvider></MemoryRouter>), client }
}
it('opens a Factory POST handoff in a new window with the exact version', async () => {
  vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, mode: 'claim', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit: 'a'.repeat(40) })
  show()
  const form = (await screen.findByRole('button', { name: 'Build preview' })).closest('form')!
  expect(form.method).toBe('post'); expect(form.target).toBe('_blank'); expect(form.getAttribute('rel')).toBe('noopener')
  expect(form.action).toBe('http://factory.example:3000/api/projects/demo/feature-preview')
  expect(Object.fromEntries(new FormData(form))).toEqual({ taskId, number: '9', commit: 'a'.repeat(40) })
  expect(screen.getByRole('button', { name: 'Merge PR into main' })).toBeTruthy()
})
const commit = 'a'.repeat(40)
function available() { vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, mode: 'claim', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit }) }
function availableManual() { vi.mocked(getFeaturePreview).mockResolvedValue({ available: true, mode: 'manual', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, commit, branch: 'cez/task', title: 'Feature' }) }
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
it('withholds merging until overridden when GitHub requirements differ', async () => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: { ...ready, canMerge: false, canOverride: true } })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).getByRole('button', { name: 'Merge PR into main' }).hasAttribute('disabled')).toBe(true)
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it.each([{ ...ready, baseRef: 'develop' }, { ...ready, headSha: 'b'.repeat(40) }])('hides merge controls when the base or commit differ', async state => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: state })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(within(dialog).queryByLabelText('Merge method')).toBeNull()
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('offers an explicit override merge when GitHub requirements are unknown', async () => {
  const unknown = { ...ready, mergeable: 'unknown' as const, reviewDecision: 'unknown' as const, eligibility: 'unknown' as const, blockers: [{ code: 'rules-unknown', message: 'GitHub could not confirm review and branch-protection requirements.' }], canMerge: false, canOverride: true }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: unknown })
  vi.mocked(mergeGithubPr).mockResolvedValue({ merged: true, number: 9, url: ready.url, method: 'squash' })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  const button = within(dialog).getByRole('button', { name: 'Merge PR into main' })
  expect(button.hasAttribute('disabled')).toBe(true)
  const override = within(dialog).getByRole('checkbox', { name: /Merge without waiting for requirements/ })
  fireEvent.click(override)
  await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await vi.waitFor(() => expect(mergeGithubPr).toHaveBeenCalledWith(9, { method: 'squash', expectedHeadSha: commit, expectedBaseRef: 'main', overrideRules: true }))
})
it.each([{ ...ready, baseRef: 'develop', canMerge: false, canOverride: true }, { ...ready, headSha: 'b'.repeat(40), canMerge: false, canOverride: true }])('never offers a rule override for the wrong base or version', async state => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: state })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).queryByRole('checkbox', { name: /Merge without waiting for requirements/ })).toBeNull()
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('shows an unmistakable success state after merging', async () => {
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: ready })
  vi.mocked(mergeGithubPr).mockResolvedValue({ merged: true, number: 9, url: ready.url, method: 'squash', mergeCommitSha: 'c'.repeat(40) })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  const button = within(dialog).getByRole('button', { name: 'Merge PR into main' })
  await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await within(dialog).findByRole('heading', { name: 'Merged into main' })
  expect(within(dialog).getByRole('status').textContent).toContain('PR #9 is now on main.')
  expect(within(dialog).getByRole('status').textContent).toContain(`Merge commit ${'c'.repeat(8)}`)
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(within(dialog).queryByLabelText('Merge method')).toBeNull()
  expect(within(dialog).queryByRole('checkbox')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }))
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
it('shows the merged state without merge controls when the PR is already merged', async () => {
  const merged = { ...ready, state: 'merged' as const, mergeable: 'unknown' as const, reviewDecision: 'unknown' as const, eligibility: 'terminal' as const, blockers: [{ code: 'terminal', message: 'This pull request is merged.' }], canMerge: false, canOverride: false }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: merged })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('heading', { name: 'Merged into main' })
  expect(within(dialog).queryByText(/Reviews:/)).toBeNull()
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('names a closed PR without offering a merge', async () => {
  const closed = { ...ready, state: 'closed' as const, eligibility: 'terminal' as const, blockers: [{ code: 'terminal', message: 'This pull request is closed.' }], canMerge: false, canOverride: false }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: closed })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('heading', { name: 'Pull request closed' })
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('sends conflict resolution to the agent instead of offering a merge', async () => {
  const conflicted = { ...ready, mergeable: 'conflicting' as const, eligibility: 'blocked' as const, blockers: [{ code: 'conflicts', message: 'Conflicts must be resolved before merging.' }], canMerge: false, canOverride: false }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: conflicted })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  expect(within(dialog).queryByLabelText('Merge method')).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve conflicts in PR #9' }))
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith('Resolve conflicts in PR 9'))
  expect(toast).toHaveBeenCalledWith('Resolving conflicts in PR #9 — reopen Merge when the agent pushes.')
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(mergeGithubPr).not.toHaveBeenCalled()
})
it('explains when the agent cannot resolve conflicts', async () => {
  const conflicted = { ...ready, mergeable: 'conflicting' as const, eligibility: 'blocked' as const, blockers: [{ code: 'conflicts', message: 'Conflicts must be resolved before merging.' }], canMerge: false, canOverride: false }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: conflicted })
  vi.mocked(useAskAnswer).mockReturnValue({ mode: 'unavailable', blockedBy: 'provider', reason: 'no engine is connected', isPending: false, send } as AskAnswerDelivery)
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByText(/no engine is connected/)
  expect(within(dialog).queryByRole('button', { name: /Resolve conflicts/ })).toBeNull()
  expect(send).not.toHaveBeenCalled()
})
it('adopts the reviewed new head after the PR moves', async () => {
  const moved = 'b'.repeat(40)
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: { ...ready, headSha: moved } })
  vi.mocked(mergeGithubPr).mockResolvedValue({ merged: true, number: 9, url: ready.url, method: 'squash' })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  expect(within(dialog).queryByRole('button', { name: 'Merge PR into main' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Review updated version' }))
  const button = await within(screen.getByRole('dialog')).findByRole('button', { name: 'Merge PR into main' })
  await vi.waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
  await vi.waitFor(() => expect(mergeGithubPr).toHaveBeenCalledWith(9, { method: 'squash', expectedHeadSha: moved, expectedBaseRef: 'main', overrideRules: false }))
})
it('links each check to its GitHub Actions run when a URL is available', async () => {
  const withChecks = { ...ready, canMerge: false, canOverride: true, eligibility: 'pending' as const, blockers: [{ code: 'pending', message: 'Checks or GitHub mergeability are still pending.' }], checks: [{ name: 'checks', state: 'pending' as const, required: true, url: 'https://github.com/acme/demo/actions/runs/1/job/2' }, { name: 'lint', state: 'passing' as const, required: false }] }
  available(); vi.mocked(getGithubPrMergeState).mockResolvedValue({ available: true, mergeState: withChecks })
  show({ ...run, pullRequestUrl: ready.url }, `?featureAction=merge&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await within(dialog).findByRole('link', { name: 'Review PR #9 ↗' })
  const details = within(dialog).getByRole('link', { name: 'details' })
  expect(details.getAttribute('href')).toBe('https://github.com/acme/demo/actions/runs/1/job/2')
  expect(details.getAttribute('target')).toBe('_blank')
})
it('keeps a GitHub preview link pinned while task discovery refreshes', async () => {
  available(); const { client } = show(run, `?featureAction=preview&commit=${commit}&number=9`)
  const dialog = await screen.findByRole('dialog')
  await act(async () => { client.setQueryData([null, 'feature-preview', run.id, run.status, run.finishedAt], { available: true, mode: 'claim', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId, number: 9, commit: 'b'.repeat(40) }) })
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
it('posts a manual branch handoff without an issue number', async () => {
  availableManual(); show()
  const form = (await screen.findByRole('button', { name: 'Build preview' })).closest('form')!
  expect(Object.fromEntries(new FormData(form))).toEqual({ manual: 'true', taskId, commit, branch: 'cez/task', title: 'Feature', cezarProjectId: '' })
  expect(screen.getByRole('button', { name: 'Merge PR into main' })).toBeTruthy()
})
it('opens a manual preview link pinned to its commit without a number', async () => {
  availableManual(); show(run, `?featureAction=preview&commit=${commit}`)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(/Build branch cez\/task/)).toBeTruthy()
  const form = within(dialog).getByRole('button', { name: 'Build preview' }).closest('form')!
  expect(new FormData(form).get('branch')).toBe('cez/task')
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

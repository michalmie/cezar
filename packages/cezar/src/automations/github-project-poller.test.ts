import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GithubPoller, type GithubCandidate } from './github-poller.ts';
import { ProjectAutomationScheduler } from './scheduler.ts';
import { AutomationStore } from './store.ts';
import { automationDefinitionSchema, type GithubAutomationDefinition } from './types.ts';

const definition: GithubAutomationDefinition = {
  id: 'ready', revision: 1, name: 'Ready', enabled: true, kind: 'github',
  events: ['project.item.status_changed'], projectTrigger: { url: 'https://github.com/users/acme/projects/1/views/2', targetStatus: 'Ready' },
  intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Implement #{{github.number}}' },
  createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
};
const info = { hasNextPage: false, endCursor: null };
const item = (number: number, optionId = 'backlog') => ({ id: `item-${number}`, isArchived: false,
  fieldValueByName: { optionId, field: { id: 'status' } },
  content: { __typename: 'Issue', id: `issue-${number}`, number, title: `Issue ${number}`, url: `https://github.com/acme/demo/issues/${number}`, state: 'OPEN',
    repository: { nameWithOwner: 'acme/demo' }, author: { login: 'alice' },
    assignees: { nodes: [], pageInfo: info }, labels: { nodes: [{ name: 'bug' }], pageInfo: info },
  },
});
function fixture() {
  const state = { items: [item(1), item(2, 'ready')], broken: false, paginate: false, missingStatus: false };
  const run = vi.fn(async (_executable: string, args: readonly string[]) => {
    if (state.broken) return JSON.stringify({ errors: [{ message: 'permission denied' }] });
    if (args.some(arg => arg.startsWith('id='))) {
      const second = args.includes('cursor=next');
      return JSON.stringify({ data: { node: { items: { nodes: state.paginate ? [state.items[second ? 1 : 0]] : state.items,
        pageInfo: state.paginate && !second ? { hasNextPage: true, endCursor: 'next' } : info,
      } } } });
    }
    return JSON.stringify({ data: { owner: { projectV2: { id: 'board', url: 'https://github.com/users/acme/projects/1', closed: false,
      fields: { nodes: [{ id: 'status', name: 'Status', options: state.missingStatus ? [] : [{ id: 'ready', name: 'Ready' }, { id: 'backlog', name: 'Backlog' }] }], pageInfo: info },
    } } } });
  });
  return { state, poller: new GithubPoller({ run }), run };
}
const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('GitHub Project status polling', () => {
  it('baselines every page and detects entry into Ready once, including a newly added Ready issue', async () => {
    const { state, poller, run } = fixture(); state.paginate = true;
    const baseline = await poller.poll('acme', 'demo', definition);
    expect(baseline.candidates).toEqual([]);
    expect(baseline.projectPoll?.statuses).toEqual({ 'item-1': 'backlog', 'item-2': 'ready' });
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', '--hostname', 'github.com', 'graphql', 'cursor=next']));
    state.paginate = false; state.items[0] = item(1, 'ready'); state.items.push(item(3, 'ready'));
    const result = await poller.poll('acme', 'demo', definition, { projectPoll: baseline.projectPoll });
    expect(result.candidates.map(candidate => candidate.number)).toEqual([1, 3]);
    const repeat = await poller.poll('acme', 'demo', definition, { projectPoll: result.projectPoll });
    expect(repeat.candidates.map(candidate => candidate.eventId)).toEqual(result.candidates.map(candidate => candidate.eventId));
    state.items[0] = item(1);
    const leave = await poller.poll('acme', 'demo', definition, { projectPoll: result.projectPoll });
    expect(leave.candidates.map(candidate => candidate.number)).toEqual([3]);
    state.items[0] = item(1, 'ready');
    const returnReady = await poller.poll('acme', 'demo', definition, { projectPoll: leave.projectPoll });
    expect(returnReady.candidates.find(candidate => candidate.number === 1)?.eventId).not.toBe(result.candidates[0]?.eventId);
  });

  it('excludes foreign repos, drafts, PRs, archived and closed issues; applies labels and authors', async () => {
    const { state, poller } = fixture();
    const baseline = await poller.poll('acme', 'demo', definition);
    state.items = [item(1, 'ready'), { ...item(3, 'ready'), isArchived: true }, { ...item(4, 'ready'), content: { ...item(4).content, state: 'CLOSED' } },
      { ...item(5, 'ready'), content: { ...item(5).content, repository: { nameWithOwner: 'other/demo' } } },
      { ...item(6, 'ready'), content: { __typename: 'PullRequest' } } as never,
      { ...item(7, 'ready'), content: { __typename: 'DraftIssue' } } as never,
    ];
    const result = await poller.poll('acme', 'demo', { ...definition, filters: { ...definition.filters, allLabels: ['bug'], authors: ['alice'] } }, { projectPoll: baseline.projectPoll });
    expect(result.candidates.map(candidate => candidate.number)).toEqual([1]);
    const filtered = await poller.poll('acme', 'demo', { ...definition, filters: { ...definition.filters, excludeLabels: ['bug'] } }, { projectPoll: baseline.projectPoll });
    expect(filtered.candidates).toEqual([]);
  });

  it('fails closed on API errors, missing options and partial pages; rejects invalid trigger configuration', async () => {
    const { state, poller, run } = fixture(); state.broken = true;
    await expect(poller.poll('acme', 'demo', definition)).rejects.toThrow('incomplete');
    state.broken = false; state.missingStatus = true;
    await expect(poller.poll('acme', 'demo', definition)).rejects.toThrow('exact Ready');
    state.missingStatus = false;
    run.mockImplementationOnce(async () => JSON.stringify({ data: { owner: { projectV2: { id: 'board', url: 'https://github.com/users/acme/projects/1', closed: false, fields: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } } }));
    await expect(poller.poll('acme', 'demo', definition)).rejects.toThrow('pagination cursor');
    expect(automationDefinitionSchema.safeParse({ ...definition, events: ['project.item.status_changed', 'issue.opened'] }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...definition, projectTrigger: { url: '', targetStatus: 'Ready' } }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...definition, projectTrigger: { url: 'https://evil.com/users/acme/projects/1', targetStatus: 'Ready' } }).success).toBe(false);
  });

  it('checkpoints before launch, queues while busy, previews without changes and recovers receipts after a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-project-test-')); dirs.push(dir);
    const store = AutomationStore.open(dir);
    const saved = store.create(definition, 'ready') as GithubAutomationDefinition;
    store.setState(saved.id, () => ({ revision: saved.revision, baselineAt: '2026-07-26T00:00:00.000Z' }));
    const { state, poller } = fixture();
    let busy = false; let crash = true;
    const launch = vi.fn(async (_definition: GithubAutomationDefinition, candidate: GithubCandidate) => {
      expect(store.state(saved.id)?.projectPoll?.pending.some(row => row.eventId === candidate.eventId)).toBe(true);
      if (crash) throw new Error('simulated lost launch response');
      return { runId: `run-${candidate.number}` };
    });
    const scheduler = () => new ProjectAutomationScheduler({ projectId: 'p', timeZone: 'UTC', store, github: { owner: 'acme', repo: 'demo', poller }, launch, canLaunchProject: async () => !busy });
    await scheduler().check(saved);
    state.items = [item(1, 'ready'), item(2, 'ready'), item(3, 'ready')];
    const before = store.state(saved.id);
    expect((await scheduler().check(saved, 'preview')).candidates).toHaveLength(2);
    expect(store.state(saved.id)).toEqual(before); expect(launch).not.toHaveBeenCalled(); expect(store.receipts()).toEqual([]);
    busy = true; await scheduler().check(saved);
    expect(store.state(saved.id)?.projectPoll?.pending).toHaveLength(2); expect(launch).not.toHaveBeenCalled();
    busy = false; await expect(scheduler().check(saved)).rejects.toThrow('lost launch response');
    expect(store.state(saved.id)?.projectPoll?.pending).toHaveLength(2);
    store.setState(saved.id, current => ({ ...current, backoffUntil: undefined }));
    crash = false; await scheduler().check(saved);
    expect(launch).toHaveBeenCalledTimes(2); expect(launch.mock.calls.map(call => call[1].number)).toEqual([1, 3]);
    expect(store.state(saved.id)?.projectPoll?.pending).toEqual([]);
    await scheduler().check(saved); expect(launch).toHaveBeenCalledTimes(2);
  });
});

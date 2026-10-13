import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

const createDraftPr = vi.hoisted(() => vi.fn());
vi.mock('./pr.ts', async (original) => ({ ...await original<typeof import('./pr.ts')>(), createDraftPr }));

describe('PR publishing delivery report', () => {
  let root: string;
  let dataDir: string;
  let store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-pr-delivery-'));
    dataDir = join(root, '.ai/cezar');
    mkdirSync(dataDir, { recursive: true });
    store = RunStore.open(dataDir);
    createDraftPr.mockReset().mockResolvedValue({ ok: true, url: 'https://github.com/acme/demo/pull/9', dryRun: true });
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
  });

  it('passes a saved final response to PR creation when the handoff was never written', async () => {
    const run = store.createRun({ title: 'Price history', task: 'Pick one Ready issue', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'review', worktreePath: root, branch: 'cez/abc123' });
    store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: 'final', role: 'assistant', text: 'Implemented price recording and display.\n\n73 tests passed.\nCEZ:DONE' } });
    const app = createApp({ repoRoot: root, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test' });
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/pr`, { method: 'POST' });
    expect(response.status).toBe(201);
    expect(createDraftPr).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Implemented price recording and display.\n\n73 tests passed.' }));
  });
  it('allows the selected completed commit when its worktree was removed, preserving the default refusal', async () => {
    const run = store.createRun({ title: 'Feature', task: 'Feature', workflow: 'quick-task', steps: [] });
    store.updateRun(run.id, { status: 'done', worktreePath: join(root, 'removed'), branch: 'cez/task' });
    const app = createApp({ repoRoot: root, store, manager: { isActive: () => false } as unknown as RunManager, version: 'test' });
    expect((await apiRequest(app, `/api/v1/runs/${run.id}/pr`, { method: 'POST' })).status).toBe(400);
    const response = await apiRequest(app, `/api/v1/runs/${run.id}/pr`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: false, baseBranch: 'main', expectedHeadSha: 'a'.repeat(40) }) });
    expect(response.status).toBe(201);
    expect(createDraftPr).toHaveBeenCalledWith(expect.objectContaining({ baseBranch: 'main', expectedHeadSha: 'a'.repeat(40) }));
  });
});

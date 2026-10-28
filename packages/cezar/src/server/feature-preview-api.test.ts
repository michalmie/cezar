import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { InferResponseType } from 'hono/client';
import { hc } from 'hono/client';
import { featurePreviewResponseSchema, type FeaturePreviewResponse } from '@open-mercato/cezar-contract';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import type { AppType } from './app-type.ts';
import { featurePreview } from './feature-preview.ts';
import { apiRequest } from './loopback-request.testkit.ts';

let factory: string; let root: string; let store: RunStore; let run: RunRecord; let commit: string; let claims: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
const json = (file: string, body: unknown) => writeFileSync(file, JSON.stringify(body));
beforeEach(() => {
  factory = mkdtempSync(join(tmpdir(), 'cez-feature-preview-')); root = join(factory, 'projects/demo');
  mkdirSync(join(root, 'config'), { recursive: true }); mkdirSync(join(root, 'deploy')); mkdirSync(join(factory, 'config'));
  json(join(factory, 'package.json'), { name: 'vibe-factory' });
  json(join(factory, 'config/feature-preview-bridge.json'), { version: 1, factoryOrigin: 'http://factory.example:3000' });
  json(join(root, 'config/project.json'), { github: { owner: 'acme', repo: 'demo' } });
  json(join(root, 'deploy/preview.json'), { version: 1 });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com');
  git('add', '.'); git('commit', '-m', 'base'); git('checkout', '-b', 'cez/task');
  commit = git('rev-parse', 'HEAD');
  store = RunStore.open(join(root, '.ai/cezar'));
  run = store.createRun({ title: 'Feature', workflow: 'quick-task', task: 'Feature', steps: [] });
  run = store.updateRun(run.id, { status: 'done', branch: 'cez/task' })!;
  claims = join(factory, 'config/cezar-ready-claims', createHash('sha256').update('acme/demo').digest('hex'));
  mkdirSync(claims, { recursive: true });
  json(join(claims, '9.json'), { taskId: run.id, status: 'review', branch: run.branch, repository: 'acme/demo', commit, number: 9, issueUrl: 'https://github.com/acme/demo/issues/9' });
});
afterEach(() => { store.flush(); rmSync(factory, { recursive: true, force: true }); });

it('discovers Factory and pins the completed task version without launching or changing the task', async () => {
  const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
  const response = await apiRequest(app, `/api/v1/p/default/runs/${run.id}/feature-preview`);
  expect(response.status).toBe(200);
  expect(featurePreviewResponseSchema.parse(await response.json())).toEqual({ available: true, mode: 'claim', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId: run.id, commit, number: 9 });
  expect(store.getRun(run.id)?.status).toBe('done');
  expect((await apiRequest(app, '/api/v1/runs/invalid/feature-preview')).status).toBe(400);
  expect((await apiRequest(app, '/api/v1/runs/11111111-1111-4111-8111-111111111111/feature-preview')).status).toBe(404);
});
it('withholds handoffs for active tasks, unsupported projects and unsafe destinations', () => {
  expect(featurePreview(root, { ...run, status: 'running' }).available).toBe(false);
  json(join(factory, 'config/feature-preview-bridge.json'), { version: 1, factoryOrigin: 'https://user:secret@example.com' });
  expect(featurePreview(root, run).available).toBe(false);
  expect(featurePreview(factory, run).available).toBe(false);
});
it('offers a manual branch handoff when no Ready claim exists', () => {
  rmSync(join(claims, '9.json'));
  expect(featurePreview(root, run)).toEqual({ available: true, mode: 'manual', factoryUrl: 'http://factory.example:3000/api/projects/demo/feature-preview', taskId: run.id, commit, branch: 'cez/task', title: 'Feature' });
  json(join(claims, '9.json'), { taskId: run.id, status: 'in-progress' });
  expect(featurePreview(root, run)).toMatchObject({ available: true, mode: 'manual', branch: 'cez/task' });
});
it('withholds manual handoffs without a branch, a missing branch or no adapter', () => {
  rmSync(join(claims, '9.json'));
  expect(featurePreview(root, { ...run, branch: undefined }).available).toBe(false);
  expect(featurePreview(root, { ...run, branch: 'cez/missing' }).available).toBe(false);
  git('rm', 'deploy/preview.json'); git('commit', '-m', 'remove adapter');
  expect(featurePreview(root, run).available).toBe(false);
  git('checkout', 'main'); git('update-ref', '-d', 'refs/heads/cez/task');
  expect(featurePreview(root, run).available).toBe(false);
});
it('requires the continuation trailer before offering a newer immutable task version', () => {
  writeFileSync(join(root, 'feature.txt'), 'new'); git('add', 'feature.txt'); git('commit', '-m', 'new feature');
  expect(featurePreview(root, run).available).toBe(false);
  git('commit', '--amend', '-m', 'new feature\n\nReady-Issue: https://github.com/acme/demo/issues/9');
  expect(featurePreview(root, run)).toMatchObject({ available: true, commit: git('rev-parse', 'HEAD') });
});
it('offers the same completed application after a metadata-only finalize autosave', () => {
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  json(join(root, '.ai/cezar/ready-result.json'), { summary: 'Validated result' });
  git('add', '.ai/cezar/ready-result.json'); git('commit', '-m', 'cezar autosave (run finalize)');
  expect(featurePreview(root, run)).toMatchObject({ available: true, commit: git('rev-parse', 'HEAD') });
});
it('keeps an autosave containing application changes behind the result gate', () => {
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  json(join(root, '.ai/cezar/ready-result.json'), { summary: 'Unvalidated changes' });
  writeFileSync(join(root, 'feature.txt'), 'new code');
  git('add', '.ai/cezar/ready-result.json', 'feature.txt'); git('commit', '-m', 'cezar autosave (run finalize)');
  expect(featurePreview(root, run).available).toBe(false);
});
it('recognizes a validated continuation followed by metadata autosave', () => {
  writeFileSync(join(root, 'feature.txt'), 'continued code'); git('add', 'feature.txt');
  git('commit', '-m', 'continued feature\n\nReady-Issue: https://github.com/acme/demo/issues/9');
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  json(join(root, '.ai/cezar/ready-result.json'), { summary: 'Continued result' });
  git('add', '.ai/cezar/ready-result.json'); git('commit', '-m', 'cezar autosave (run finalize)');
  expect(featurePreview(root, run)).toMatchObject({ available: true, commit: git('rev-parse', 'HEAD') });
});

const client = hc<AppType>('http://localhost');
type Route = InferResponseType<typeof client.api.v1.runs[':id']['feature-preview']['$get'], 200>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const parity: Mutual<Route, FeaturePreviewResponse> = true;
it('keeps the discovery route and contract in agreement', () => expect(parity).toBe(true));

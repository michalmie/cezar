import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { treeDir } from '../dispatch/tree-fs.ts';
import { RunStore } from '../runs/store.ts';
import { registerProject } from '../workspace/projects.ts';
import { RunManager } from './run.ts';

/**
 * A dispatch-mode root must hand its backend a tree directory that EXISTS.
 * The tree dir is otherwise only written lazily at first dispatch, so a root
 * started with the composer's Dispatch toggle granted a path that was not
 * there — and strict backends (muse `workspaceRoots`) refuse to START when a
 * granted directory is missing, failing the run before the agent does anything.
 *
 * Exercised at the `agentEnvForStep` seam — the last common path before every
 * backend spawn — for the same reason the #785 tests use it: the point under
 * test is the exact environment handed to the child.
 */
describe('RunManager — dispatch tree directory exists before spawn', () => {
  const savedHome = process.env.CEZ_HOME;
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: RunManager;

  type Seam = {
    agentEnvForStep(
      runId: string,
      backend: 'muse',
      options?: { generateFollowups?: boolean; recordedProfileId?: string },
    ): Promise<{ env: Record<string, string>; profileId: string }>;
  };
  const seam = () => manager as unknown as Seam;

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-dispatch-treedir-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-dispatch-treedir-repo-'));
    dataDir = join(repoRoot, '.ai/cezar');
    process.env.CEZ_HOME = home;
    store = RunStore.open(dataDir);
    manager = new RunManager(store, repoRoot);
    await registerProject(repoRoot);
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
  });

  const newDispatchRoot = () => {
    const run = store.createRun({
      title: 't',
      workflow: 'w',
      task: 't',
      steps: [{ id: 's', name: 's', kind: 'agent' }],
    });
    store.updateRun(run.id, { dispatch: { rootRunId: run.id, intent: {} } });
    return store.getRun(run.id) ?? run;
  };

  it('sets CEZ_TREE_DIR to an existing directory for a dispatch-mode root', async () => {
    const run = newDispatchRoot();
    // Nothing has dispatched yet, so nothing has written the tree.
    expect(existsSync(treeDir(dataDir, run.id))).toBe(false);
    const { env } = await seam().agentEnvForStep(run.id, 'muse');
    expect(env.CEZ_TREE_DIR).toBe(treeDir(dataDir, run.id));
    expect(statSync(env.CEZ_TREE_DIR as string).isDirectory()).toBe(true);
    // The directory only — brief/order/notes keep their "written at first dispatch" timing.
    expect(existsSync(join(treeDir(dataDir, run.id), 'brief.md'))).toBe(false);
  });

  it('omits CEZ_TREE_DIR when the tree dir cannot be created', async () => {
    const run = newDispatchRoot();
    // A file where `dispatch/` belongs makes the tree dir uncreatable.
    writeFileSync(join(dataDir, 'dispatch'), 'blocked', 'utf8');
    const { env } = await seam().agentEnvForStep(run.id, 'muse');
    expect(env.CEZ_TREE_DIR).toBeUndefined();
  });

  it('omits CEZ_TREE_DIR when the tree path is blocked by a file', async () => {
    const run = newDispatchRoot();
    // A file exactly where the tree dir belongs: no directory to grant.
    mkdirSync(join(dataDir, 'dispatch'), { recursive: true });
    writeFileSync(treeDir(dataDir, run.id), 'blocked', 'utf8');
    const { env } = await seam().agentEnvForStep(run.id, 'muse');
    expect(env.CEZ_TREE_DIR).toBeUndefined();
  });

  it('leaves runs outside a dispatch tree without CEZ_TREE_DIR', async () => {
    const run = store.createRun({
      title: 't',
      workflow: 'w',
      task: 't',
      steps: [{ id: 's', name: 's', kind: 'agent' }],
    });
    const { env } = await seam().agentEnvForStep(run.id, 'muse');
    expect(env.CEZ_TREE_DIR).toBeUndefined();
  });
});

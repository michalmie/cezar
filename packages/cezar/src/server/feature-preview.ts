import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { FeaturePreviewResponse } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../runs/store.ts';

/** Factory owns builds; discovery only links a completed task to its managed handoff. */
export function featurePreview(root: string, run: RunRecord): FeaturePreviewResponse {
  const unavailable = (reason: string): FeaturePreviewResponse => ({ available: false, reason });
  if (run.status !== 'done') return unavailable('Finish the task before building a feature preview.');
  try {
    const projectRoot = realpathSync(root);
    const projects = dirname(projectRoot);
    const factory = dirname(projects);
    const slug = basename(projectRoot);
    if (basename(projects) !== 'projects' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
      || JSON.parse(readFileSync(join(factory, 'package.json'), 'utf8')).name !== 'vibe-factory') {
      return unavailable('This project is not managed by Vibe Factory.');
    }
    const bridge = JSON.parse(readFileSync(join(factory, 'config/feature-preview-bridge.json'), 'utf8'));
    const origin = new URL(bridge.factoryOrigin);
    if (bridge.version !== 1 || !['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
      || origin.origin !== bridge.factoryOrigin) return unavailable('Open this project in Factory to connect Preview.');
    const config = JSON.parse(readFileSync(join(projectRoot, 'config/project.json'), 'utf8'));
    const repository = `${config.github.owner}/${config.github.repo}`;
    const claims = join(factory, 'config/cezar-ready-claims', createHash('sha256').update(repository.toLowerCase()).digest('hex'));
    const claim = readdirSync(claims).filter(name => /^\d+\.json$/.test(name))
      .map(name => JSON.parse(readFileSync(join(claims, name), 'utf8')))
      .find(candidate => candidate.taskId === run.id && candidate.status === 'review' && candidate.branch === run.branch
        && candidate.repository === repository && /^[0-9a-f]{40}$/.test(candidate.commit || '')
        && Number.isSafeInteger(candidate.number) && candidate.number > 0);
    if (!claim) return unavailable('Finish this task through the Ready result gate before previewing.');
    const git = (...args: string[]) => execFileSync('git', ['-C', projectRoot, ...args], {
      encoding: 'utf8', stdio: 'pipe', timeout: 5000, maxBuffer: 1024 * 1024,
    }).trim();
    if (git('check-ref-format', '--branch', claim.branch) !== claim.branch) return unavailable('The task branch is unavailable.');
    const commit = git('rev-parse', `refs/heads/${claim.branch}^{commit}`);
    git('merge-base', '--is-ancestor', claim.commit, commit);
    // Finalize can checkpoint Factory's report after the validated application.
    // Only single-parent Cezar autosaves changing that exact report may inherit
    // the parent's validation; application changes and merges still need a gate.
    let validated = commit;
    for (let depth = 0; validated !== claim.commit && depth < 100; depth++) {
      const message = git('show', '-s', '--format=%B', validated);
      if (message.split('\n').includes(`Ready-Issue: ${claim.issueUrl}`)) break;
      const parents = git('show', '-s', '--format=%P', validated).split(' ');
      if (parents.length !== 1 || !/^cezar autosave \([a-z -]+\)$/.test(message)) break;
      const files = git('diff', '--name-only', '-z', parents[0]!, validated).split('\0').filter(Boolean);
      if (files.length !== 1 || files[0] !== '.ai/cezar/ready-result.json') break;
      validated = parents[0]!;
    }
    if (validated !== claim.commit && !git('show', '-s', '--format=%B', validated).split('\n').includes(`Ready-Issue: ${claim.issueUrl}`)) {
      return unavailable('Publish the newer completed task version before previewing.');
    }
    const adapter = JSON.parse(git('show', 'HEAD:deploy/preview.json'));
    if (adapter.version !== 1) return unavailable('This project has no supported preview adapter.');
    return { available: true, factoryUrl: `${origin.origin}/api/projects/${slug}/feature-preview`, taskId: run.id, commit, number: claim.number };
  } catch { return unavailable('Open this project in Factory to connect Preview and publish a completed task result.'); }
}

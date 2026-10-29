import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runnerSchema } from '@open-mercato/cezar-contract';
import type { AgentEvent } from './agent-runner.ts';
import type { UiEvent } from './ui-events.ts';
import { MuseRunner } from './muse-runner.ts';
import { discoverMuseModels } from './muse-model-catalog.ts';
import { buildChildEnv } from './agent-env.ts';
import { createRunner } from './runner-factory.ts';
import { parseMuseStatus } from './provider-auth.ts';
import { normalizeModelForBackend } from './model-identity.ts';

const bin = fileURLToPath(new URL('../../scripts/mock-muse.mjs', import.meta.url));
const spec = { cwd: process.cwd(), userPrompt: 'Hello' };

describe('Muse runner registration', () => {
  it('accepts Muse in the public contract and dispatches the selected backend', () => {
    expect(runnerSchema.safeParse('muse').success).toBe(true);
    expect(createRunner('muse').backend).toBe('muse');
    expect(normalizeModelForBackend('muse', 'meta/muse-custom')?.backendModel).toBe('muse-custom');
    expect(() => normalizeModelForBackend('muse', 'openai/gpt-custom')).toThrow();
  });
  it('forwards Meta credentials exclusively to Muse', () => {
    const source = { META_API_KEY: 'secret', ANTHROPIC_API_KEY: 'other', MUSE_CONFIG: 'setting' };
    expect(buildChildEnv({ backend: 'muse', source })).toEqual({ META_API_KEY: 'secret', MUSE_CONFIG: 'setting' });
    expect(buildChildEnv({ backend: 'claude', source })).not.toHaveProperty('META_API_KEY');
  });
  it('uses the bundled process in dry-run mode', async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    try { expect((await new MuseRunner().run(spec)).text).toBe('Muse: Hello'); }
    finally { vi.unstubAllEnvs(); }
  });
});

describe('MuseRunner over the offline MSP peer', () => {
  it('coalesces deltas once and retains usage emitted before turn completion', async () => {
    const v1: AgentEvent[] = []; const v2: UiEvent[] = [];
    const result = await new MuseRunner({ bin }).startSession({ ...spec, systemPrompt: 'System rules' }, e => v1.push(e), {
      autoEndAfterFirstTurn: true, onUiEvent: e => v2.push(e),
    }).result;
    expect(result.text).toBe('Muse: System rules\n\n---\n\nHello');
    expect(v1.filter(e => e.type === 'text')).toHaveLength(1);
    expect(result.tokensUsed).toBe(18);
    expect(v2).toContainEqual(expect.objectContaining({ type: 'session.started', backend: 'muse' }));
    expect(v2).toContainEqual(expect.objectContaining({ type: 'turn.completed', usage: expect.objectContaining({ input: 11, output: 7 }) }));
  });
  it('keeps one process and native session open for a follow-up', async () => {
    let turns = 0;
    const runner = new MuseRunner({ bin });
    const session = runner.startSession(spec, event => {
      if (event.type !== 'turn-end') return;
      if (++turns === 1) expect(session.sendMessage([{ type: 'text', text: 'Follow-up' }])).toBe(true);
      else session.end();
    });
    expect(session.pid).toBeGreaterThan(0);
    const result = await session.result;
    expect(result.text).toBe('Muse: Hello\nMuse: Follow-up');
    expect(result.tokensUsed).toBe(36);
    expect(turns).toBe(2);
    expect(session.sendMessage([{ type: 'text', text: 'closed' }])).toBe(false);
  });
  it('does not echo Cezar control-marker instructions as mock agent output', async () => {
    const result = await new MuseRunner({ bin }).run({ ...spec, systemPrompt: 'Example: CEZ:ASK <json>', env: { CEZ_TASK_ID: 'muse-test' } });
    expect(result.text).toBe('Muse: Hello');
  });
  it('resumes the requested native session with the selected model', async () => {
    const first = await new MuseRunner({ bin }).run(spec);
    const next = await new MuseRunner({ bin }).run({ ...spec, resume: true, sessionId: first.sessionId, model: 'muse-test' });
    expect(next.sessionId).toBe(first.sessionId);
  });
  it('applies the resumed model as a ModelSelection object', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-setmodel-wire-')); const log = join(dir, 'wire.ndjson');
    try {
      const first = await new MuseRunner({ bin }).run(spec);
      await new MuseRunner({ bin }).run({ ...spec, resume: true, sessionId: first.sessionId, model: 'muse-test',
        env: { CEZ_MUSE_WIRE_LOG: log },
      });
      const wire = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(wire.find(f => f.method === 'session/setModel').params).toMatchObject({ model: { modelId: 'muse-test' } });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('replaces Cezar pre-minted v4 IDs with the native session ID', async () => {
    const sessionId = randomUUID();
    const result = await new MuseRunner({ bin }).run({ ...spec, sessionId });
    expect(result.sessionId).toBeTruthy();
    expect(result.sessionId).not.toBe(sessionId);
  });
  it('finishes a slow queued follow-up before ending an automatic session', async () => {
    const session = new MuseRunner({ bin }).startSession({ ...spec, userPrompt: 'MOCK_SLOW first' }, undefined, { autoEndAfterFirstTurn: true });
    session.sendMessage([{ type: 'text', text: 'MOCK_SLOW second' }]);
    const result = await session.result;
    expect(result.text).toBe('Muse: MOCK_SLOW first\nMuse: MOCK_SLOW second');
    expect(result.tokensUsed).toBe(36);
  });
  it('answers multi-stage server approvals once per stage and transmits images/directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-wire-')); const log = join(dir, 'wire.ndjson');
    try {
      await new MuseRunner({ bin }).run({ ...spec, userPrompt: 'MOCK_APPROVAL', model: 'muse-test', additionalDirectories: [dir],
        images: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'test-data' } }], env: { CEZ_MUSE_WIRE_LOG: log },
      });
      const wire = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(wire.find(f => f.method === 'session/start').params).toMatchObject({ workspaceRoots: [spec.cwd, dir], approvalMode: 'allowAll', modelId: 'muse-test' });
      expect(wire.find(f => f.method === 'turn/start').params.input[0]).toEqual({ type: 'image', base64Data: 'test-data', mediaType: 'image/png' });
      expect(wire.filter(f => f.method === 'approval/decide')).toHaveLength(2);
      expect(wire.find(f => f.id === 'server-approval')).toMatchObject({ result: {} });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('holds back images the model cannot view instead of failing the turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-viewable-wire-')); const log = join(dir, 'wire.ndjson');
    try {
      const v1: AgentEvent[] = [];
      await new MuseRunner({ bin }).run({ ...spec,
        images: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'viewable' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/x-icon', data: 'icon-bytes' } },
        ], env: { CEZ_MUSE_WIRE_LOG: log },
      }, e => v1.push(e));
      const wire = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const input = wire.find(f => f.method === 'turn/start').params.input;
      expect(input.filter((b: { type: string }) => b.type === 'image')).toEqual([
        { type: 'image', base64Data: 'viewable', mediaType: 'image/png' },
      ]);
      expect(v1).toContainEqual(expect.objectContaining({ type: 'note', message: expect.stringContaining('image/x-icon') }));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('cancels a resumed native input request once despite a duplicate notification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-resume-wire-')); const log = join(dir, 'wire.ndjson');
    try {
      const first = await new MuseRunner({ bin }).run(spec);
      const result = await new MuseRunner({ bin }).run({ ...spec, resume: true, sessionId: first.sessionId,
        env: { CEZ_MUSE_WIRE_LOG: log, CEZ_MUSE_PENDING_INPUT: '1' },
      });
      const wire = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(wire.filter(f => f.method === 'userInput/cancel')).toHaveLength(1);
      expect(wire.find(f => f.id === 'server-input')).toMatchObject({ result: {} });
      expect(result.text).toBe('Muse: Hello');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('holds early follow-ups until the resumed model has been applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'muse-model-wire-')); const log = join(dir, 'wire.ndjson');
    try {
      const first = await new MuseRunner({ bin }).run(spec);
      const session = new MuseRunner({ bin }).startSession({ ...spec, resume: true, sessionId: first.sessionId, model: 'muse-test',
        env: { CEZ_MUSE_DELAY_MODEL: '1', CEZ_MUSE_WIRE_LOG: log },
      }, undefined, { autoEndAfterFirstTurn: true });
      await vi.waitFor(() => expect(readFileSync(log, 'utf8')).toContain('"session/setModel"'), { interval: 10 });
      session.sendMessage([{ type: 'text', text: 'Early follow-up' }]);
      const result = await session.result;
      expect(result.text).toContain('Muse: Early follow-up');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('fails a rejected turn instead of reporting a successful run', async () => {
    await expect(new MuseRunner({ bin }).run({ ...spec, userPrompt: 'MOCK_FAIL' })).rejects.toThrow('Muse test failure');
  });
  it('bounds a stalled run and settles operator interruption normally', async () => {
    await expect(new MuseRunner({ bin, timeoutMs: 100 }).run({ ...spec, userPrompt: 'MOCK_HANG' })).rejects.toThrow('timed out');
    const session = new MuseRunner({ bin, timeoutMs: 0 }).startSession({ ...spec, userPrompt: 'MOCK_HANG' });
    session.interrupt();
    await expect(session.result).resolves.toBeDefined();
  });
  it('reports a missing executable clearly', async () => {
    await expect(new MuseRunner({ bin: '/missing/cezar-muse' }).run(spec)).rejects.toThrow('was not found');
  });
  it('discovers native model IDs without starting a model turn', async () => {
    expect(await discoverMuseModels({ bin })).toEqual([{ id: 'muse-test', label: 'Muse test', description: 'Offline test model' }]);
  });
  it('distinguishes authenticated, logged-out and inconclusive allowance output', () => {
    const result = (stdout: string) => ({ stdout, stderr: '', exitCode: 0 });
    expect(parseMuseStatus(result('{"reason":"api_key","allowance":null}'))).toBe('connected');
    expect(parseMuseStatus(result('{"reason":"not_logged_in"}'))).toBe('disconnected');
    for (const stdout of ['invalid', '{}', '{"allowance":null}']) expect(parseMuseStatus(result(stdout))).toBeNull();
  });
});

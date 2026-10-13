import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deliverySummary, readRunDeliverySummary, renderDeliveryComment } from './delivery-summary.ts';
import { RunStore, type RunEvent } from './store.ts';

const event = (type: string, item: Record<string, unknown>): RunEvent => ({ type, item, seq: 1, ts: '2026-10-12T12:00:00Z' });

describe('delivery report fallback', () => {
  it('uses completed assistant text when the journal is missing or has only heartbeats', () => {
    const events = [
      event('item.completed', { kind: 'message', role: 'assistant', text: 'Implemented display.\n\nTests: 73 passed.\nCEZ:ISSUE=3\nCEZ:DONE' }),
      event('item.completed', { kind: 'tool', text: 'Misleading tool output' }),
      event('item.completed', { kind: 'reasoning', text: 'Private reasoning' }),
      event('item.completed', { kind: 'message', role: 'user', text: 'User instructions' }),
      event('item.updated', { kind: 'message', role: 'assistant', text: 'Incomplete response' }),
    ];
    for (const handoff of ['', '## Goal\nGeneric instructions\n## Progress log\n- 2026-10-12T12:00:00Z — turn complete — status=done\n## Delivery summary\n\n## Resume notes\n']) {
      expect(deliverySummary(handoff, () => events)).toBe('Implemented display.\n\nTests: 73 passed.');
    }
  });

  it('prefers the cumulative handoff report to later merge instructions and reads no transcript', () => {
    const readEvents = vi.fn(() => [event('item.completed', { kind: 'message', role: 'assistant', text: 'Please merge via the cockpit.' })]);
    const handoff = '## Delivery summary\r\n\r\nImplemented backend and display.\r\n\r\n### Validation\r\n73 tests passed.\r\n## Resume notes\r\n';
    expect(deliverySummary(handoff, readEvents)).toBe('Implemented backend and display.\n\n### Validation\n73 tests passed.');
    expect(readEvents).not.toHaveBeenCalled();
  });

  it('preserves nested headings and fenced examples within a report', () => {
    const report = 'Implemented documentation.\n\n```md\n## Resume notes\nexample\n```\n\n### Validation\nDocs checked.';
    expect(deliverySummary(`## Delivery summary\n${report}\n## Resume notes\n`)).toBe(report);
  });

  it('does not fabricate a result from an empty journal, prompt or lifecycle messages', () => {
    expect(deliverySummary('## Goal\nImplement display\n## Progress log\n- 2026-10-12T12:00:00Z — step "task" complete — status=done\n## Resume notes\n')).toBe('');
  });

  it('does not mistake headings inside the starting task for a delivery report', () => {
    const task = 'Pick one Ready issue.\n\n## Delivery summary\nWrite your completed work here.\n\n## Progress log\nReport your milestones.';
    expect(deliverySummary(`## Goal\n\n${task}\n\n## Progress log\n\n## Delivery summary\n\n## Resume notes\n`, undefined, { task })).toBe('');
  });

  it('publishes fork and sub-workflow reports from persisted graph outputs without a parent assistant', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-delivery-graph-'));
    let store = RunStore.open(dir);
    try {
      const run = store.createRun({ title: 'Price history', task: 'Generic instructions', workflow: 'graph', steps: [] });
      store.updateRun(run.id, {
        graphState: {
          loops: {}, taken: [],
          outputs: { backend: { summary: 'Implemented recording. Backend tests passed.\nCEZ:DONE' }, storefront: { summary: 'Implemented display. Live demo pending.' }, ci: { status: 'green' } },
        },
      });
      store.flush();
      store = RunStore.open(dir);
      expect(readRunDeliverySummary(dir, store, run.id)).toBe('### backend\n\nImplemented recording. Backend tests passed.\n\n### storefront\n\nImplemented display. Live demo pending.');
    } finally {
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses persisted assistant messages after reopening the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-delivery-'));
    let store = RunStore.open(dir);
    try {
      const run = store.createRun({ title: 'Price history', task: 'Generic instructions', workflow: 'quick-task', steps: [] });
      store.appendEvent(run.id, { type: 'item.completed', item: { kind: 'message', id: 'final', role: 'assistant', text: 'Delivered price history.\nCEZ:DONE' } });
      store.flush();
      store = RunStore.open(dir);
      expect(readRunDeliverySummary(dir, store, run.id)).toBe('Delivered price history.');
    } finally {
      store.flush();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('delivery comment templates', () => {
  const render = (token: string) => token.replace('{{task}}', 'Original task').replace('{{nodes.pr.url}}', 'https://github.com/acme/demo/pull/1');

  it('includes the report with other template values without reinterpreting its contents', () => {
    const summary = vi.fn(() => 'Implemented a renderer for {{task}} and {{nodes.work.summary}}.\n\n73 tests passed.');
    expect(renderDeliveryComment('{{summary}}\nPR: {{nodes.pr.url}}\nAgain: {{ summary }}', render, summary)).toBe(
      'Implemented a renderer for {{task}} and {{nodes.work.summary}}.\n\n73 tests passed.\nPR: https://github.com/acme/demo/pull/1\nAgain: Implemented a renderer for {{task}} and {{nodes.work.summary}}.\n\n73 tests passed.',
    );
    expect(summary).toHaveBeenCalledOnce();
  });

  it('keeps custom comment bodies and task references without requiring a summary', () => {
    const summary = vi.fn(() => '');
    expect(renderDeliveryComment('Follow-up for {{task}}', render, summary)).toBe('Follow-up for Original task');
    expect(summary).not.toHaveBeenCalled();
  });

  it('refuses a summary comment when no report exists', () => {
    expect(renderDeliveryComment('Delivered: {{summary}}', render, () => '')).toBeUndefined();
  });
});

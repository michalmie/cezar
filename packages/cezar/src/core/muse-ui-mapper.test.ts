import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMuseUiState, mapMuseFrame } from './muse-ui-mapper.ts';
import type { UiEvent } from './ui-events.ts';

describe('Muse MSP → v2', () => {
  for (const fixture of ['echo-live', 'schema-capabilities']) it(`replays ${fixture} exactly`, () => {
    const base = new URL(`./__fixtures__/muse/${fixture}`, import.meta.url);
    const lines = readFileSync(fileURLToPath(new URL(`${base}.ndjson`)), 'utf8').trim().split('\n');
    let state = createMuseUiState(); const events: UiEvent[] = [];
    for (const line of lines) { const next = mapMuseFrame(JSON.parse(line), state); state = next.state; events.push(...next.events); }
    expect(JSON.parse(JSON.stringify(events))).toEqual(JSON.parse(readFileSync(fileURLToPath(new URL(`${base}.expected.json`)), 'utf8')));
  });
  it('ignores malformed frames and malformed plans without clearing the dock', () => {
    const state = createMuseUiState();
    for (const frame of [null, 42, [], {}, { method: 'future', params: {} }, { method: 'session/todoListChanged', params: { items: [{ bogus: true }] } }]) {
      expect(mapMuseFrame(frame, state)).toEqual({ state, events: [] });
    }
  });
  it('does not turn foreground completion into turn completion', () => {
    expect(mapMuseFrame({ method: 'turn/foregroundCompleted', params: { turnId: 'turn' } }, createMuseUiState()).events).toEqual([]);
  });
  it('sums model completions per turn, deduplicates cursors, and prefers terminal aggregate usage', () => {
    let state = createMuseUiState();
    for (const viewCursor of ['one', 'two', 'two']) state = mapMuseFrame({ method: 'session/tokenUsage', params: {
      viewCursor, turnId: 'turn', usage: { inputTokens: 10, outputTokens: 3 },
    } }, state).state;
    const params = { turnId: 'turn', terminal: 'completed' };
    expect(mapMuseFrame({ method: 'turn/completed', params }, state).events).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ input: 20, output: 6, total: 26 }) }),
    ]);
    const terminal = mapMuseFrame({ method: 'turn/completed', params: { ...params, usage: { inputTokens: 30, outputTokens: 10 } } }, state);
    expect(terminal.events).toContainEqual(expect.objectContaining({ type: 'turn.completed', usage: expect.objectContaining({ input: 30, output: 10, total: 40 }) }));
    const next = mapMuseFrame({ method: 'session/tokenUsage', params: { turnId: 'next', usage: { inputTokens: 5, outputTokens: 2 } } }, terminal.state);
    expect(next.events).toContainEqual(expect.objectContaining({ type: 'usage.updated', usage: expect.objectContaining({ total: 47 }) }));
  });
  it('keeps each file diff under its own path', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old-a\n+new-a\n*** Add File: b.ts\n+new-b\n*** End Patch';
    const result = mapMuseFrame({ method: 'item/completed', params: { item: { itemId: 'edit', kind: 'toolCall', status: 'completed', tool: 'apply_patch', args: JSON.stringify({ patch }) } } }, createMuseUiState());
    expect(result.events).toEqual([expect.objectContaining({ item: expect.objectContaining({ diffs: [
      { path: 'a.ts', oldText: '', unified: '*** Update File: a.ts\n@@\n-old-a\n+new-a' },
      { path: 'b.ts', oldText: null, unified: '*** Add File: b.ts\n+new-b' },
    ] }) })]);
  });
  it('reports cumulative session usage while preserving separate turn totals', () => {
    let state = createMuseUiState();
    const first = mapMuseFrame({ method: 'session/tokenUsage', params: { turnId: 'one', usage: { inputTokens: 10, outputTokens: 3 } } }, state);
    state = first.state;
    const second = mapMuseFrame({ method: 'session/tokenUsage', params: { turnId: 'two', usage: { inputTokens: 20, outputTokens: 6 } } }, state);
    expect(second.events).toEqual([expect.objectContaining({ usage: expect.objectContaining({ input: 30, output: 9, total: 39 }) })]);
    expect(mapMuseFrame({ method: 'turn/completed', params: { turnId: 'two', terminal: 'completed' } }, second.state).events).toEqual([
      expect.objectContaining({ usage: expect.objectContaining({ input: 20, output: 6, total: 26 }) }),
    ]);
  });
});

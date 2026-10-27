import { z } from 'zod';
import { museFrameSchema, museItemSchema, museUsageSchema } from './muse-protocol.ts';
import { toolDisplay } from './tool-display.ts';
import type { FileDiff, TokenUsage, UiEvent, UiItem, UiToolItem } from './ui-events.ts';

/** MSP v1, exported offline by Muse 1.4.13. See __fixtures__/muse/README.md. */
export interface MuseUiState {
  items: ReadonlyMap<string, UiItem>; usage: ReadonlyMap<string, TokenUsage>;
  usageCursors: ReadonlySet<string>; summaries: ReadonlyMap<string, readonly string[]>;
}
export const createMuseUiState = (): MuseUiState => ({ items: new Map(), usage: new Map(), usageCursors: new Set(), summaries: new Map() });

export function museUsage(value: unknown): TokenUsage | undefined {
  const parsed = museUsageSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const u = parsed.data;
  return { input: u.inputTokens, output: u.outputTokens, total: u.inputTokens + u.outputTokens,
    cacheRead: u.cacheReadTokens ?? u.cachedTokens, cacheWrite: u.cacheWriteTokens, reasoning: u.reasoningTokens };
}

export function mapMuseFrame(value: unknown, state: MuseUiState): { state: MuseUiState; events: UiEvent[] } {
  const parsed = museFrameSchema.safeParse(value);
  if (!parsed.success) return { state, events: [] };
  const { method, params: p } = parsed.data;
  const events: UiEvent[] = [];
  if (method === 'turn/started' && typeof p.turnId === 'string') {
    events.push({ type: 'turn.started', turnId: p.turnId });
  } else if (method === 'turn/completed' && typeof p.turnId === 'string') {
    const terminalUsage = museUsage(p.usage);
    const usage = terminalUsage ?? state.usage.get(p.turnId);
    const byTurn = new Map(state.usage);
    if (terminalUsage) {
      byTurn.set(p.turnId, terminalUsage);
      events.push({ type: 'usage.updated', usage: cumulativeUsage(byTurn) });
    }
    events.push({ type: 'turn.completed', turnId: p.turnId,
      stopReason: p.terminal === 'failed' ? 'error' : p.terminal === 'cancelled' ? 'cancelled' : 'end_turn',
      ...(usage ? { usage } : {}) });
    return { state: terminalUsage ? { ...state, usage: byTurn } : state, events };
  } else if (method === 'session/tokenUsage') {
    const usage = museUsage(p.usage);
    if (usage && typeof p.turnId === 'string') {
      if (typeof p.viewCursor === 'string' && state.usageCursors.has(p.viewCursor)) return { state, events };
      const previous = state.usage.get(p.turnId);
      const sum: TokenUsage = { input: (previous?.input ?? 0) + usage.input, output: (previous?.output ?? 0) + usage.output,
        total: (previous?.total ?? 0) + (typeof p.totalTokens === 'number' && p.totalTokens >= 0 ? p.totalTokens : usage.total),
        cacheRead: (previous?.cacheRead ?? 0) + (usage.cacheRead ?? 0), cacheWrite: (previous?.cacheWrite ?? 0) + (usage.cacheWrite ?? 0),
        reasoning: (previous?.reasoning ?? 0) + (usage.reasoning ?? 0) };
      const byTurn = new Map(state.usage); byTurn.set(p.turnId, sum);
      const usageCursors = new Set(state.usageCursors); if (typeof p.viewCursor === 'string') usageCursors.add(p.viewCursor);
      events.push({ type: 'usage.updated', usage: cumulativeUsage(byTurn) });
      return { state: { ...state, usage: byTurn, usageCursors }, events };
    }
  } else if (method === 'session/todoListChanged') {
    const todos = z.array(z.object({ text: z.string(), status: z.string(), activeForm: z.string().optional() })).safeParse(p.items);
    if (todos.success) events.push({ type: 'plan.updated', entries: todos.data.map(t => ({
      content: t.text, status: t.status === 'inProgress' ? 'in_progress' : t.status === 'completed' ? 'completed' : t.status === 'cancelled' ? 'cancelled' : 'pending',
      ...(t.activeForm ? { activeForm: t.activeForm } : {}),
    })) });
  } else if (method === 'item/delta' && typeof p.itemId === 'string' && typeof p.delta === 'string') {
    const item = state.items.get(p.itemId);
    if (!item) return { state, events };
    const part = typeof p.field === 'string' ? /^summary\.(\d+)$/.exec(p.field) : null;
    if (item.kind === 'reasoning' && part && Number(part[1]) < 1024) {
      const index = Number(part[1]); const parts = [...(state.summaries.get(item.id) ?? [])];
      parts[index] = (parts[index] ?? '') + p.delta;
      const text = parts.join('\n\n'); const delta = text.startsWith(item.text) ? text.slice(item.text.length) : p.delta;
      const items = new Map(state.items); items.set(item.id, { ...item, text });
      const summaries = new Map(state.summaries); summaries.set(item.id, parts);
      return { state: { ...state, items, summaries }, events: [{ type: 'item.delta', itemId: item.id, field: 'reasoning', delta }] };
    }
    const field = item.kind === 'tool' ? 'output' : item.kind === 'reasoning' ? 'reasoning' : 'text';
    // args deltas belong to tool input, never the output/text stream.
    if (p.field !== undefined && p.field !== 'text' && p.field !== 'visibleOutput' && p.field !== 'output') return { state, events };
    const updated = item.kind === 'tool' ? { ...item, output: (item.output ?? '') + p.delta } : { ...item, text: item.text + p.delta };
    const items = new Map(state.items); items.set(item.id, updated);
    return { state: { ...state, items }, events: [{ type: 'item.delta', itemId: item.id, field, delta: p.delta }] };
  } else if (method === 'item/started' || method === 'item/updated' || method === 'item/completed') {
    const raw = museItemSchema.safeParse(p.item);
    if (!raw.success) return { state, events };
    const r = raw.data;
    const before = state.items.get(r.itemId);
    let item: UiItem;
    if (r.kind === 'agentMessage' || r.kind === 'reasoning') {
      const text = (r.kind === 'reasoning' && r.summary?.length ? r.summary.join('\n\n') : r.text) ?? (before && before.kind !== 'tool' ? before.text : '');
      item = r.kind === 'reasoning' ? { kind: 'reasoning', id: r.itemId, text } : {
        kind: 'message', id: r.itemId, role: 'assistant', text,
        ...(r.messagePhase ? { phase: r.messagePhase === 'commentary' ? 'commentary' as const : 'final' as const } : {}),
      };
    } else if (r.kind === 'toolCall' || r.kind === 'userShell' || r.kind === 'subagent' || r.kind === 'webSearch') {
      const name = r.tool ?? r.kind;
      let input: unknown = r.commandText ? { command: r.commandText } : undefined;
      if (r.args) { try { input = JSON.parse(r.args); } catch { input = r.args; } }
      const display = toolDisplay(name === 'exec_command' ? 'Bash' : name === 'apply_patch' ? 'Edit' : name, input);
      const diffs = museDiffs(input);
      item = { ...(before?.kind === 'tool' ? before : {}), kind: 'tool', id: r.itemId, name, ...display,
        ...(r.kind === 'subagent' ? { toolKind: 'task' as const } : {}),
        status: r.status === 'inProgress' ? 'running' : r.status === 'completed' ? 'completed' : r.status === 'rejected' ? 'declined' : 'failed',
        input, ...(r.visibleOutput !== undefined ? { output: r.visibleOutput } : {}),
        ...(r.failureReason ? { error: r.failureReason } : {}),
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
        ...(diffs.length ? { diffs } : {}),
      } satisfies UiToolItem;
    } else return { state, events };
    const items = new Map(state.items); items.set(item.id, item);
    const summaries = new Map(state.summaries); if (r.summary) summaries.set(item.id, r.summary);
    const type = method === 'item/started' ? 'item.started' : method === 'item/updated' ? 'item.updated' : 'item.completed';
    return { state: { ...state, items, summaries }, events: [{ type, item }] };
  }
  return { state, events };
}

function cumulativeUsage(turns: ReadonlyMap<string, TokenUsage>): TokenUsage {
  return [...turns.values()].reduce<TokenUsage>((a, b) => ({
    input: a.input + b.input, output: a.output + b.output, total: a.total + b.total,
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0), cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0),
  }), { input: 0, output: 0, total: 0 });
}

/** apply_patch's own input is the diff; no synthetic file contents or guessed patch refs. */
function museDiffs(input: unknown): FileDiff[] {
  const parsed = z.object({ patch: z.string().optional(), input: z.string().optional() }).safeParse(input);
  const patch = typeof input === 'string' ? input : parsed.success ? parsed.data.patch ?? parsed.data.input : undefined;
  if (!patch) return [];
  const files = [...patch.matchAll(/^\*\*\* (Update|Add|Delete) File: (.+)$/gm)];
  const patchEnd = patch.indexOf('*** End Patch');
  return files.map((m, index) => ({ path: m[2] ?? '', oldText: m[1] === 'Add' ? null : '',
    unified: patch.slice(m.index, files[index + 1]?.index ?? (patchEnd >= 0 ? patchEnd : patch.length)).trimEnd(),
  }));
}

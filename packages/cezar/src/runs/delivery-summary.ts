import { readHandoff } from '../handoff.ts';
import type { RunEvent, RunStore } from './store.ts';

const SUMMARY_LIMIT = 16_000;
const CONTROL_LINE = /^\s*CEZ:(?:DONE|MONITORING|ASK\s+.*|PR=\d+|ISSUE=\d+|TITLE=.*|VERDICT(?:=|\s+).*)\s*$/;
const HEARTBEAT = /^(?:- )?\d{4}-\d{2}-\d{2}T\S+ — (?:turn complete|step "|picked from)/;

function clean(text: string): string {
  const value = text.split('\n').filter((line) => !CONTROL_LINE.test(line)).join('\n').trim();
  return value.length <= SUMMARY_LIMIT ? value : `${value.slice(0, SUMMARY_LIMIT)}\n\n[Summary truncated.]`;
}

/** Repeated sections occur in legacy journals; the last nonempty report wins. */
function sections(text: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let header = '';
  let lines: string[] = [];
  let fence = '';
  const save = () => {
    const body = lines.join('\n').trim();
    if (header && body) result.set(header, [...(result.get(header) ?? []), body]);
    lines = [];
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const boundary = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (boundary) {
      if (!fence) fence = boundary;
      else if (boundary[0] === fence[0] && boundary.length >= fence.length) fence = '';
    }
    const heading = !fence ? /^## (.+?)\s*$/.exec(line)?.[1] : undefined;
    if (heading) {
      save();
      header = heading;
    } else lines.push(line);
  }
  save();
  return result;
}

/** Delivery evidence only: never turn the initial Goal or engine timestamps into a result. */
export function deliverySummary(
  handoffText: string,
  readEvents: () => readonly RunEvent[] = () => [],
  options: { task?: string; graphSummary?: string } = {},
): string {
  let journalText = handoffText.replace(/\r\n/g, '\n');
  const task = options.task?.trim().replace(/\r\n/g, '\n');
  const goal = /^## Goal\s*\n\s*/m.exec(journalText);
  // A Markdown task can contain report-shaped headings; it is still input, never evidence.
  if (task && goal) {
    const start = goal.index + goal[0].length;
    if (journalText.slice(start).startsWith(task)) {
      journalText = journalText.slice(0, start) + journalText.slice(start + task.length);
    }
  }
  const journal = sections(journalText);
  const explicit = journal.get('Delivery summary')?.at(-1);
  if (explicit && clean(explicit)) return clean(explicit);

  const resume = clean(journal.get('Resume notes')?.at(-1) ?? '');
  const milestones = (journal.get('Progress log') ?? []).slice().reverse()
    .map((body) => body.split('\n').filter((line) => line.trim() && !HEARTBEAT.test(line.trim())).slice(0, 10).join('\n'))
    .find((body) => body.trim()) ?? '';
  if (resume || milestones) return clean([resume, milestones].filter(Boolean).join('\n\n'));
  if (options.graphSummary?.trim()) return clean(options.graphSummary);

  // All backends persist normalized completed messages; tool output is never a report.
  for (const event of [...readEvents()].reverse()) {
    const item = event.item;
    if (event.type !== 'item.completed' || !item || typeof item !== 'object') continue;
    const message = item as Record<string, unknown>;
    if (message.kind === 'message' && message.role === 'assistant' && typeof message.text === 'string') {
      const report = clean(message.text);
      if (report) return report;
    }
  }
  return '';
}

export function readRunDeliverySummary(dataDir: string, store: RunStore, runId: string): string {
  const run = store.getRun(runId);
  const reports = Object.entries(run?.graphState?.outputs ?? {})
    .flatMap(([id, output]) => typeof output.summary === 'string' && output.summary.trim() ? [{ id, text: clean(output.summary) }] : []);
  const graphSummary = reports.length === 1 ? reports[0]?.text : reports.map(({ id, text }) => `### ${id}\n\n${text}`).join('\n\n');
  return store.redactRunText(runId, deliverySummary(readHandoff(dataDir, runId), () => store.readEvents(runId), { task: run?.task, graphSummary }));
}

/** Substitute once, so report text containing template examples remains literal. */
export function renderDeliveryComment(template: string, render: (token: string) => string, summary: () => string): string | undefined {
  let report: string | undefined;
  let missing = false;
  const body = template.replace(/\{\{[^{}]+\}\}/g, (token) => {
    if (!/^\{\{\s*summary\s*\}\}$/.test(token)) return render(token);
    report ??= summary();
    if (!report.trim()) missing = true;
    return report;
  });
  return missing ? undefined : body;
}

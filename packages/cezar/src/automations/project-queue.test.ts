import { describe, expect, it } from 'vitest';
import { canLaunchProjectAutomation } from './project-queue.ts';

const automation = { automationId: 'ready', automationRevision: 1, receiptId: 'receipt',
  event: 'project.item.status_changed', githubUrl: 'https://github.com/acme/demo/issues/4' };

describe('project automation serialization', () => {
  it('keeps an overdue automatic resume blocked until the run retires its appointment', () => {
    const run = { status: 'failed' as const, automation, autoResumeAt: '2020-01-01T00:00:00.000Z' };
    expect(canLaunchProjectAutomation([run], 'ready')).toBe(false);
    expect(canLaunchProjectAutomation([{ ...run, autoResumeAt: undefined }], 'ready')).toBe(true);
  });

  it('keeps an unanswered failed session blocked until its question is retired', () => {
    const run = { status: 'failed' as const, automation, awaitingAnswerSince: '2026-10-12T00:00:00.000Z' };
    expect(canLaunchProjectAutomation([run], 'ready')).toBe(false);
    expect(canLaunchProjectAutomation([{ ...run, awaitingAnswerSince: undefined }], 'ready')).toBe(true);
  });

  it('does not stall empty queues, terminal runs or a different automation', () => {
    expect(canLaunchProjectAutomation([], 'ready')).toBe(true);
    for (const status of ['done', 'review', 'failed', 'cancelled'] as const) {
      expect(canLaunchProjectAutomation([{ status, automation }], 'ready')).toBe(true);
    }
    expect(canLaunchProjectAutomation([{ status: 'failed', automation, autoResumeAt: '2026-10-12T17:50:30.000Z' }], 'other')).toBe(true);
    expect(canLaunchProjectAutomation([{ status: 'running' }], 'ready')).toBe(true);
  });
});

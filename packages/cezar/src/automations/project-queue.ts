import type { RunRecord } from '../runs/store.ts';

type ProjectQueueRun = Pick<RunRecord, 'status' | 'automation' | 'autoResumeAt' | 'awaitingAnswerSince'>;

/** A failed run can still own unfinished work while awaiting a resume or an answer. */
export function canLaunchProjectAutomation(runs: readonly ProjectQueueRun[], automationId: string): boolean {
  return !runs.some(run => run.automation?.automationId === automationId
    && (['queued', 'running', 'waiting'].includes(run.status)
      || run.autoResumeAt !== undefined || run.awaitingAnswerSince !== undefined));
}

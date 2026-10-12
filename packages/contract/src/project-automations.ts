import { z } from 'zod';

/** Personal and organization Projects are both polled through the authenticated gh CLI. */
export const projectTriggerSchema = z.object({
  url: z.string().regex(/^https:\/\/github\.com\/(users|orgs)\/[A-Za-z0-9][A-Za-z0-9-]*\/projects\/[1-9]\d*(?:\/views\/[1-9]\d*)?\/?$/).refine(value => Number.isSafeInteger(Number(value.match(/\/projects\/([0-9]+)/)?.[1]))),
  targetStatus: z.string().trim().min(1).max(200),
});

export const projectStatusCandidateSchema = z.object({
  eventId: z.string(), event: z.literal('project.item.status_changed'),
  timestamp: z.string().datetime(), tieBreaker: z.string(), repo: z.string(),
  nodeId: z.string(), number: z.number().int().positive(), title: z.string(),
  url: z.string().url(), author: z.string(), assignees: z.array(z.string()), labels: z.array(z.string()),
  projectItemId: z.string(),
});

/** The pending queue is checkpointed before launch; receipts survive a restart during launch. */
export const projectPollStateSchema = z.object({
  source: z.string(), boardId: z.string(), statusFieldId: z.string(), statusOptionId: z.string(),
  generation: z.string(), sequence: z.number().int().nonnegative(),
  statuses: z.record(z.string(), z.string().nullable()),
  pending: z.array(projectStatusCandidateSchema),
});

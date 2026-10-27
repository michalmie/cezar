import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { projectTriggerSchema } from '@open-mercato/cezar-contract';
import { ghEnv } from '../core/gh-env.ts';
import { matchesFilters, type GithubCandidate, type GithubPollResult, type GithubPollerOptions } from './github-poller.ts';
import type { AutomationRuntimeState, GithubAutomationDefinition } from './types.ts';

// The injected `run` applies ghEnv at its real spawn site (GithubPoller); this reference pins
// that contract for the call-site enforcement test in core/gh-env.test.ts.
void ghEnv;

const pageInfo = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const connection = <T extends z.ZodType>(node: T) => z.object({ nodes: z.array(node), pageInfo });
const fieldSchema = z.object({ id: z.string(), name: z.string(), options: z.array(z.object({ id: z.string(), name: z.string() })) });
const itemSchema = z.object({
  id: z.string(), isArchived: z.boolean(),
  fieldValueByName: z.object({ optionId: z.string().nullable(), field: z.object({ id: z.string() }) }).nullable(),
  content: z.union([
    z.object({ __typename: z.literal('Issue'), id: z.string(), number: z.number().int().positive(),
      title: z.string(), url: z.string().url(), state: z.enum(['OPEN', 'CLOSED']),
      repository: z.object({ nameWithOwner: z.string() }), author: z.object({ login: z.string() }).nullable(),
      assignees: connection(z.object({ login: z.string() })), labels: connection(z.object({ name: z.string() })),
    }), z.object({ __typename: z.enum(['PullRequest', 'DraftIssue']) }),
  ]).nullable(),
});

/** Never checkpoint a partial board. A missing page, GraphQL error or ceiling fails closed. */
export async function pollGithubProject(
  run: NonNullable<GithubPollerOptions['run']>, owner: string, repo: string,
  definition: GithubAutomationDefinition, previous?: AutomationRuntimeState['projectPoll'],
): Promise<GithubPollResult> {
  const trigger = projectTriggerSchema.parse(definition.projectTrigger);
  const match = new URL(trigger.url).pathname.match(/^\/(users|orgs)\/([^/]+)\/projects\/(\d+)/)!;
  const url = `https://github.com/${match[1]}/${match[2]}/projects/${match[3]}`;
  const repository = `${owner}/${repo}`;
  const source = JSON.stringify([url, trigger.targetStatus, repository.toLowerCase()]);
  const graphql = async (query: string, variables: Record<string, string | number | null>) => {
    const args = ['api', '--hostname', 'github.com', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) if (value !== null) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    const raw = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() }).parse(JSON.parse(await run('gh', args)));
    if (raw.errors?.length || !raw.data) throw new Error('GitHub returned an incomplete Projects response');
    return raw.data;
  };
  let pages = 0;
  const cursors = new Set<string>();
  const next = (info: z.infer<typeof pageInfo>) => {
    if (++pages > 100) throw new Error('Project exceeds the 100-page polling ceiling; narrow the board');
    if (!info.hasNextPage) return null;
    if (!info.endCursor || cursors.has(info.endCursor)) throw new Error('Incomplete or repeated Project pagination cursor');
    cursors.add(info.endCursor);
    return info.endCursor;
  };
  let cursor: string | null = null;
  let boardId = '';
  const fields: z.infer<typeof fieldSchema>[] = [];
  do {
    const data = await graphql(`query($owner:String!,$number:Int!,$cursor:String) { owner:${match[1] === 'users' ? 'user' : 'organization'}(login:$owner) { projectV2(number:$number) { id url closed fields(first:100,after:$cursor) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } pageInfo { hasNextPage endCursor } } } } }`, { owner: match[2]!, number: Number(match[3]), cursor });
    const board = z.object({ owner: z.object({ projectV2: z.object({ id: z.string(), url: z.string(), closed: z.boolean(), fields: connection(z.union([fieldSchema, z.object({})])) }) }) }).parse(data).owner.projectV2;
    if (board.closed || board.url !== url || boardId && boardId !== board.id) throw new Error('Project is closed or its identity changed');
    boardId = board.id;
    fields.push(...board.fields.nodes.filter((field): field is z.infer<typeof fieldSchema> => 'options' in field));
    cursor = next(board.fields.pageInfo);
  } while (cursor);
  const statuses = fields.filter(field => field.name === 'Status');
  const status = statuses[0];
  const options = status?.options.filter(option => option.name === trigger.targetStatus) ?? [];
  if (statuses.length !== 1 || options.length !== 1) throw new Error(`Project needs one Status field with the exact ${trigger.targetStatus} option`);
  const option = options[0]!;
  const prior = previous?.source === source ? previous : undefined;
  if (prior && (prior.boardId !== boardId || prior.statusFieldId !== status!.id || prior.statusOptionId !== option.id)) throw new Error('Project Status identity changed; pause and enable the automation to establish a new baseline');
  const items: z.infer<typeof itemSchema>[] = [];
  cursors.clear();
  do {
    const data = await graphql(`query($id:ID!,$cursor:String) { node(id:$id) { ... on ProjectV2 { items(first:100,after:$cursor) { nodes { id isArchived content { __typename ... on Issue { id number title url state repository { nameWithOwner } author { login } assignees(first:100) { nodes { login } pageInfo { hasNextPage endCursor } } labels(first:100) { nodes { name } pageInfo { hasNextPage endCursor } } } } fieldValueByName(name:"Status") { ... on ProjectV2ItemFieldSingleSelectValue { optionId field { ... on ProjectV2SingleSelectField { id } } } } } pageInfo { hasNextPage endCursor } } } } }`, { id: boardId, cursor });
    const page = z.object({ node: z.object({ items: connection(itemSchema) }) }).parse(data).node.items;
    items.push(...page.nodes);
    cursor = next(page.pageInfo);
  } while (cursor);
  const statusesNow = Object.fromEntries(items.map(item => [item.id, item.fieldValueByName?.field.id === status!.id ? item.fieldValueByName.optionId : null]));
  const projectPoll: NonNullable<AutomationRuntimeState['projectPoll']> = {
    source, boardId, statusFieldId: status!.id, statusOptionId: option.id,
    generation: prior?.generation ?? randomUUID(), sequence: prior?.sequence ?? 0,
    statuses: statusesNow, pending: [],
  };
  const pending = new Map(prior?.pending.map(candidate => [candidate.projectItemId, candidate]) ?? []);
  for (const item of items) {
    const issue = item.content;
    if (item.isArchived || issue?.__typename !== 'Issue' || issue.state !== 'OPEN'
      || issue.repository.nameWithOwner.toLowerCase() !== repository.toLowerCase() || statusesNow[item.id] !== option.id) continue;
    if (issue.labels.pageInfo.hasNextPage || issue.assignees.pageInfo.hasNextPage) throw new Error('Issue labels or assignees exceed the polling ceiling');
    const existing = pending.get(item.id);
    // The first complete observation establishes a baseline; existing Ready items never fire.
    if (!existing && (!prior || prior.statuses[item.id] === option.id)) continue;
    const eventId = existing?.eventId ?? `project-status:${boardId}:${projectPoll.generation}:${++projectPoll.sequence}`;
    const candidate = {
      eventId, event: 'project.item.status_changed' as const,
      timestamp: existing?.timestamp ?? new Date().toISOString(), tieBreaker: eventId,
      repo: repository, nodeId: issue.id, number: issue.number, title: issue.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 500),
      url: issue.url, author: issue.author?.login ?? '',
      assignees: issue.assignees.nodes.map(row => row.login), labels: issue.labels.nodes.map(row => row.name), projectItemId: item.id,
    };
    if (issue.url.toLowerCase() !== `https://github.com/${repository}/issues/${issue.number}`.toLowerCase()) throw new Error('Issue URL does not match the configured repository');
    if (matchesFilters(candidate, definition)) projectPoll.pending.push(candidate);
  }
  projectPoll.pending.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId));
  const candidates: GithubCandidate[] = projectPoll.pending.slice(0, definition.filters.maxRecords);
  return { candidates, projectPoll, pages, truncated: projectPoll.pending.length > candidates.length };
}

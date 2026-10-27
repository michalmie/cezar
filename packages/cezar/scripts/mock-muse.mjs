#!/usr/bin/env node
// Offline MSP v1 peer for CEZ_DRY_RUN and runner lifecycle tests (Muse 1.4.13 schema).
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('Muse Code 1.4.13 (mock)'); process.exit(0); }
if (args.includes('usage')) { console.log(JSON.stringify({ schemaVersion: 1, reason: 'api_key', allowance: null })); process.exit(0); }
let sessionId;
let turnQueue = Promise.resolve();
let approvalSettled;
let approval;
let inputCancelled = false;
let modelReady = true;
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const notify = (method, params) => send({ method, params: { sessionId, ...params } });
const session = () => ({ sessionId, modelId: 'muse-test' });
const commandMethods = new Set(['session/start', 'session/resume', 'session/setApprovalMode', 'session/setModel', 'turn/start', 'approval/decide', 'userInput/cancel']);
createInterface({ input: process.stdin }).on('line', line => {
  const r = JSON.parse(line);
  if (process.env.CEZ_MUSE_WIRE_LOG) appendFileSync(process.env.CEZ_MUSE_WIRE_LOG, line + '\n');
  if (r.id === undefined) return;
  if (r.method === undefined) {
    if (r.error) { console.error('Unanswered MSP server request'); process.exit(1); }
    return;
  }
  if (commandMethods.has(r.method) && !/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(r.params.commandId)) {
    send({ id: r.id, error: { code: -32602, message: 'expected UUIDv7 commandId' } }); return;
  }
  if (r.method === 'initialize') send({ id: r.id, result: { schema: { version: 1 } } });
  else if (r.method === 'model/list') send({ id: r.id, result: { models: [{ modelId: 'muse-test', displayLabel: 'Muse test', description: 'Offline test model' }] } });
  else if (r.method === 'session/start' || r.method === 'session/resume') {
    if (r.method === 'session/start' && r.params.sessionId && r.params.sessionId[14] !== '7') {
      send({ id: r.id, error: { code: -32602, message: 'sessionId must be UUIDv7' } }); return;
    }
    sessionId = r.params.sessionId ?? r.params.commandId;
    if (r.method === 'session/resume' && process.env.CEZ_MUSE_DELAY_MODEL === '1') modelReady = false;
    send({ id: r.id, result: { session: session(), viewCursor: 'v1' } });
    if (r.method === 'session/resume' && process.env.CEZ_MUSE_PENDING_INPUT === '1') {
      const params = { sessionId, userInputId: 'pending-input' };
      send({ id: 'server-input', method: 'userInput/request', params });
      notify('userInput/requested', params);
    }
  } else if (r.method === 'turn/start') {
    if (!modelReady) { send({ id: r.id, error: { code: -32000, message: 'Turn arrived before model was ready' } }); return; }
    const turnId = r.params.commandId;
    send({ id: r.id, result: { turnId, status: 'accepted', startedNewTurn: true } });
    turnQueue = turnQueue.then(async () => {
    notify('turn/started', { turnId });
    const text = r.params.input.filter(p => p.type === 'text').map(p => p.text).join('\n');
    // Echo the task without replaying Cezar's own orchestration markers into the cockpit.
    const replyText = process.env.CEZ_TASK_ID ? text.split('\n\n---\n\n').at(-1) : text;
    if (text.includes('MOCK_HANG')) return new Promise(() => {});
    if (text.includes('MOCK_SLOW')) await new Promise(resolve => setTimeout(resolve, 500));
    if (text.includes('MOCK_FAIL')) { notify('turn/completed', { turnId, terminal: 'failed', error: { message: 'Muse test failure' } }); return; }
    if (text.includes('MOCK_APPROVAL')) {
      approval = { sessionId, approvalId: 'a', currentRequirementId: { approvalId: 'a', sourceIndex: 0 }, availableChoices: [{ choiceId: 'yes', decision: 'approved', scope: 'once' }] };
      const settled = new Promise(resolve => { approvalSettled = resolve; });
      send({ id: 'server-approval', method: 'approval/request', params: approval });
      notify('approval/requested', approval);
      await settled;
    }
    const item = { itemId: randomUUID(), kind: 'agentMessage', status: 'inProgress', revision: 1, text: '' };
    notify('item/started', { item });
    notify('item/delta', { itemId: item.itemId, field: 'text', delta: `Muse: ${replyText}` });
    notify('item/completed', { item: { ...item, status: 'completed', revision: 2, messagePhase: 'finalAnswer', text: `Muse: ${replyText}` } });
    notify('session/tokenUsage', { turnId, usage: { inputTokens: 11, outputTokens: 7, cachedTokens: 2, reasoningTokens: 1 } });
    notify('turn/completed', { turnId, terminal: 'completed' });
    });
  } else {
    // The real host requires a ModelSelection object; a bare modelId is invalid params.
    if (r.method === 'session/setModel' && typeof r.params.model?.modelId !== 'string') {
      send({ id: r.id, error: { code: -32602, message: 'session/setModel invalid params: missing field \'model\'' } }); return;
    }
    if (r.method === 'session/setModel' && process.env.CEZ_MUSE_DELAY_MODEL === '1') {
      setTimeout(() => { modelReady = true; send({ id: r.id, result: {} }); }, 150); return;
    }
    if (r.method === 'userInput/cancel') {
      if (inputCancelled) { send({ id: r.id, error: { code: -32000, message: 'userInputAlreadySettled' } }); return; }
      inputCancelled = true;
    }
    if (r.method === 'approval/decide' && r.params.requirementId.sourceIndex === 0) {
      send({ id: r.id, result: { terminal: false } });
      approval = { ...approval, currentRequirementId: { approvalId: 'a', sourceIndex: 1 } };
      notify('approval/updated', approval);
      send({ id: 'server-approval-2', method: 'approval/request', params: approval });
      return;
    }
    send({ id: r.id, result: {} });
    if (r.method === 'approval/decide') approvalSettled?.();
  }
}).on('close', () => process.exit(0));

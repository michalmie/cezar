import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { isViewableImageMediaType } from '@open-mercato/cezar-contract';
import { AcpClient, type AcpMessage } from './acp-client.ts';
import { buildChildEnv } from './agent-env.ts';
import { isSignalTerminationExit, prependSystemPrompt, trackChildExit,
  type AgentEvent, type AgentRunResult, type AgentRunSpec, type AgentRunner,
  type AgentSession, type AgentToolCallRecord, type ContentBlock, type SessionOptions } from './agent-runner.ts';
import { disclaimedCommand } from './disclaim-spawn.ts';
import { museCommandId, museFrameSchema, museSessionSchema } from './muse-protocol.ts';
import { createMuseUiState, mapMuseFrame } from './muse-ui-mapper.ts';
import { V1TextCoalescer } from './v1-text-coalescer.ts';
import type { UiEvent } from './ui-events.ts';

export function resolveMuseBin(override?: string): string {
  return override ?? process.env.CEZ_MUSE_BIN ?? (process.env.CEZ_DRY_RUN === '1'
    ? fileURLToPath(new URL('../../scripts/mock-muse.mjs', import.meta.url)) : 'muse');
}

/** Persistent MSP host; the existing JSON-RPC transport is shared, ACP methods are never used. */
export class MuseRunner implements AgentRunner {
  readonly backend = 'muse' as const;
  private lastSession?: AgentSession;
  constructor(private readonly options: { bin?: string; timeoutMs?: number } = {}) {}
  run(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void): Promise<AgentRunResult> {
    return this.startSession(spec, onEvent, { autoEndAfterFirstTurn: true }).result;
  }
  async interrupt(): Promise<void> { this.lastSession?.interrupt(); }
  startSession(spec: AgentRunSpec, onEvent?: (event: AgentEvent) => void, opts: SessionOptions = {}): AgentSession {
    const session = new MuseSession(resolveMuseBin(this.options.bin), spec, onEvent, opts, this.options.timeoutMs);
    this.lastSession = session;
    return session;
  }
}

class MuseSession implements AgentSession {
  readonly result: Promise<AgentRunResult>;
  readonly pid?: number;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rpc: AcpClient;
  private readonly hasExited: () => boolean;
  private isOpen = true;
  private stopped = false;
  private timedOut = false;
  private failure?: string;
  private sessionId?: string;
  private ready = false;
  private ui = createMuseUiState();
  private readonly queue: ContentBlock[][] = [];
  private sending = false;
  private readonly outstandingTurns = new Set<string>();
  private turnsCompleted = 0;
  private readonly answeredApprovals = new Set<string>();
  private readonly cancelledInputs = new Set<string>();
  private readonly pendingControls: AcpMessage[] = [];
  private readonly text: string[] = [];
  private readonly tools: AgentToolCallRecord[] = [];
  private readonly toolIds = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly turnUsage = new Map<string, number>();
  private readonly coalescer: V1TextCoalescer;
  private stderr = '';
  private readonly timers: NodeJS.Timeout[] = [];
  private autoEndTimer?: NodeJS.Timeout;
  private deadline?: NodeJS.Timeout;

  constructor(bin: string, private readonly spec: AgentRunSpec,
    private readonly onEvent: ((event: AgentEvent) => void) | undefined,
    private readonly opts: SessionOptions, timeoutMs = 30 * 60_000) {
    const env = buildChildEnv({ backend: 'muse', extraEnv: spec.env });
    const [file, args] = disclaimedCommand(bin, ['serve', '--disable-request-user-input', ...(spec.model ? ['--model', spec.model] : [])], env);
    this.child = spawn(file, args, { cwd: spec.cwd, env });
    this.pid = this.child.pid;
    this.hasExited = trackChildExit(this.child);
    this.coalescer = new V1TextCoalescer(text => { this.text.push(text); this.emit({ type: 'text', text }); });
    this.child.on('error', (error: NodeJS.ErrnoException) => {
      this.failure = error.code === 'ENOENT'
        ? `Muse Code executable ${bin} was not found. Install Muse Code from https://dev.meta.ai/docs/muse-code and run muse login.` : error.message;
    });
    this.child.stdin.on('error', () => { /* close owns process settlement */ });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr = (this.stderr + chunk).slice(-8_192); });
    this.rpc = new AcpClient(this.child.stdin, this.child.stdout, {
      onNotification: frame => this.notification(frame),
      onRequest: frame => {
        if (frame.method !== 'approval/request' && frame.method !== 'userInput/request') return { error: { code: -32601, message: 'Unsupported Muse request' } };
        const method = frame.method === 'approval/request' ? 'approval/requested' : 'userInput/requested';
        const control = { ...frame, method };
        if (this.sessionId) this.notification(control); else this.pendingControls.push(control);
        return { result: {} };
      },
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      this.child.once('close', (code, signal) => { this.rpc.close('Muse host closed'); resolve({ code, signal }); });
    });
    const reading = this.rpc.run().catch(error => this.fail(error));
    this.queue.push([...(spec.images ?? []), { type: 'text', text: prependSystemPrompt(spec.systemPrompt, spec.userPrompt) }]);
    void this.initialize().catch(error => { if (this.isOpen) this.fail(error); });
    const limit = spec.timeoutMs ?? timeoutMs;
    if (limit > 0) this.deadline = this.later(() => { this.timedOut = true; this.interrupt(); }, limit);
    this.result = closed.then(async ({ code, signal }) => {
      await reading;
      this.isOpen = false;
      for (const timer of this.timers) clearTimeout(timer);
      if (this.autoEndTimer) clearTimeout(this.autoEndTimer);
      this.coalescer.flush();
      if (this.timedOut) this.failure = 'Muse Code run timed out';
      if (!this.failure && !(this.stopped && (signal || isSignalTerminationExit(code)))) {
        if (code !== 0 || !this.stopped) this.failure = `Muse Code host exited unexpectedly (${code ?? signal})${this.stderr.trim() ? `: ${this.stderr.trim().slice(-500)}` : ''}`;
      }
      if (this.failure) {
        this.emit({ type: 'error', message: this.failure });
        this.opts.onUiEvent?.({ type: 'session.error', fatal: true, message: this.failure });
      }
      this.opts.onUiEvent?.({ type: 'session.ended', reason: this.timedOut ? 'timeout' : this.failure ? 'error' : 'end_turn' });
      if (this.failure) throw new Error(this.failure);
      this.emit({ type: 'done' });
      return { text: this.text.join('\n'), toolCalls: this.tools, tokensUsed: this.tokensUsed(), sessionId: this.sessionId };
    });
  }

  get open(): boolean { return this.isOpen; }
  sendMessage(content: ContentBlock[]): boolean {
    if (!this.isOpen) return false;
    if (this.autoEndTimer) { clearTimeout(this.autoEndTimer); this.autoEndTimer = undefined; }
    this.queue.push(content);
    void this.drain().catch(error => { if (this.isOpen) this.fail(error); });
    return true;
  }
  end(): void {
    if (!this.isOpen) return;
    this.isOpen = false; this.stopped = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.child.stdin.end();
    this.later(() => { if (!this.hasExited()) this.child.kill('SIGTERM'); }, 1_000);
    this.later(() => { if (!this.hasExited()) this.child.kill('SIGKILL'); }, 11_000);
  }
  interrupt(): void {
    if (!this.isOpen) return;
    this.isOpen = false; this.stopped = true;
    if (this.deadline) clearTimeout(this.deadline);
    this.child.kill('SIGTERM');
    this.later(() => { if (!this.hasExited()) this.child.kill('SIGKILL'); }, 10_000);
  }

  private request(method: string, params: unknown): Promise<Record<string, unknown>> {
    return this.rpc.request(method, params, { timeoutMs: 30_000 });
  }
  private async initialize(): Promise<void> {
    const hello = await this.request('initialize', { clientInfo: { name: 'cezar', version: '1' }, capabilities: { userInputDialogs: false } });
    const schema = z.object({ schema: z.object({ version: z.number() }) }).parse(hello);
    if (schema.schema.version !== 1) throw new Error(`Unsupported Muse session protocol ${schema.schema.version}`);
    this.rpc.notify('initialized', {});
    if (!this.isOpen) return;
    const response = this.spec.resume && this.spec.sessionId
      ? await this.request('session/resume', { commandId: museCommandId(), sessionId: this.spec.sessionId, excludeItems: true })
      : await this.request('session/start', { commandId: museCommandId(), workspaceRoot: this.spec.cwd,
        ...(this.spec.additionalDirectories?.length ? { workspaceRoots: [this.spec.cwd, ...this.spec.additionalDirectories] } : {}),
        // Cezar pre-mints v4 ids; Muse requires v7 and supplies its own native id.
        approvalMode: 'allowAll',
        ...(this.spec.model ? { modelId: this.spec.model } : {}),
      });
    this.sessionId = museSessionSchema.parse(response).session.sessionId;
    for (const frame of this.pendingControls.splice(0)) this.notification(frame);
    // Resume restores the native session policy; explicitly reapply Cezar's unattended posture.
    if (this.spec.resume) await this.request('session/setApprovalMode', {
      sessionId: this.sessionId, commandId: museCommandId(), mode: 'allowAll',
    });
    if (this.spec.resume && this.spec.model) await this.request('session/setModel', {
      sessionId: this.sessionId, commandId: museCommandId(), model: { modelId: this.spec.model },
    });
    this.ready = true;
    this.emit({ type: 'session', sessionId: this.sessionId });
    this.opts.onUiEvent?.({ type: 'session.started', backend: 'muse', sessionId: this.sessionId, cwd: this.spec.cwd, ...(this.spec.model ? { model: this.spec.model } : {}) });
    await this.drain();
  }
  private async drain(): Promise<void> {
    if (!this.ready || !this.sessionId || this.sending) return;
    this.sending = true;
    try {
      while (this.isOpen && this.queue.length) {
        const content = this.queue.shift();
        if (!content) continue;
        // An image subtype the model cannot view (an ICO favicon, an SVG) must never reach
        // `turn/start`: the provider answers 400 and the whole run fails. The engine demotes
        // those to file paths before they get here; this holds back any that arrive anyway.
        const sendable = content.filter(block => block.type !== 'image' || isViewableImageMediaType(block.source.media_type));
        if (sendable.length < content.length) {
          const kinds = [...new Set(content.flatMap(block =>
            block.type === 'image' && !isViewableImageMediaType(block.source.media_type) ? [block.source.media_type] : []))].join(', ');
          this.emit({ type: 'note', message: `Skipped ${content.length - sendable.length} attached image${content.length - sendable.length > 1 ? 's' : ''} the model cannot display (${kinds}).` });
        }
        if (!sendable.length) continue;
        const commandId = museCommandId();
        this.outstandingTurns.add(commandId);
        const response = await this.request('turn/start', { sessionId: this.sessionId, commandId, ifBusy: 'queue',
          input: sendable.map(block => block.type === 'text' ? { type: 'text', text: block.text } : {
            type: 'image', base64Data: block.source.data, mediaType: block.source.media_type,
          }),
        });
        if (typeof response.turnId === 'string' && response.turnId !== commandId && this.outstandingTurns.delete(commandId)) {
          this.outstandingTurns.add(response.turnId);
        }
      }
    } finally { this.sending = false; this.maybeAutoEnd(); }
  }
  private notification(frame: AcpMessage): void {
    const parsed = museFrameSchema.safeParse(frame);
    if (!parsed.success || parsed.data.params.sessionId !== this.sessionId) return;
    const { method, params: p } = parsed.data;
    if (method === 'turn/completed' && typeof p.turnId === 'string') this.outstandingTurns.delete(p.turnId);
    const mapped = mapMuseFrame(frame, this.ui); this.ui = mapped.state;
    for (const event of mapped.events) { this.opts.onUiEvent?.(event); this.v1(event); }
    if (method === 'approval/requested' || method === 'approval/updated') {
      const request = z.object({ approvalId: z.string(), currentRequirementId: z.object({ approvalId: z.string(), sourceIndex: z.number().int().nonnegative() }),
        availableChoices: z.array(z.object({ choiceId: z.string(), decision: z.string(), scope: z.string() })),
      }).safeParse(p);
      const choice = request.success ? request.data.availableChoices.find(c => c.decision === 'approved' && c.scope === 'once') : undefined;
      if (!request.success || !choice) {
        this.fail(new Error('Muse Code requested an approval Cezar cannot answer. Resume the session in Muse.'));
      } else {
        const key = `${request.data.approvalId}:${request.data.currentRequirementId.sourceIndex}`;
        if (this.answeredApprovals.has(key)) return;
        this.answeredApprovals.add(key);
        this.emit({ type: 'note', message: 'Muse Code requested tool approval; allowing this call for the unattended run.' });
        void this.request('approval/decide', { sessionId: this.sessionId, commandId: museCommandId(),
          approvalId: request.data.approvalId, requirementId: request.data.currentRequirementId, choiceId: choice.choiceId,
        }).catch(error => this.fail(error));
      }
    } else if (method === 'userInput/requested' && typeof p.userInputId === 'string') {
      if (this.cancelledInputs.has(p.userInputId)) return;
      this.cancelledInputs.add(p.userInputId);
      void this.request('userInput/cancel', { sessionId: this.sessionId, commandId: museCommandId(), userInputId: p.userInputId,
        reason: 'Cezar follow-ups arrive as conversation messages.' }).catch(error => this.fail(error));
    } else if (method === 'turn/completed') {
      this.coalescer.flush();
      if (p.terminal === 'failed') {
        const error = z.object({ message: z.string() }).safeParse(p.error);
        this.fail(new Error(error.success ? error.data.message : typeof p.reason === 'string' ? p.reason : 'Muse Code turn failed'));
      } else {
        this.turnsCompleted++;
        this.emit({ type: 'turn-end' });
        this.maybeAutoEnd();
      }
    }
  }
  private v1(event: UiEvent): void {
    if (event.type === 'item.delta' && event.field === 'text') this.coalescer.append(event.itemId, event.delta);
    if (event.type === 'item.completed' && event.item.kind === 'message' && event.item.role === 'assistant') this.coalescer.complete(event.item.id, event.item.text);
    if ((event.type === 'item.started' || event.type === 'item.completed') && event.item.kind === 'tool') {
      const item = event.item;
      if (!this.toolIds.has(item.id)) {
        this.toolIds.add(item.id); this.tools.push({ id: item.id, name: item.name, input: item.input });
        this.emit({ type: 'tool-call', id: item.id, tool: item.name, input: item.input });
      }
      if (event.type === 'item.completed' && !this.completedTools.has(item.id)) {
        this.completedTools.add(item.id);
        this.emit({ type: 'tool-result', toolCallId: item.id, result: item.output ?? item.error ?? '', isError: item.status !== 'completed' });
      }
    }
    if (event.type === 'turn.completed' && event.usage) {
      this.turnUsage.set(event.turnId, event.usage.total); this.emit({ type: 'token-usage', tokensUsed: this.tokensUsed() });
    }
  }
  private tokensUsed(): number { return [...this.turnUsage.values()].reduce((a, b) => a + b, 0); }
  private maybeAutoEnd(): void {
    if (this.opts.autoEndAfterFirstTurn && this.isOpen && this.turnsCompleted > 0 && !this.queue.length && !this.outstandingTurns.size && !this.sending && !this.autoEndTimer) {
      this.autoEndTimer = setTimeout(() => this.end(), 250);
    }
  }
  private emit(event: AgentEvent): void { this.onEvent?.(event); }
  private fail(error: unknown): void {
    this.failure ??= error instanceof Error ? error.message : String(error);
    this.interrupt();
  }
  private later(fn: () => void, ms: number): NodeJS.Timeout { const timer = setTimeout(fn, ms); timer.unref(); this.timers.push(timer); return timer; }
}

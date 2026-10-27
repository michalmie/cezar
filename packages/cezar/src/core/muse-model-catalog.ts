import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AcpClient } from './acp-client.ts';
import { buildChildEnv } from './agent-env.ts';
import { trackChildExit } from './agent-runner.ts';
import { resolveMuseBin } from './muse-runner.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const catalogSchema = z.object({ models: z.array(z.object({
  modelId: z.string().min(1), displayLabel: z.string(), description: z.string().nullable(),
})) });

/** The native catalog needs no session and spends no model tokens. */
export async function discoverMuseModels(options: { bin?: string; cwd?: string; timeoutMs?: number } = {}): Promise<ModelOption[]> {
  const child = spawn(resolveMuseBin(options.bin), ['serve'], { cwd: options.cwd, env: buildChildEnv({ backend: 'muse' }) });
  const hasExited = trackChildExit(child);
  child.stdin.on('error', () => undefined);
  child.stderr.resume();
  const rpc = new AcpClient(child.stdin, child.stdout);
  const reading = rpc.run();
  child.on('error', error => rpc.close(error.message));
  child.once('exit', () => rpc.close('Muse host exited'));
  const timeout = options.timeoutMs ?? 10_000;
  try {
    await rpc.request('initialize', { clientInfo: { name: 'cezar_model_catalog', version: '1' } }, { timeoutMs: timeout });
    rpc.notify('initialized', {});
    const response = await rpc.request('model/list', {}, { timeoutMs: timeout });
    return catalogSchema.parse(response).models.map(m => ({ id: m.modelId, label: m.displayLabel, description: m.description ?? '' }));
  } finally {
    rpc.close('Muse discovery complete');
    child.stdin.end();
    const kill = setTimeout(() => { if (!hasExited()) child.kill('SIGKILL'); }, 1_000);
    kill.unref();
    child.once('close', () => clearTimeout(kill));
    void reading.catch(() => undefined);
  }
}

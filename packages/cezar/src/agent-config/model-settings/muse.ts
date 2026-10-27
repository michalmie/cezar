import type { AgentModelSettingsStrategy } from './types.ts';

/** With no Cezar override, the Muse host reads its own native model configuration. */
export const museModelSettingsStrategy: AgentModelSettingsStrategy = {
  runner: 'muse',
  async read() { return {}; },
};

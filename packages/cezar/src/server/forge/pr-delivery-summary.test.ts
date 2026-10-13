import { describe, expect, it } from 'vitest';
import { buildPrBody } from './github.ts';

const TASK = 'Pick one Ready issue and follow the generic automation instructions.';

describe('PR delivery summary', () => {
  it('leads with delivered behavior, validation and limitations instead of the starting prompt', () => {
    const handoff = `# Handoff\n\n## Goal\n\n${TASK}\n\n## Progress log\n\n- 2026-10-12T13:07:18Z — step "task" complete — status=done\n\n## Delivery summary\n\nImplemented price-history recording and storefront display.\n\n### Validation\n\n73 backend tests passed; live database checks were not run.\n\n### Limitations\n\nWording awaits review.\n\n## Resume notes\n\n`;
    const body = buildPrBody(handoff, TASK);
    expect(body).toMatch(/^## Summary\n\nImplemented price-history/);
    expect(body).toContain('73 backend tests passed');
    expect(body).toContain('live database checks were not run');
    expect(body).toContain('Wording awaits review');
    expect(body).not.toContain(TASK);
    expect(body).not.toContain('status=done');
  });

  it('uses the latest nonempty resume notes in older journals with repeated headings', () => {
    const handoff = `## Goal\n${TASK}\n## Progress log\n- 2026-10-12T13:07:18Z — turn complete — goal achieved, session closed\n## Resume notes\n\n## Resume notes\nBackend only; display deferred.\n## Progress log\n- 2026-10-12 — Added display; 73 tests passed.\n## Resume notes\nBackend and storefront display delivered. Live demo pending.\n`;
    const body = buildPrBody(handoff, TASK);
    expect(body).toContain('Backend and storefront display delivered. Live demo pending.');
    expect(body).toContain('73 tests passed');
    expect(body).not.toContain('display deferred');
    expect(body).not.toContain('goal achieved, session closed');
    expect(body).not.toContain(TASK);
  });

  it('finds agent milestones beneath engine heartbeats', () => {
    const heartbeats = Array.from({ length: 20 }, () => '- 2026-10-12T13:07:18Z — turn complete — status=running').join('\n');
    const body = buildPrBody(`## Goal\n${TASK}\n## Progress log\n${heartbeats}\n- Added read endpoint; tests passed.\n## Resume notes\n`, TASK);
    expect(body).toContain('Added read endpoint; tests passed.');
    expect(body).not.toContain('status=running');
  });

  it('keeps publishing available when no delivery report was recorded', () => {
    const body = buildPrBody('', 'Implement price history');
    expect(body).toContain('No delivery summary was recorded');
    expect(body).toContain('Implement price history');
    expect(body).toContain('🤖 made with cezar');
  });
});

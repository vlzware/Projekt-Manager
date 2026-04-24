import { describe, expect, it } from 'vitest';
import { buildBulkZipFileName } from '../services/BulkDownloadOrchestrator.js';

describe('buildBulkZipFileName', () => {
  const at = new Date('2026-04-23T14:07:00');

  it('slugifies the project title and appends a timestamp', () => {
    const name = buildBulkZipFileName('P-2026-001', 'Schornsteinsanierung', at);
    expect(name).toBe('P-2026-001-Schornsteinsanierung-2026-04-23-1407.zip');
  });

  it('transliterates German umlauts and ß to ASCII', () => {
    const name = buildBulkZipFileName('P-2026-002', 'Dachdecker für Bäckerei Groß', at);
    // ä→ae, ü→ue, ß→ss; spaces collapse to underscores.
    expect(name).toBe('P-2026-002-Dachdecker_fuer_Baeckerei_Gross-2026-04-23-1407.zip');
  });

  it('collapses filesystem-unsafe characters and trims underscores', () => {
    const name = buildBulkZipFileName('X/1', 'A:B*C?"D<E>F|G\\H', at);
    expect(name).toBe('X_1-A_B_C_D_E_F_G_H-2026-04-23-1407.zip');
  });

  it('falls back when the title yields an empty slug', () => {
    const name = buildBulkZipFileName('P-2026-003', '///???', at);
    expect(name).toBe('P-2026-003-projekt-2026-04-23-1407.zip');
  });

  it('truncates very long titles to keep the filename bounded', () => {
    const longTitle = 'A'.repeat(200);
    const name = buildBulkZipFileName('P-001', longTitle, at);
    // Slug is capped at 64 chars; the rest of the filename is fixed.
    expect(name.length).toBeLessThanOrEqual('P-001-'.length + 64 + '-2026-04-23-1407.zip'.length);
  });

  it('zero-pads month, day, hour, and minute', () => {
    const earlyAt = new Date('2026-01-02T03:04:00');
    const name = buildBulkZipFileName('N-1', 'x', earlyAt);
    expect(name).toBe('N-1-x-2026-01-02-0304.zip');
  });
});

import { describe, it, expect } from 'vitest';
import { getAgingText, isAgingBold, getDaysInState } from '../aging';

describe('aging calculation', () => {
  // UT-1: Returns correct "seit X Tagen" for a buffer project exceeding threshold
  it('UT-1: returns "seit X Tagen" for buffer project exceeding threshold', () => {
    // Angebot has agingThresholdDays = 14
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-03-15T00:00:00Z'; // 19 days ago
    const result = getAgingText('angebot', statusChangedAt, now);
    expect(result).toBe('seit 19 Tagen');
  });

  // UT-2: Returns nothing for a project below threshold
  it('UT-2: returns null for project below threshold', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-03-25T00:00:00Z'; // 9 days ago, threshold is 14
    const result = getAgingText('angebot', statusChangedAt, now);
    expect(result).toBeNull();
  });

  // UT-3: Returns true for action-state project exceeding agingBoldDays
  it('UT-3: returns true for action-state project exceeding agingBoldDays', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Anfrage has agingBoldDays = 3
    const statusChangedAt = '2026-03-30T00:00:00Z'; // 4 days ago
    expect(isAgingBold('anfrage', statusChangedAt, now)).toBe(true);
  });

  it('returns false for action-state project below agingBoldDays', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-04-02T00:00:00Z'; // 1 day ago
    expect(isAgingBold('anfrage', statusChangedAt, now)).toBe(false);
  });

  // Finding 7: buffer-state bold — isAgingBold must work for buffer states too
  it('returns true for buffer-state project at/exceeding agingBoldDays', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Angebot has agingBoldDays = 14
    const statusChangedAt = '2026-03-19T00:00:00Z'; // 15 days ago
    expect(isAgingBold('angebot', statusChangedAt, now)).toBe(true);
  });

  // Finding 6: boundary conditions — exactly at threshold
  it('returns true for action-state at exactly agingBoldDays boundary', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Anfrage has agingBoldDays = 3, exactly 3 days ago should be true (days >= threshold)
    const statusChangedAt = '2026-03-31T00:00:00Z'; // exactly 3 days ago
    expect(isAgingBold('anfrage', statusChangedAt, now)).toBe(true);
  });

  it('returns false for action-state one day below agingBoldDays boundary', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Anfrage threshold = 3, 2 days ago should be false
    const statusChangedAt = '2026-04-01T00:00:00Z'; // 2 days ago
    expect(isAgingBold('anfrage', statusChangedAt, now)).toBe(false);
  });

  it('returns false for active state (no aging)', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-03-01T00:00:00Z'; // 33 days ago
    expect(isAgingBold('in_arbeit', statusChangedAt, now)).toBe(false);
  });

  it('returns false for done state (no aging)', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-03-01T00:00:00Z';
    expect(isAgingBold('erledigt', statusChangedAt, now)).toBe(false);
  });

  // Finding 6: boundary condition for getAgingText at exactly threshold
  it('getAgingText returns text at exactly agingThresholdDays boundary', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Angebot has agingThresholdDays = 14, exactly 14 days ago should show text (days >= threshold)
    const statusChangedAt = '2026-03-20T00:00:00Z'; // exactly 14 days ago
    expect(getAgingText('angebot', statusChangedAt, now)).toBe('seit 14 Tagen');
  });

  it('getAgingText returns null one day below agingThresholdDays boundary', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    // Angebot threshold = 14, 13 days ago should be null
    const statusChangedAt = '2026-03-21T00:00:00Z'; // 13 days ago
    expect(getAgingText('angebot', statusChangedAt, now)).toBeNull();
  });

  it('getAgingText returns null for action states', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-03-01T00:00:00Z';
    expect(getAgingText('anfrage', statusChangedAt, now)).toBeNull();
  });

  it('getDaysInState calculates correctly', () => {
    const now = new Date('2026-04-03T12:00:00Z');
    const statusChangedAt = '2026-04-01T00:00:00Z';
    expect(getDaysInState(statusChangedAt, now)).toBe(2);
  });
});

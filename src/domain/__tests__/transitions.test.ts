import { describe, it, expect } from 'vitest';
import {
  getNextState,
  getPreviousState,
  canTransitionForward,
  canTransitionBackward,
} from '../transitions';

// Covers UT-4, UT-5, UT-6, UT-7 from docs/spec/verification.md §16.1.
// The per-case UT-4..UT-7 tests were removed as redundant with the full-workflow
// tests below, which chain every transition in one go.
describe('state transitions', () => {
  it('getNextState follows the full workflow order', () => {
    expect(getNextState('anfrage')).toBe('angebot');
    expect(getNextState('angebot')).toBe('beauftragt');
    expect(getNextState('beauftragt')).toBe('geplant');
    expect(getNextState('geplant')).toBe('in_arbeit'); // UT-4
    expect(getNextState('in_arbeit')).toBe('abnahme');
    expect(getNextState('abnahme')).toBe('rechnung_faellig');
    expect(getNextState('rechnung_faellig')).toBe('abgerechnet');
    expect(getNextState('abgerechnet')).toBe('erledigt');
    expect(getNextState('erledigt')).toBeNull(); // UT-5
  });

  it('getPreviousState follows the full workflow order', () => {
    expect(getPreviousState('anfrage')).toBeNull(); // UT-6
    expect(getPreviousState('angebot')).toBe('anfrage');
    expect(getPreviousState('beauftragt')).toBe('angebot');
    expect(getPreviousState('geplant')).toBe('beauftragt');
    expect(getPreviousState('in_arbeit')).toBe('geplant');
    expect(getPreviousState('abnahme')).toBe('in_arbeit');
    expect(getPreviousState('rechnung_faellig')).toBe('abnahme');
    expect(getPreviousState('abgerechnet')).toBe('rechnung_faellig');
    expect(getPreviousState('erledigt')).toBeNull(); // UT-7
  });

  it('canTransitionForward is false for erledigt', () => {
    expect(canTransitionForward('erledigt')).toBe(false);
  });

  it('canTransitionForward is true for all others', () => {
    expect(canTransitionForward('anfrage')).toBe(true);
    expect(canTransitionForward('geplant')).toBe(true);
    expect(canTransitionForward('in_arbeit')).toBe(true);
  });

  it('canTransitionBackward is false for anfrage and erledigt', () => {
    expect(canTransitionBackward('anfrage')).toBe(false);
    expect(canTransitionBackward('erledigt')).toBe(false);
  });

  it('canTransitionBackward is true for middle states', () => {
    expect(canTransitionBackward('angebot')).toBe(true);
    expect(canTransitionBackward('in_arbeit')).toBe(true);
  });
});

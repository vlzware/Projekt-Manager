import { describe, it, expect } from 'vitest';
import { STRINGS } from '../strings';

describe('STRINGS template functions', () => {
  describe('validation', () => {
    it('mustBeString returns correct message', () => {
      expect(STRINGS.validation.mustBeString('name')).toBe('name muss ein String sein.');
    });

    it('mustBeObject returns correct message', () => {
      expect(STRINGS.validation.mustBeObject('address')).toBe('address muss ein Objekt sein.');
    });

    it('mustBeUuidArray returns correct message', () => {
      expect(STRINGS.validation.mustBeUuidArray('workerIds')).toBe(
        'workerIds muss ein Array von UUIDs sein.',
      );
    });

    it('mustBeNumeric returns correct message', () => {
      expect(STRINGS.validation.mustBeNumeric('estimatedValue')).toBe(
        'estimatedValue muss eine Zahl oder ein numerischer String sein.',
      );
    });
  });
});

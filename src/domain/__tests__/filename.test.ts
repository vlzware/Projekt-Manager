import { describe, it, expect } from 'vitest';
import { sanitiseFilenameSegment, buildProjectBundleFilename } from '../filename';

describe('sanitiseFilenameSegment', () => {
  it('strips path separators and wildcard chars', () => {
    expect(sanitiseFilenameSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('abcdefghij');
  });

  it('collapses whitespace runs to a single hyphen', () => {
    expect(sanitiseFilenameSegment('Hello   World  Foo')).toBe('Hello-World-Foo');
  });

  it('strips control bytes', () => {
    expect(sanitiseFilenameSegment('A\x00B\x1fC\x7fD')).toBe('ABCD');
  });

  it('dedupes consecutive hyphens after sanitisation', () => {
    expect(sanitiseFilenameSegment('foo - - bar')).toBe('foo-bar');
  });

  it('trims leading and trailing dots and dashes', () => {
    expect(sanitiseFilenameSegment('..-foo-.-')).toBe('foo');
  });

  it('clips to 40 characters', () => {
    const long = 'A'.repeat(60);
    expect(sanitiseFilenameSegment(long)).toHaveLength(40);
  });

  it('returns empty string for input that sanitises away entirely', () => {
    expect(sanitiseFilenameSegment('....')).toBe('');
    expect(sanitiseFilenameSegment('   ')).toBe('');
    expect(sanitiseFilenameSegment('')).toBe('');
  });

  it('preserves Unicode characters that are not control bytes or path separators', () => {
    expect(sanitiseFilenameSegment('Malerarbeiten Praxis Dr. Braun')).toBe(
      'Malerarbeiten-Praxis-Dr.-Braun',
    );
  });
});

describe('buildProjectBundleFilename', () => {
  it('joins number and slugified title with an underscore', () => {
    expect(
      buildProjectBundleFilename({
        number: 'P-2026-001',
        title: 'Malerarbeiten Praxis Dr. Braun',
      }),
    ).toBe('P-2026-001_Malerarbeiten-Praxis-Dr.-Braun.zip');
  });

  it('falls back to number-only when the title sanitises away to empty', () => {
    expect(buildProjectBundleFilename({ number: 'P-2026-002', title: '   ' })).toBe(
      'P-2026-002.zip',
    );
  });

  it('strips filesystem-unsafe chars from the title', () => {
    expect(buildProjectBundleFilename({ number: 'P-2026-003', title: 'Foo/Bar:Baz' })).toBe(
      'P-2026-003_FooBarBaz.zip',
    );
  });
});

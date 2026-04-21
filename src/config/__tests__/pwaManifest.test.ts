/**
 * Contract test for public/manifest.webmanifest.
 *
 * Pins the fields Chrome's install-prompt heuristic requires plus the
 * maskable-icon declaration needed for Android adaptive icons (issue #123).
 * Reading the asset off disk — no bundler transform — keeps the test
 * honest about what actually ships.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '../../..');
const manifestPath = path.join(repoRoot, 'public/manifest.webmanifest');

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

interface PwaManifest {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

function loadManifest(): PwaManifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as PwaManifest;
}

describe('public/manifest.webmanifest', () => {
  it('is valid JSON with the installability fields Chrome requires', () => {
    const m = loadManifest();
    expect(m.name).toBeTypeOf('string');
    expect(m.short_name).toBeTypeOf('string');
    expect(m.start_url).toBeTypeOf('string');
    expect(m.display).toBe('standalone');
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('declares 192 and 512 PNG icons and a maskable purpose', () => {
    const m = loadManifest();
    const sizes = m.icons.map((i) => i.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(m.icons.every((i) => i.type === 'image/png')).toBe(true);
    const hasMaskable = m.icons.some((i) => (i.purpose ?? '').split(/\s+/).includes('maskable'));
    expect(hasMaskable).toBe(true);
  });

  it('points at icon files that exist on disk', () => {
    const m = loadManifest();
    for (const icon of m.icons) {
      const abs = path.join(repoRoot, 'public', icon.src.replace(/^\//, ''));
      expect(existsSync(abs), `icon file missing: ${icon.src}`).toBe(true);
    }
  });
});

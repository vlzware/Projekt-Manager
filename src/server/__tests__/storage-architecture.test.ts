/**
 * Architecture-level invariants for the storage module (ADR-0022).
 *
 * The app key has only `writeFiles, readFiles, listFiles` — destructive
 * S3 calls are refused at the capability layer regardless of what the
 * code does. This test is a structural belt-and-braces against drift in
 * the same direction: no `DeleteObjectCommand` / `DeleteObjectsCommand`
 * anywhere in `src/` carries a `VersionId`, because such a call would
 * be a destructive intent the code base must not express.
 *
 * Restore (CopyObject with `CopySource: <bucket>/<key>?versionId=<vid>`)
 * is required and unaffected — the test does not scan CopyObjectCommand
 * or version-aware reads (GetObject/HeadObject with VersionId).
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const srcRoot = path.join(repoRoot, 'src');

function listSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      listSourceFiles(full, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Find every `new <CommandName>(...)` invocation in `src` and return the
 * argument block (text between the outer parens). Balanced-paren walk so
 * nested object literals and function calls inside the args are captured
 * intact.
 */
function extractCommandArgs(src: string, commandName: string): string[] {
  const out: string[] = [];
  const opener = new RegExp(`\\bnew\\s+${commandName}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = opener.exec(src)) !== null) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      i++;
    }
    if (depth === 0) {
      out.push(src.slice(start, i - 1));
    }
  }
  return out;
}

describe('Storage architecture (ADR-0022): no destructive call carries a VersionId', () => {
  const sourceFiles = listSourceFiles(srcRoot);

  it.each(['DeleteObjectCommand', 'DeleteObjectsCommand'])(
    '%s is never instantiated with a VersionId field anywhere in src/',
    (commandName) => {
      const offenders: Array<{ file: string; args: string }> = [];
      for (const file of sourceFiles) {
        const text = readFileSync(file, 'utf-8');
        if (!text.includes(commandName)) continue;
        const argBlocks = extractCommandArgs(text, commandName);
        for (const args of argBlocks) {
          // Match either property shorthand (`VersionId`) or assignment
          // (`VersionId:`) or batch-shape (`{ Key: ..., VersionId: ... }`
          // inside `Objects: [...]`). Case-insensitive guards against an
          // accidental lowercase-`versionId` slip — the SDK type would
          // reject it, but the architecture intent is "no version-aware
          // destruction" regardless of casing.
          if (/\bversionid\b/i.test(args)) {
            offenders.push({ file: path.relative(repoRoot, file), args });
          }
        }
      }
      expect(offenders).toEqual([]);
    },
  );

  it('the storage client is the only file that constructs DeleteObjectCommand directly', () => {
    // Concentration check — destructive-looking SDK commands belong in
    // one place so the capability surface is auditable. Anywhere else
    // is either a leak from an old refactor or someone bypassing the
    // hide/restore primitives.
    const callers = sourceFiles.filter((file) => {
      const text = readFileSync(file, 'utf-8');
      return /\bnew\s+DeleteObjectCommand\b/.test(text);
    });
    expect(callers.map((f) => path.relative(repoRoot, f))).toEqual([
      'src/server/storage/client.ts',
    ]);
  });
});

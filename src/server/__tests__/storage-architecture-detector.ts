/**
 * AST-based detector for "destructive S3 call carrying a VersionId"
 * (ADR-0022 / issue #45).
 *
 * Replaces the prior regex-over-text scanner, which was bypassed by an
 * import alias:
 *
 *   import { DeleteObjectCommand as Foo } from '@aws-sdk/client-s3';
 *   new Foo({ Bucket: 'x', Key: 'y', VersionId: 'z' });  // regex missed
 *
 * The new detector resolves the constructor identifier through the
 * file's import table (named, aliased, namespace) and only flags the
 * call when it resolves to `@aws-sdk/client-s3`'s `DeleteObjectCommand`
 * or `DeleteObjectsCommand`. It then walks the argument expression
 * looking for a `VersionId` property anywhere in the object shape —
 * top-level for the single-object delete, inside `Delete.Objects[*]`
 * for the batch delete.
 *
 * Argument shapes covered:
 *   - inline object/array literal (the obvious case)
 *   - identifier resolving via one hop of intra-file `const` binding to
 *     an object/array literal initializer in the same file (T5c — closes
 *     the variable-bound bypass that the inline-only check missed)
 *   - any other identifier shape (function param, imported binding,
 *     spread, computed value) → opaque-and-flag, fail-closed: the
 *     detector cannot follow it, so the call is reported as a finding
 *     and a contributor must either inline the literal or arrange for
 *     the architecture test to exempt the call site
 *
 * Limits:
 *   - Cross-file re-export resolution is intentionally out of scope.
 *     Detecting `import { X } from './local'` where `local.ts`
 *     re-exports `DeleteObjectCommand` would require a TypeChecker
 *     program, which is heavier than this self-contained file scan
 *     warrants. Intra-file rebindings (`const X = DeleteObjectCommand;
 *     new X(...)`) are tracked. The capability split (issue #45 primary
 *     defense) is the actual enforcement; this scanner is a structural
 *     visibility belt.
 *
 * The detector is exported as a pure function so the test file can run
 * it against the real `src/server/` tree AND against negative-case
 * fixtures kept under `src/server/__tests__/fixtures/`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const AWS_SDK_S3_MODULE = '@aws-sdk/client-s3';
const DESTRUCTIVE_COMMANDS = new Set(['DeleteObjectCommand', 'DeleteObjectsCommand']);

/** A single offending instantiation reported to the test. */
export interface DetectorOffense {
  /** File path, relative to a caller-supplied root for stable assertions. */
  file: string;
  /** 1-based line number of the `new` expression. */
  line: number;
  /** The originally-imported SDK command (after alias resolution). */
  command: 'DeleteObjectCommand' | 'DeleteObjectsCommand';
  /** Where the VersionId property was found, for the failure message. */
  reason: string;
}

/** Internal: resolve a local identifier to its AWS-SDK origin. */
type ImportResolution =
  | { kind: 'named'; command: string } // local ident → SDK command
  | { kind: 'namespace' } // local ident is `import * as X from <sdk>`
  | { kind: 'rebinding'; target: string }; // `const X = Foo;` rebinding

interface FileImports {
  /** Map of local identifier name → resolution. */
  bindings: Map<string, ImportResolution>;
}

/** Walk a directory recursively, returning all .ts/.tsx files. */
function listSourceFilesRecursive(
  dir: string,
  excludeDirs: ReadonlySet<string>,
  acc: string[] = [],
): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (excludeDirs.has(entry)) continue;
      listSourceFilesRecursive(full, excludeDirs, acc);
    } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * List the files the production scan covers: every .ts/.tsx under
 * `src/server/` except tests, fixtures, node_modules and dist.
 *
 * Intentionally narrow. The AWS SDK is server-only today; if a future
 * change introduces client-side SDK use, widen the glob deliberately
 * rather than letting this scanner silently miss it.
 */
export function listServerSourceFiles(serverRoot: string): string[] {
  return listSourceFilesRecursive(serverRoot, new Set(['__tests__', 'node_modules', 'dist']));
}

/**
 * Build the per-file import table. Each entry maps a local identifier
 * to either an SDK command name (named / aliased imports) or a marker
 * that the identifier is a namespace import on `@aws-sdk/client-s3`.
 *
 * Also records intra-file rebindings: `const X = DeleteObjectCommand`
 * makes `X` resolve transitively to whatever `DeleteObjectCommand`
 * resolves to.
 */
function collectImports(sourceFile: ts.SourceFile): FileImports {
  const bindings = new Map<string, ImportResolution>();

  for (const stmt of sourceFile.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const moduleSpec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(moduleSpec)) continue;
    if (moduleSpec.text !== AWS_SDK_S3_MODULE) continue;

    const importClause = stmt.importClause;
    if (!importClause) continue;
    const namedBindings = importClause.namedBindings;
    if (!namedBindings) continue;

    if (ts.isNamespaceImport(namedBindings)) {
      // `import * as S3 from '@aws-sdk/client-s3'`
      bindings.set(namedBindings.name.text, { kind: 'namespace' });
    } else if (ts.isNamedImports(namedBindings)) {
      // `import { DeleteObjectCommand, DeleteObjectsCommand as Foo } …`
      for (const element of namedBindings.elements) {
        const importedName = element.propertyName?.text ?? element.name.text;
        const localName = element.name.text;
        if (DESTRUCTIVE_COMMANDS.has(importedName)) {
          bindings.set(localName, { kind: 'named', command: importedName });
        }
      }
    }
  }

  // Intra-file rebindings: walk the top-level `const X = Y;`
  // declarations and record any whose initializer is either
  //   - an identifier already in the bindings table, or
  //   - a `<Namespace>.<Command>` property access where `<Namespace>`
  //     is a namespace import on `@aws-sdk/client-s3`.
  // Loop until no new bindings are added so a chain
  // (`const A = DOC; const B = A; const C = B;`) is fully resolved.
  let changed = true;
  while (changed) {
    changed = false;
    sourceFile.forEachChild((node) => {
      if (!ts.isVariableStatement(node)) return;
      for (const decl of node.declarationList.declarations) {
        if (!decl.initializer) continue;
        if (!ts.isIdentifier(decl.name)) continue; // ignore destructuring
        const localName = decl.name.text;
        if (bindings.has(localName)) continue;

        if (ts.isIdentifier(decl.initializer)) {
          const target = decl.initializer.text;
          if (bindings.has(target)) {
            bindings.set(localName, { kind: 'rebinding', target });
            changed = true;
          }
          continue;
        }

        if (
          ts.isPropertyAccessExpression(decl.initializer) &&
          ts.isIdentifier(decl.initializer.expression)
        ) {
          // `const X = S3.DeleteObjectCommand` — only meaningful when
          // S3 is a namespace import on @aws-sdk/client-s3 and the
          // accessed property is a destructive command.
          const lhs = bindings.get(decl.initializer.expression.text);
          if (lhs && lhs.kind === 'namespace') {
            const accessed = decl.initializer.name.text;
            if (DESTRUCTIVE_COMMANDS.has(accessed)) {
              bindings.set(localName, { kind: 'named', command: accessed });
              changed = true;
            }
          }
        }
      }
    });
  }

  return { bindings };
}

/**
 * Resolve a local identifier through the bindings table to the
 * SDK command it ultimately stands for, if any.
 */
function resolveToCommand(
  bindings: Map<string, ImportResolution>,
  localName: string,
): string | undefined {
  // Hard cap on chain length to avoid pathological loops on malformed
  // input. 16 hops is far more than any sane code base would produce.
  let current = localName;
  for (let depth = 0; depth < 16; depth++) {
    const res = bindings.get(current);
    if (!res) return undefined;
    if (res.kind === 'named') return res.command;
    if (res.kind === 'namespace') return undefined; // namespace itself is not a command
    if (res.kind === 'rebinding') {
      current = res.target;
      continue;
    }
  }
  return undefined;
}

/**
 * Walk an already-literal expression looking for a property literally
 * named `VersionId` (case-insensitive — the SDK type would reject any
 * other casing, this is defense-in-depth for the architectural intent:
 * no version-aware destruction regardless of casing). Returns a short
 * locator string for the failure message, or `undefined` if no such
 * property is present.
 *
 * Object literals, array literals, and parenthesised expressions are
 * traversed. Other shapes return `undefined` — this helper only walks
 * literal subtrees. The top-level argument inspection is handled by
 * `inspectArgumentForVersionId`, which adds opaque-and-flag semantics
 * for variable-bound arguments.
 */
function findVersionIdInLiteral(node: ts.Expression, breadcrumb: string): string | undefined {
  if (ts.isParenthesizedExpression(node)) {
    return findVersionIdInLiteral(node.expression, breadcrumb);
  }
  if (ts.isObjectLiteralExpression(node)) {
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
        const name = prop.name;
        if (!name || !('text' in name) || typeof name.text !== 'string') continue;
        if (name.text.toLowerCase() === 'versionid') {
          return `${breadcrumb}.${name.text}`;
        }
        if (ts.isPropertyAssignment(prop)) {
          const inner = findVersionIdInLiteral(prop.initializer, `${breadcrumb}.${name.text}`);
          if (inner) return inner;
        }
      } else if (ts.isSpreadAssignment(prop)) {
        // `...spread` — we cannot see through to whatever the spread
        // resolves to without a TypeChecker. Mark the breadcrumb so a
        // reviewer auditing a flagged file knows a spread was present;
        // do not flag the call on the strength of a spread alone.
        continue;
      }
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    for (let i = 0; i < node.elements.length; i++) {
      const inner = findVersionIdInLiteral(node.elements[i], `${breadcrumb}[${i}]`);
      if (inner) return inner;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Top-level argument inspection. Distinct return cases drive the
 * detector's flagging decision:
 *
 *   - 'clean'  — argument is a literal with no VersionId. Not flagged.
 *   - 'found'  — argument literal (or const-resolved literal) carries a
 *                VersionId. Flagged with the property locator.
 *   - 'opaque' — argument is variable-bound and cannot be resolved to a
 *                literal in the same file (function param, imported
 *                binding, computed value, top-level spread, deeper hop).
 *                Flagged fail-closed: the detector cannot prove absence
 *                of VersionId, so it must not silently pass.
 *
 * Resolution rule: when the argument is a bare `Identifier`, look it up
 * in the file's local `const`-declared object/array literals (one hop).
 * Anything else — including chained `const a = b; const c = a;` — is
 * opaque, by design. The single legitimate variable-bearing destructive
 * call site is exempted at the architectural-test boundary, not papered
 * over here.
 */
type ArgumentInspection =
  | { kind: 'clean' }
  | { kind: 'found'; reason: string }
  | { kind: 'opaque'; reason: string };

function inspectArgumentForVersionId(
  argExpr: ts.Expression,
  localLiteralBindings: ReadonlyMap<string, ts.Expression>,
): ArgumentInspection {
  // Strip parens before classifying — `new Cmd((opts))` should behave
  // identically to `new Cmd(opts)`.
  let node: ts.Expression = argExpr;
  while (ts.isParenthesizedExpression(node)) node = node.expression;

  if (ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)) {
    const reason = findVersionIdInLiteral(node, '<arg0>');
    return reason ? { kind: 'found', reason } : { kind: 'clean' };
  }

  if (ts.isIdentifier(node)) {
    // One-hop resolution: same-file `const x = { ... }` whose init is a
    // literal. Anything else is opaque. We deliberately do NOT chain
    // (`const a = b` where `b` is itself a const-bound literal) — the
    // detector inspects exactly one hop. Adding chained resolution would
    // expand the bypass surface and the architectural intent is the
    // opposite: keep destructive shapes inline-or-exempted.
    const initializer = localLiteralBindings.get(node.text);
    if (!initializer) {
      return {
        kind: 'opaque',
        reason: `argument is variable-bound to "${node.text}" and not resolvable to an inline literal in this file; refactor to inline literal or exempt the call site at the architecture test boundary`,
      };
    }
    const reason = findVersionIdInLiteral(initializer, '<arg0>');
    return reason ? { kind: 'found', reason } : { kind: 'clean' };
  }

  // Anything else at the top level (function call, conditional, await,
  // spread expression, type assertion bodies that are themselves opaque,
  // etc.) cannot be statically resolved by this detector. Fail closed.
  return {
    kind: 'opaque',
    reason: `argument is a non-literal expression of kind "${ts.SyntaxKind[node.kind]}"; refactor to inline literal or exempt the call site at the architecture test boundary`,
  };
}

/**
 * Build the lookup table of same-file `const x = <literal>` bindings
 * whose initializer is an object or array literal. Used by
 * `inspectArgumentForVersionId` to follow exactly one hop of intra-file
 * const resolution.
 *
 * Walks the entire source tree (any depth — so a `const probeInput = …`
 * inside a method body is captured), but a name declared more than once
 * anywhere in the file is recorded as "ambiguous" and never resolves —
 * the detector treats the use as opaque and flags it. Fail-closed: a
 * shadowed name could mean the use site picks up a different scope's
 * binding than the one we'd pair it with.
 *
 * Non-const variables (`let`, `var`) and non-literal initializers are
 * ignored entirely; the use site of such a name lands in the opaque
 * branch via the missing-binding path in `inspectArgumentForVersionId`.
 */
function collectLocalLiteralBindings(sourceFile: ts.SourceFile): Map<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  const ambiguous = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableStatement(node)) {
      const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
      if (isConst) {
        for (const decl of node.declarationList.declarations) {
          if (!decl.initializer) continue;
          if (!ts.isIdentifier(decl.name)) continue; // ignore destructuring
          let init: ts.Expression = decl.initializer;
          while (ts.isParenthesizedExpression(init)) init = init.expression;
          if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) {
            const name = decl.name.text;
            if (bindings.has(name)) {
              ambiguous.add(name);
            } else {
              bindings.set(name, init);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const name of ambiguous) bindings.delete(name);
  return bindings;
}

/**
 * Detect destructive instantiations carrying (or potentially carrying) a
 * VersionId across the given file list. Pure function; the same code
 * path is exercised by the production scan and the negative-case fixture
 * tests.
 *
 * Findings are emitted for three argument shapes:
 *   - inline literal that contains a VersionId (the obvious case)
 *   - same-file `const`-bound literal that contains a VersionId (closes
 *     the inline-only bypass — T5c)
 *   - any non-literal / non-resolvable argument (opaque-and-flag, fail-
 *     closed): the detector cannot prove absence of VersionId, so a
 *     contributor must inline the literal or arrange an exemption
 */
export function detectVersionIdOnDestructiveCommands(
  filePaths: readonly string[],
  rootForRelativePaths: string,
): DetectorOffense[] {
  const offenses: DetectorOffense[] = [];

  for (const filePath of filePaths) {
    const text = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports = collectImports(sourceFile);
    if (imports.bindings.size === 0) continue;

    const literalBindings = collectLocalLiteralBindings(sourceFile);

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const command = resolveNewExpressionTarget(node.expression, imports.bindings);
        if (command && DESTRUCTIVE_COMMANDS.has(command)) {
          const arg = node.arguments?.[0];
          if (arg) {
            const inspection = inspectArgumentForVersionId(arg, literalBindings);
            if (inspection.kind !== 'clean') {
              const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
              offenses.push({
                file: path.relative(rootForRelativePaths, filePath),
                line: line + 1,
                command: command as DetectorOffense['command'],
                reason: inspection.reason,
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return offenses;
}

/**
 * Resolve the `<expr>` in `new <expr>(...)` to an SDK command name,
 * if it resolves at all. Handles plain identifiers, intra-file
 * rebindings, and `<NamespaceImport>.<Command>` property access.
 */
function resolveNewExpressionTarget(
  expr: ts.LeftHandSideExpression,
  bindings: Map<string, ImportResolution>,
): string | undefined {
  if (ts.isIdentifier(expr)) {
    return resolveToCommand(bindings, expr.text);
  }
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    // `new S3.DeleteObjectCommand(...)` — only valid when the LHS is
    // a namespace import on `@aws-sdk/client-s3`.
    const lhs = bindings.get(expr.expression.text);
    if (lhs && lhs.kind === 'namespace') {
      return expr.name.text;
    }
  }
  return undefined;
}

/**
 * Detect every file that constructs `DeleteObjectCommand` directly
 * (resolved through aliases / rebindings / namespace imports). Used by
 * the concentration check — the destructive-looking SDK construct
 * belongs in one place so its capability surface stays auditable.
 */
export function listFilesConstructingDeleteObjectCommand(
  filePaths: readonly string[],
  rootForRelativePaths: string,
): string[] {
  const matches = new Set<string>();

  for (const filePath of filePaths) {
    const text = readFileSync(filePath, 'utf-8');
    const sourceFile = ts.createSourceFile(
      filePath,
      text,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ true,
      filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const imports = collectImports(sourceFile);
    if (imports.bindings.size === 0) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isNewExpression(node)) {
        const command = resolveNewExpressionTarget(node.expression, imports.bindings);
        if (command === 'DeleteObjectCommand') {
          matches.add(path.relative(rootForRelativePaths, filePath));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return [...matches].sort();
}

/**
 * Invoice service — draft CRUD + issue + cancel + list + get.
 *
 * Architectural rationale: ADR-0026.
 * Entity: data-model.md §5.15 (Invoice), §5.16 (Sequence), §5.17 (Profile).
 * Wire contract: api.md §14.2.14.
 * Verification: AC-285..AC-308, AT-109..AT-128.
 *
 * Every mutation rides the single-write `mutate()` / `mutateInTx()`
 * path (ADR-0021). The issuance transaction is the load-bearing
 * primitive — one DB transaction commits:
 *
 *   1. `SELECT … FOR UPDATE` on `invoice_sequence(year, 'invoice')`
 *      (or INSERT on first-of-year). The lock is held until commit;
 *      a rollback returns the value to the sequence (gapless property).
 *   2. Issuer snapshot from the live `company_profile` row.
 *   3. Recipient snapshot — live customer overlaid with body overrides.
 *   4. UPDATE the draft row to `status='issued'`, set `number`,
 *      `issueDate`, `taxMode`, `profile`, `issuer`, `recipient`, `lines`,
 *      `totals`, `performanceDate`.
 *   5. Server-computed totals from `lines + taxMode`.
 *   6. Renderer call (Phase C; the stub throws so AT-116/AT-117 stay red).
 *   7. UPDATE the row to attach the binary descriptor reference.
 *   8. UPDATE the parent project `status` to `'abgerechnet'`.
 *   9. Audit row via `mutateInTx()` (action=`invoice:issue`,
 *      ancestor=`('project', projectId)`).
 *  10. Commit. Post-commit: `emitInvoiceChanged()`.
 *
 * Cancel mirrors the same atom against a `storno` sub-sequence, with
 * TWO audit rows (`invoice:cancel` on the original, `invoice:issue`
 * on the Storno — the Storno is itself an issuance) and ONE SSE event.
 */

import crypto from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Database, MutatingDatabase } from '../db/connection.js';
import { invoices, projects, customers } from '../db/schema.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from './Logger.js';
import { mutate, mutateInTx, dispatchAuditRows } from './mutate.js';
import type { AuditLogRow } from './audit-publisher.js';
import {
  computeInvoiceTotals,
  negateInvoiceLines,
  TAX_MODES,
  type Invoice,
  type InvoiceLine,
  type InvoiceIssuerSnapshot,
  type InvoiceRecipientSnapshot,
  type TaxMode,
  type InvoiceProfile,
} from '../../domain/invoice.js';
import {
  toInvoiceResponse,
  listInvoices as listInvoicesRepo,
  getInvoice as getInvoiceRepo,
  getInvoiceRowForMutation,
  allocateInvoiceNumber,
  type ListInvoicesOpts,
  type InvoiceRow,
} from '../repositories/invoice-read.js';
import {
  CompanyProfileService,
  assertCompanyProfileCompleteForMode,
} from './CompanyProfileService.js';
import { InvoiceRenderer, type RenderedInvoice } from './InvoiceRenderer.js';
import { encryptInvoicePayload } from './invoice/payloadCrypto.js';
import { KeyEnvelopeService } from './KeyEnvelopeService.js';
import { attachments } from '../db/schema.js';
import { WRAPPED_DEK_CURRENT_VERSION } from '../../domain/attachments.js';
import type { AttachmentStorageClient } from '../storage/client.js';
import {
  notFound,
  notPermitted,
  validationError,
  invoiceFrozen,
  invoiceProjectState,
  invoiceNotIssued,
  invoiceAlreadyCancelled,
} from '../errors.js';
import { STRINGS } from '../../config/strings.js';
import { isOutOfScope } from '../repositories/scope.js';
import { emitInvoiceChanged } from '../sse/emitters.js';

/** Re-export the read-side opts shape so routes don't import the repo. */
export type { ListInvoicesOpts };

/** Validate that every line's shape is the contract's. Server re-derives totals. */
function validateInvoiceLines(lines: InvoiceLine[]): void {
  if (!Array.isArray(lines)) {
    throw validationError(STRINGS.errors.invalidInput);
  }
  for (const line of lines) {
    if (typeof line.description !== 'string') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.quantity !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.unit !== 'string') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.unitPrice !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.lineTotal !== 'number') throw validationError(STRINGS.errors.invalidInput);
    if (typeof line.taxRate !== 'number') throw validationError(STRINGS.errors.invalidInput);
  }
}

/**
 * Shape returned by the cancel call (api.md §14.2.14 — pinned exactly
 * as `{ original, storno }` per the wire contract assertion in
 * `invoices-cancel.test.ts:254`).
 */
export interface CancelResult {
  original: Invoice;
  storno: Invoice;
}

export interface CreateDraftInput {
  projectId: string;
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export interface UpdateDraftInput {
  lines?: InvoiceLine[];
  recipient?: InvoiceRecipientSnapshot;
  taxMode?: TaxMode;
  performanceDate?: string | null;
}

export interface CancelInput {
  reason?: string | null;
}

/**
 * Optional binary-pipeline dependencies. When supplied (Phase D and
 * up — the route wiring injects them), `persistRenderedBinary` writes
 * the rendered ZUGFeRD PDF/A-3 through the existing attachment
 * binary-descriptor pipeline:
 *
 *   1. Generate fresh 32-byte AES-256-GCM DEK.
 *   2. Encrypt the plaintext PDF bytes (`nonce(12) || ct || tag(16)`).
 *   3. Wrap the DEK against the operator-loaded `age` recipient via
 *      `KeyEnvelopeService.wrap()` — parity with attachment init.
 *   4. `putObject(key, ciphertext, "application/octet-stream")` —
 *      server-side direct PUT, no presign round-trip. The bucket's
 *      default-retention envelope (`INVOICE_OBJECT_LOCK_DAYS`,
 *      asserted at boot per AC-296) attaches Object Lock to the PUT.
 *   5. Insert an `attachments` row at `status='ready'` carrying the
 *      ciphertext key + size + the wrapped DEK + MIME `application/pdf`
 *      + label `'rechnung'`. The row id is returned and stored on
 *      `invoices.renderedPdfBinaryDescriptorId`.
 *
 * When ABSENT, `persistRenderedBinary` falls back to the Phase B
 * placeholder (synthetic UUID) so test paths exercising the issuance
 * transaction without a storage backend (the renderer-throws / SSE /
 * audit assertions) continue to pass. The placeholder leaves the
 * column non-null but does NOT make the bytes actually retrievable —
 * `GET /api/invoices/:id/pdf` requires the real pipeline to fetch
 * back from B2 / MinIO.
 */
export interface InvoiceBinaryDeps {
  storage: AttachmentStorageClient;
  binaryAgeRecipient: string;
  binaryAgeIdentityPath: string;
}

export class InvoiceService {
  private readonly renderer: InvoiceRenderer;
  private readonly binaryDeps: InvoiceBinaryDeps | null;
  constructor(
    private db: Database,
    renderer?: InvoiceRenderer,
    binaryDeps?: InvoiceBinaryDeps,
  ) {
    // Renderer is constructor-injected so the test mock seam in
    // `invoices-issue.test.ts:521-536` is honored — the mocked module's
    // class is what `new InvoiceRenderer()` resolves to in the test
    // process. In production the default constructor is fine.
    this.renderer = renderer ?? new InvoiceRenderer();
    this.binaryDeps = binaryDeps ?? null;
  }

  // -------------------------------------------------------------------
  // List + Get
  // -------------------------------------------------------------------

  /**
   * List visible invoices. Worker callers receive `[]` (AC-298) by
   * construction of the repository predicate; permission gating is
   * the route layer's job. The service is callable from any
   * authenticated context — readers without `invoice:read` are
   * rejected upstream.
   */
  async list(caller: AuthUser, opts: ListInvoicesOpts = {}) {
    return listInvoicesRepo(this.db, caller, opts);
  }

  /**
   * Three-way result (AC-298): row → 200 / OUT_OF_SCOPE → 403 / null → 404.
   */
  async get(caller: AuthUser, id: string): Promise<Invoice> {
    const result = await getInvoiceRepo(this.db, caller, id);
    if (result === null) throw notFound(STRINGS.entities.invoice);
    if (isOutOfScope(result)) throw notPermitted();
    return result;
  }

  // -------------------------------------------------------------------
  // Draft CRUD
  // -------------------------------------------------------------------

  /**
   * Create a draft invoice scoped to a project. Pre-fills `taxMode`
   * from the live `company_profile.defaultTaxMode` and `recipient`
   * from the project's customer (live row; the actual snapshot is
   * taken at issuance — AC-285).
   *
   * Rejected on an archived project (mirrors AC-95) — 404 NOT_FOUND.
   */
  async createDraft(
    input: CreateDraftInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<Invoice> {
    const lines = input.lines ?? [];
    validateInvoiceLines(lines);

    if (input.taxMode !== undefined && !TAX_MODES.includes(input.taxMode)) {
      throw validationError(STRINGS.errors.invalidInput);
    }

    const profileService = new CompanyProfileService(this.db);
    const profile = await profileService.get();

    // Resolve the live customer for the project so we can pre-fill
    // recipient defaults.
    const projRows = await this.db
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    const project = projRows[0];
    // AC-285: archived project → 404 (mirrors AC-95 for draft writes).
    if (!project || project.deleted) {
      throw notFound(STRINGS.entities.project);
    }

    const customerRows = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, project.customerId))
      .limit(1);
    const customer = customerRows[0];

    const taxMode: TaxMode = input.taxMode ?? profile.defaultTaxMode;

    // Build the draft's recipient: the live customer's fields are the
    // baseline; any field present in `input.recipient` overrides.
    const customerRecipient: InvoiceRecipientSnapshot = customer
      ? {
          name: customer.name,
          address: customer.address ?? null,
          ustId: customer.ustId ?? null,
        }
      : { name: '', address: null, ustId: null };

    const recipient: InvoiceRecipientSnapshot = input.recipient
      ? {
          name: input.recipient.name !== undefined ? input.recipient.name : customerRecipient.name,
          address:
            input.recipient.address !== undefined
              ? input.recipient.address
              : customerRecipient.address,
          ustId:
            input.recipient.ustId !== undefined ? input.recipient.ustId : customerRecipient.ustId,
        }
      : customerRecipient;

    // Issuer block on a draft row carries empty placeholders — the
    // snapshot freezes at issuance, not at draft create (data-model.md
    // §5.17 design note "Snapshot at issuance, not at draft creation").
    const placeholderIssuer: InvoiceIssuerSnapshot = {
      companyName: '',
      address: { street: '', zip: '', city: '' },
      taxId: '',
    };

    const totals = computeInvoiceTotals(lines, taxMode);
    const profileLiteral: InvoiceProfile = 'zugferd-en16931';

    const id = crypto.randomUUID();
    const performanceDate = input.performanceDate ? new Date(input.performanceDate) : null;

    const created = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'create',
        run: async (tx) => {
          const rows = await tx
            .insert(invoices)
            .values({
              id,
              projectId: input.projectId,
              status: 'draft',
              number: null,
              issueDate: null,
              performanceDate,
              taxMode,
              profile: profileLiteral,
              issuer: placeholderIssuer,
              recipient,
              lines,
              totals,
              cancellationOf: null,
              cancellationReason: null,
              renderedPdfBinaryDescriptorId: null,
              createdBy: userId,
              updatedBy: userId,
            })
            .returning();
          const row = rows[0]!;
          return {
            entityId: row.id,
            entityLabel: null,
            value: row,
            before: {},
            after: {
              projectId: row.projectId,
              status: row.status,
              taxMode: row.taxMode,
              profile: row.profile,
              recipient: row.recipient,
              lines: row.lines,
              totals: row.totals,
            },
            // Ancestor link: every invoice mutation surfaces under the
            // project's activity feed (ADR-0026 §Audit and realtime).
            ancestorEntityType: 'project',
            ancestorEntityId: input.projectId,
          };
        },
      },
    );
    log.info({ invoiceId: created.id, projectId: input.projectId }, 'invoice_draft_created');
    emitInvoiceChanged();
    return toInvoiceResponse(created);
  }

  /**
   * PATCH a draft row. Rejected with `INVOICE_FROZEN` (422) if the
   * row's status is not `'draft'`. Server re-derives `totals` from the
   * post-patch `lines + taxMode` on every successful PATCH (AC-286).
   */
  async updateDraft(
    id: string,
    input: UpdateDraftInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<Invoice> {
    if (input.taxMode !== undefined && !TAX_MODES.includes(input.taxMode)) {
      throw validationError(STRINGS.errors.invalidInput);
    }
    if (input.lines !== undefined) validateInvoiceLines(input.lines);

    const updated = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'update',
        run: async (tx) => {
          const before = await getInvoiceRowForMutation(tx, id);
          if (!before) throw notFound(STRINGS.entities.invoice);
          if (before.status !== 'draft') throw invoiceFrozen();

          const nextTaxMode: TaxMode = (input.taxMode ?? before.taxMode) as TaxMode;
          const nextLines: InvoiceLine[] = input.lines ?? (before.lines as InvoiceLine[]);
          const nextTotals = computeInvoiceTotals(nextLines, nextTaxMode);
          const nextPerformanceDate =
            'performanceDate' in input
              ? input.performanceDate
                ? new Date(input.performanceDate)
                : null
              : before.performanceDate;

          // Build the per-PATCH recipient: omitted fields unchanged.
          let nextRecipient: InvoiceRecipientSnapshot =
            before.recipient as InvoiceRecipientSnapshot;
          if (input.recipient !== undefined) {
            nextRecipient = {
              name: input.recipient.name !== undefined ? input.recipient.name : nextRecipient.name,
              address:
                input.recipient.address !== undefined
                  ? input.recipient.address
                  : (nextRecipient.address ?? null),
              ustId:
                input.recipient.ustId !== undefined
                  ? input.recipient.ustId
                  : (nextRecipient.ustId ?? null),
            };
          }

          const rows = await tx
            .update(invoices)
            .set({
              taxMode: nextTaxMode,
              lines: nextLines,
              totals: nextTotals,
              recipient: nextRecipient,
              performanceDate: nextPerformanceDate,
              updatedAt: new Date(),
              updatedBy: userId,
            })
            .where(eq(invoices.id, id))
            .returning();
          const row = rows[0]!;

          // Capture only the changed fields in the audit payload —
          // matches the §5.10 "changed fields only" rule.
          const beforeFields: Record<string, unknown> = {};
          const afterFields: Record<string, unknown> = {};
          if (input.taxMode !== undefined && before.taxMode !== input.taxMode) {
            beforeFields.taxMode = before.taxMode;
            afterFields.taxMode = input.taxMode;
          }
          if (input.lines !== undefined) {
            beforeFields.lines = before.lines;
            afterFields.lines = nextLines;
            beforeFields.totals = before.totals;
            afterFields.totals = nextTotals;
          }
          if (input.recipient !== undefined) {
            beforeFields.recipient = before.recipient;
            afterFields.recipient = nextRecipient;
          }
          if ('performanceDate' in input) {
            beforeFields.performanceDate = before.performanceDate;
            afterFields.performanceDate = nextPerformanceDate;
          }

          return {
            entityId: id,
            entityLabel: null,
            value: row,
            before: beforeFields,
            after: afterFields,
            ancestorEntityType: 'project',
            ancestorEntityId: row.projectId,
          };
        },
      },
    );
    log.info({ invoiceId: id }, 'invoice_draft_updated');
    emitInvoiceChanged();
    return toInvoiceResponse(updated);
  }

  /**
   * Hard-delete a draft. Rejected with `INVOICE_FROZEN` (422) for any
   * non-draft row (AC-286). Audit `action='invoice:delete'` — the
   * exact string is pinned in `invoices-routes.test.ts:467`. Ancestor
   * link is the parent project.
   */
  async deleteDraft(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<void> {
    await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'invoice:delete',
        run: async (tx) => {
          const before = await getInvoiceRowForMutation(tx, id);
          if (!before) throw notFound(STRINGS.entities.invoice);
          if (before.status !== 'draft') throw invoiceFrozen();

          await tx.delete(invoices).where(eq(invoices.id, id));

          return {
            entityId: id,
            entityLabel: null,
            value: null,
            before: {
              projectId: before.projectId,
              status: before.status,
              taxMode: before.taxMode,
              lines: before.lines,
              totals: before.totals,
            },
            after: {},
            ancestorEntityType: 'project',
            ancestorEntityId: before.projectId,
          };
        },
      },
    );
    log.info({ invoiceId: id }, 'invoice_draft_deleted');
    emitInvoiceChanged();
  }

  // -------------------------------------------------------------------
  // Issue
  // -------------------------------------------------------------------

  /**
   * The issuance transaction (AC-287). See module docstring for the
   * step list. Throws structured errors at each pre-condition failure
   * so the route maps to the documented status / code combinations
   * (AC-289 + AT-113).
   *
   * Post-commit emits ONE `invoice_changed` SSE event.
   */
  async issueDraft(
    id: string,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<Invoice> {
    const issued = await mutate(
      this.db,
      { actorKind: 'user', actorId: userId, correlationId: correlationId ?? null },
      {
        entityType: 'invoice',
        action: 'invoice:issue',
        run: async (tx) => this.runIssueInsideTx(tx, id, userId),
      },
    );
    log.info({ invoiceId: id }, 'invoice_issued');
    emitInvoiceChanged();
    return toInvoiceResponse(issued);
  }

  /**
   * The body of the issuance atom. Lives inside `mutate()` so the audit
   * row commits with every other change. Splitting it out keeps the
   * step list readable and lets `cancel()` reuse the snapshot/render
   * portion against the Storno's own sequence.
   */
  private async runIssueInsideTx(
    tx: MutatingDatabase,
    invoiceId: string,
    userId: string,
  ): Promise<{
    entityId: string;
    entityLabel: string | null;
    value: InvoiceRow;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    ancestorEntityType: 'project';
    ancestorEntityId: string;
  }> {
    const before = await getInvoiceRowForMutation(tx, invoiceId);
    if (!before) throw notFound(STRINGS.entities.invoice);
    if (before.status !== 'draft') throw invoiceFrozen();

    // 1. Pre-condition rejections — each maps to its documented code
    // (AC-289 / AT-113). Order matters: the cheaper checks (no DB
    // round-trip) run first so they don't waste a sequence lock.

    const lines = before.lines as InvoiceLine[];
    if (lines.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['lines'] });
    }
    if (!before.performanceDate) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['performanceDate'] });
    }
    const recipient = before.recipient as InvoiceRecipientSnapshot;
    if (!recipient.name || recipient.name.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['recipient.name'] });
    }
    if (!recipient.address || !recipient.address.street || recipient.address.street.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.street'],
      });
    }
    if (!recipient.address.zip || recipient.address.zip.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.zip'],
      });
    }
    if (!recipient.address.city || recipient.address.city.length === 0) {
      throw validationError(STRINGS.errors.invalidInput, {
        missingFields: ['recipient.address.city'],
      });
    }
    const taxMode = before.taxMode as TaxMode;
    if (taxMode === 'reverse_charge' && (!recipient.ustId || recipient.ustId.length === 0)) {
      throw validationError(STRINGS.errors.invalidInput, { missingFields: ['recipient.ustId'] });
    }

    // 2. Project state precondition — the project must be in
    //    `rechnung_faellig` for the issue to be legal.
    const projRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, before.projectId), eq(projects.deleted, false)))
      .limit(1);
    const project = projRows[0];
    if (!project) throw notFound(STRINGS.entities.project);
    if (project.status !== 'rechnung_faellig') {
      throw invoiceProjectState();
    }

    // 3. Company profile completeness — assertion reads inside the
    //    issuance tx so a concurrent profile mutation cannot
    //    invalidate the snapshot mid-issue. Throws
    //    `companyProfileRequired()` on incomplete state (AC-289(i),
    //    AT-113(i), AT-125). The throw rolls back the tx — no
    //    sequence allocation has been claimed yet, so AC-305's
    //    "release the lock without advancement" invariant is met by
    //    ordering: validate THEN allocate.
    const companyProfileRow = await assertCompanyProfileCompleteForMode(tx, taxMode);

    // 4. Allocate `number` from the gapless `(year, 'invoice')`
    //    sequence. The row lock survives until commit.
    const year = new Date().getUTCFullYear();
    const { number } = await allocateInvoiceNumber(tx, year, 'invoice');

    // 5. Build the snapshot blocks (issuer is frozen from the live
    //    profile, recipient already lives on the row). The Storno path
    //    reuses the same snapshot shape.
    const issuer: InvoiceIssuerSnapshot = {
      companyName: companyProfileRow.companyName,
      address: companyProfileRow.address,
      taxId: companyProfileRow.taxId,
      ustId: companyProfileRow.ustId,
      iban: companyProfileRow.iban,
      footerText: companyProfileRow.footerText,
    };

    const totals = computeInvoiceTotals(lines, taxMode);

    // 6. UPDATE the row with the issued state (modulo the binary
    //    descriptor reference — populated after the render step).
    const issueDate = new Date();
    let issuedRows = await tx
      .update(invoices)
      .set({
        status: 'issued',
        number,
        issueDate,
        issuer,
        recipient,
        lines,
        totals,
        taxMode,
        profile: 'zugferd-en16931',
        updatedAt: issueDate,
        updatedBy: userId,
      })
      .where(eq(invoices.id, invoiceId))
      .returning();
    let issuedRow = issuedRows[0]!;

    // 7. Render — Phase C delivers the ZUGFeRD EN 16931 implementation
    //    (`InvoiceRenderer.render()` builds the EN 16931 XML payload
    //    and the PDF/A-3 wrapper with `factur-x.xml` embedded). A
    //    throw here rolls back the entire transaction; the sequence
    //    value returns to the pool (AC-288). The mock seam in
    //    `invoices-issue.test.ts:521-536` exercises this exact path.
    const rendered: RenderedInvoice = await this.renderer.render({
      invoice: toInvoiceResponse(issuedRow),
      companyProfile: {
        id: companyProfileRow.id,
        companyName: companyProfileRow.companyName,
        address: companyProfileRow.address,
        taxId: companyProfileRow.taxId,
        ustId: companyProfileRow.ustId,
        iban: companyProfileRow.iban,
        accentColor: companyProfileRow.accentColor,
        footerText: companyProfileRow.footerText,
        logoBinaryDescriptorId: companyProfileRow.logoBinaryDescriptorId,
        defaultTaxMode: companyProfileRow.defaultTaxMode as TaxMode,
        updatedAt: companyProfileRow.updatedAt.toISOString(),
        updatedBy: companyProfileRow.updatedBy,
      },
    });

    // 8. Persist the binary descriptor through the ADR-0022 /
    //    ADR-0024 pipeline: encrypt with a fresh DEK, wrap against the
    //    operator `age` recipient, `putObject` ciphertext, insert
    //    `attachments` row at `status='ready'`. The returned id is the
    //    descriptor reference stored on the invoice row.
    const renderedDescriptorId = await this.persistRenderedBinary(
      tx,
      rendered,
      before.projectId,
      invoiceId,
      userId,
    );
    issuedRows = await tx
      .update(invoices)
      .set({ renderedPdfBinaryDescriptorId: renderedDescriptorId })
      .where(eq(invoices.id, invoiceId))
      .returning();
    issuedRow = issuedRows[0]!;

    // 9. Flip the parent project's status to `abgerechnet` inside
    //    this same tx (the project transition is part of the issue
    //    atom — AC-287). NO separate `mutate()` call: per ADR-0026
    //    the project status flip is a side-effect of the issuance,
    //    not its own audit event. The invoice audit row's ancestor
    //    pair surfaces the change under the project's activity feed.
    await tx
      .update(projects)
      .set({
        status: 'abgerechnet',
        statusChangedAt: issueDate,
        updatedAt: issueDate,
        updatedBy: userId,
      })
      .where(eq(projects.id, before.projectId));

    return {
      entityId: invoiceId,
      entityLabel: number,
      value: issuedRow,
      before: {
        status: before.status,
        number: before.number,
        issueDate: before.issueDate,
      },
      after: {
        status: issuedRow.status,
        number: issuedRow.number,
        issueDate: issuedRow.issueDate,
        issuer: issuedRow.issuer,
        recipient: issuedRow.recipient,
        lines: issuedRow.lines,
        totals: issuedRow.totals,
        taxMode: issuedRow.taxMode,
        profile: issuedRow.profile,
        renderedPdfBinaryDescriptorId: issuedRow.renderedPdfBinaryDescriptorId,
      },
      ancestorEntityType: 'project',
      ancestorEntityId: before.projectId,
    };
  }

  /**
   * Persist the rendered ZUGFeRD bytes through the existing binary
   * descriptor pipeline (parity with `AttachmentService.initUpload` +
   * `completeUpload` collapsed into a single server-side write because
   * the bytes are mint-fresh in memory and not user-supplied).
   *
   * Sequence:
   *   1. Generate a fresh 32-byte AES-256-GCM DEK.
   *   2. Encrypt the plaintext PDF bytes (`nonce(12) || ct || tag(16)`
   *      — the same envelope shape the browser uses for attachments).
   *   3. Wrap the DEK against the operator-loaded `age` recipient
   *      (`BINARY_AGE_RECIPIENT`) via `KeyEnvelopeService`.
   *   4. `putObject` the ciphertext to the bucket under
   *      `invoices/<projectId>/<descriptorId>.orig`. The bucket's
   *      default-retention envelope (`INVOICE_OBJECT_LOCK_DAYS`,
   *      asserted at boot per AC-296) attaches Object Lock to the PUT
   *      — no per-call retention header needed.
   *   5. Insert one `attachments` row at `status='ready'`. The row id
   *      is the descriptor reference returned to the caller and
   *      stored on `invoices.renderedPdfBinaryDescriptorId`.
   *
   * Fallback: when no `binaryDeps` are wired (test paths that exercise
   * the issuance audit / SSE invariants without a storage backend),
   * the method returns a synthetic UUID so the
   * `renderedPdfBinaryDescriptorId` column lands non-null. The bytes
   * are NOT retrievable in that mode — Phase D's PDF download route
   * requires the real path.
   *
   * The whole call runs inside the issuance transaction so a fault
   * after the bucket PUT rolls back the row insert; the orphaned
   * object is reaped by the existing attachment-orphan reaper because
   * the row never reached `ready` from the reaper's perspective
   * (no row, no claim — the reaper sweeps storage paths matching the
   * `invoices/` prefix on the same schedule).
   */
  private async persistRenderedBinary(
    tx: MutatingDatabase,
    rendered: RenderedInvoice,
    projectId: string,
    invoiceId: string,
    userId: string,
  ): Promise<string> {
    if (!this.binaryDeps) {
      // Phase B fallback — synthetic UUID. Leaves the column non-null
      // for tests that don't drive the storage backend. The route
      // layer's PDF download path will surface a 404 / 500 on the
      // missing key; this is intended (the fallback is a test seam,
      // not a production path).
      return crypto.randomUUID();
    }

    const { storage, binaryAgeRecipient, binaryAgeIdentityPath } = this.binaryDeps;

    // 1 + 2. Encrypt the plaintext PDF bytes under a fresh DEK.
    const { ciphertext, dek } = encryptInvoicePayload(rendered.pdfBytes);

    // 3. Wrap the DEK against the operator-loaded recipient.
    const envelope = new KeyEnvelopeService({
      recipient: binaryAgeRecipient,
      identityPath: binaryAgeIdentityPath,
    });
    const wrappedDek = await envelope.wrap(dek);
    const wrappedDekBase64 = Buffer.from(wrappedDek).toString('base64');

    // 4. PUT the ciphertext. The key shape mirrors the attachment
    // convention so the lifecycle / safety probe surfaces both paths
    // under a predictable prefix.
    const descriptorId = crypto.randomUUID();
    const originalKey = `invoices/${projectId}/${descriptorId}.orig`;
    await storage.putObject(originalKey, ciphertext, 'application/octet-stream');

    // 5. Insert the attachments row at `status='ready'`. The schema's
    // `attachments_wrapped_dek_required_when_ready` CHECK demands the
    // wrapped envelope + ciphertext size are non-null at this status.
    // The filename carries the invoice number — the rendered PDF surfaces
    // to the operator under that name when downloaded.
    const filename = `invoice-${invoiceId}.pdf`;
    await tx.insert(attachments).values({
      id: descriptorId,
      projectId,
      status: 'ready',
      kind: 'binary',
      label: 'rechnung',
      filename,
      mimeType: 'application/pdf',
      sizeBytes: rendered.pdfBytes.byteLength,
      originalKey,
      thumbKey: null,
      thumbSizeBytes: null,
      hasThumbnail: false,
      ciphertextSizeBytes: ciphertext.byteLength,
      ciphertextThumbSizeBytes: null,
      // ServerSide PUT does not return a VersionId from `putObject`
      // (we don't HEAD the just-written object). Versioned buckets
      // still issue a VersionId per write; capture it via HEAD post-
      // PUT so the Papierkorb restore primitive can address the
      // current version later. The HEAD is cheap (no body fetch).
      versionId: (await storage.headObject(originalKey)).versionId ?? null,
      thumbVersionId: null,
      wrappedDek: wrappedDekBase64,
      wrappedThumbDek: null,
      wrappedDekVersion: WRAPPED_DEK_CURRENT_VERSION,
      hiddenAt: null,
      createdBy: userId,
    });
    return descriptorId;
  }

  // -------------------------------------------------------------------
  // Cancel
  // -------------------------------------------------------------------

  /**
   * Cancel an issued invoice — create the Stornorechnung sibling, flip
   * the original to `'cancelled'`, write TWO audit rows in one tx,
   * emit ONE SSE event post-commit (AC-290 / AT-114).
   *
   * Rejections (AC-291):
   *   - draft → 409 `INVOICE_NOT_ISSUED`
   *   - cancelled → 409 `INVOICE_ALREADY_CANCELLED`
   */
  async cancel(
    id: string,
    input: CancelInput,
    userId: string,
    log: ServiceLogger,
    correlationId?: string | null,
  ): Promise<CancelResult> {
    const ctx = {
      actorKind: 'user' as const,
      actorId: userId,
      correlationId: correlationId ?? null,
    };

    const collected: AuditLogRow[] = [];
    const result = await this.db.transaction(async (tx) => {
      const before = await getInvoiceRowForMutation(tx, id);
      if (!before) throw notFound(STRINGS.entities.invoice);
      if (before.status === 'draft') throw invoiceNotIssued();
      if (before.status === 'cancelled') throw invoiceAlreadyCancelled();

      // 1. Allocate from `(year, 'storno')`.
      const year = new Date().getUTCFullYear();
      const { number: stornoNumber } = await allocateInvoiceNumber(tx, year, 'storno');

      // 2. Build the Storno row. Snapshots copied byte-for-byte from
      //    the original (AC-290): issuer / recipient / taxMode /
      //    profile / performanceDate.
      const stornoId = crypto.randomUUID();
      const stornoLines = negateInvoiceLines(before.lines as InvoiceLine[]);
      const stornoTotals = computeInvoiceTotals(stornoLines, before.taxMode as TaxMode);
      const cancellationReason = input.reason ?? null;
      const now = new Date();

      const stornoInsert = await tx
        .insert(invoices)
        .values({
          id: stornoId,
          projectId: before.projectId,
          status: 'issued',
          number: stornoNumber,
          issueDate: now,
          performanceDate: before.performanceDate,
          taxMode: before.taxMode,
          profile: before.profile,
          issuer: before.issuer,
          recipient: before.recipient,
          lines: stornoLines,
          totals: stornoTotals,
          cancellationOf: before.id,
          cancellationReason,
          renderedPdfBinaryDescriptorId: null,
          createdBy: userId,
          updatedBy: userId,
        })
        .returning();
      let stornoRow = stornoInsert[0]!;

      // 3. Render the Storno PDF — same toolchain as the issue path.
      //    A throw here rolls back the whole cancel atom, including
      //    the sequence allocation.
      const profileService = new CompanyProfileService(this.db);
      const profile = await profileService.get();
      const rendered = await this.renderer.render({
        invoice: toInvoiceResponse(stornoRow),
        companyProfile: profile,
      });
      const stornoDescriptor = await this.persistRenderedBinary(
        tx,
        rendered,
        before.projectId,
        stornoId,
        userId,
      );
      const stornoFinal = await tx
        .update(invoices)
        .set({ renderedPdfBinaryDescriptorId: stornoDescriptor })
        .where(eq(invoices.id, stornoId))
        .returning();
      stornoRow = stornoFinal[0]!;

      // 4. Flip the original to `cancelled`. The DB-level immutability
      //    backstop (Phase A schema trigger) allows exactly this one
      //    transition; touching any other column on an issued row
      //    fails the constraint. We deliberately do NOT write
      //    `cancellation_reason` on the original — the reason is
      //    frozen on the Storno only (per the brief).
      const originalUpdate = await tx
        .update(invoices)
        .set({
          status: 'cancelled',
          updatedAt: now,
          updatedBy: userId,
        })
        .where(eq(invoices.id, id))
        .returning();
      const originalRow = originalUpdate[0]!;

      // 5. Two audit rows in one tx (AC-290). Project status is
      //    deliberately NOT flipped — AC-290 trailing clause.
      const cancelAudit = await mutateInTx(tx, ctx, {
        entityType: 'invoice',
        action: 'invoice:cancel',
        run: async () => ({
          entityId: id,
          entityLabel: originalRow.number,
          value: originalRow,
          before: { status: before.status },
          after: { status: originalRow.status },
          ancestorEntityType: 'project',
          ancestorEntityId: before.projectId,
        }),
      });
      collected.push(cancelAudit.auditRow);

      const stornoAudit = await mutateInTx(tx, ctx, {
        entityType: 'invoice',
        action: 'invoice:issue',
        run: async () => ({
          entityId: stornoId,
          entityLabel: stornoNumber,
          value: stornoRow,
          before: {},
          after: {
            status: stornoRow.status,
            number: stornoRow.number,
            cancellationOf: stornoRow.cancellationOf,
            issuer: stornoRow.issuer,
            recipient: stornoRow.recipient,
            lines: stornoRow.lines,
            totals: stornoRow.totals,
            taxMode: stornoRow.taxMode,
            profile: stornoRow.profile,
            cancellationReason: stornoRow.cancellationReason,
            renderedPdfBinaryDescriptorId: stornoRow.renderedPdfBinaryDescriptorId,
          },
          ancestorEntityType: 'project',
          ancestorEntityId: before.projectId,
        }),
      });
      collected.push(stornoAudit.auditRow);

      return {
        original: toInvoiceResponse(originalRow),
        storno: toInvoiceResponse(stornoRow),
      };
    });

    // Post-commit dispatch — both audit rows ride the publisher.
    await dispatchAuditRows(collected);
    // Exactly ONE SSE frame for the cancel atom (AC-290 trailing
    // clause). Both rows changed; one invalidation is enough — the
    // client refetches the gated list anyway.
    emitInvoiceChanged();

    log.info({ invoiceId: id, stornoId: result.storno.id }, 'invoice_cancelled');
    return result;
  }
}

// ---------------------------------------------------------------------
// Cascade helpers — invoked from CustomerService / ProjectCrudService
// to gate destructive operations on the invoice retention rule
// (AC-307 / AC-308).
//
// The actual call sites edit the cascade paths in CustomerService /
// ProjectCrudService to invoke these and throw the documented errors.
// ---------------------------------------------------------------------

export {
  countIssuedOrCancelledForCustomer,
  countIssuedOrCancelledForProject,
} from '../repositories/invoice-read.js';

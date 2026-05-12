/**
 * Invoice routes — per-project draft CRUD plus issue / cancel / PDF
 * download (ADR-0026, api.md §14.2.14).
 *
 * Each handler is a thin HTTP adapter:
 *   - parse + Ajv-validate the request,
 *   - dispatch to `InvoiceService` for the domain logic and audit boundary,
 *   - format the response (and, for PDF, decrypt + stream the bytes).
 *
 * Authorization model:
 *   - `invoice:read` for list / get / pdf,
 *   - `invoice:write` for create / patch / delete / issue / cancel.
 * Worker holds neither; the repository-predicate scope (ADR-0019) also
 * narrows worker reads to the empty set as a structural backstop.
 *
 * The PDF download path retrieves the rendered ciphertext via the
 * attachment binary-descriptor reference, unwraps the row's `wrappedDek`
 * server-side, decrypts in memory, and streams the plaintext as
 * `application/pdf`. This mirrors the api.md §14.2.14 "Download PDF"
 * line which permits either inline bytes or a presigned-GET wrapper;
 * the inline path keeps the contract simple (no extra round-trip,
 * single-origin response) and matches the boot-time identity-loaded
 * invariant (ADR-0024).
 */

import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/connection.js';
import { createAuthMiddleware, requirePermission } from '../middleware/auth.js';
import {
  InvoiceService,
  type InvoiceBinaryDeps,
  type ListInvoicesOpts,
} from '../services/InvoiceService.js';
import { createStorageClient } from '../storage/client.js';
import { getEnv } from '../config/env.js';
import type { InvoiceLine, InvoiceRecipientSnapshot, TaxMode } from '../../domain/invoice.js';
import { TAX_MODES, INVOICE_STATUSES } from '../../domain/invoice.js';

/**
 * Shared JSON-schema fragment for an `InvoiceLine`. Routes accept the
 * fully-derived shape (the client computes `lineTotal` on each line so
 * the wire shape is concrete); the service re-validates and the server
 * re-derives `totals` from `lines + taxMode` on every successful write
 * (AC-286).
 */
const lineSchema = {
  type: 'object',
  required: ['description', 'quantity', 'unit', 'unitPrice', 'lineTotal', 'taxRate'],
  additionalProperties: false,
  properties: {
    description: { type: 'string' },
    quantity: { type: 'number' },
    unit: { type: 'string' },
    unitPrice: { type: 'number' },
    lineTotal: { type: 'number' },
    taxRate: { type: 'number' },
  },
} as const;

const recipientSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    address: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['street', 'zip', 'city'],
      properties: {
        street: { type: 'string' },
        zip: { type: 'string' },
        city: { type: 'string' },
      },
    },
    ustId: { type: ['string', 'null'] },
  },
} as const;

/**
 * Build the `InvoiceBinaryDeps` for the service from validated env.
 * `assertAppServerEnv` enforces presence of STORAGE_* / BINARY_AGE_RECIPIENT
 * at boot (env.ts § app-server presence predicate); BINARY_AGE_IDENTITY_PATH
 * has a schema-level default. If any of these are missing at route
 * registration we throw — the app should never have started.
 */
function buildInvoiceBinaryDeps(): InvoiceBinaryDeps {
  const env = getEnv();
  if (
    !env.STORAGE_ENDPOINT ||
    !env.STORAGE_ACCESS_KEY ||
    !env.STORAGE_SECRET_KEY ||
    !env.BINARY_AGE_RECIPIENT ||
    !env.BINARY_AGE_IDENTITY_PATH
  ) {
    throw new Error(
      'Refusing to register invoice routes: STORAGE_* and BINARY_AGE_RECIPIENT / ' +
        'BINARY_AGE_IDENTITY_PATH are required for invoice binary persistence. ' +
        'assertAppServerEnv should have rejected this configuration at boot — see ' +
        'src/server/config/env.ts.',
    );
  }
  const storage = createStorageClient({
    endpoint: env.STORAGE_ENDPOINT,
    publicEndpoint: env.STORAGE_PUBLIC_ENDPOINT,
    bucket: env.STORAGE_BUCKET,
    accessKey: env.STORAGE_ACCESS_KEY,
    secretKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION,
  });
  return {
    storage,
    binaryAgeRecipient: env.BINARY_AGE_RECIPIENT,
    binaryAgeIdentityPath: env.BINARY_AGE_IDENTITY_PATH,
  };
}

export function invoiceRoutes(db: Database) {
  return async function (app: FastifyInstance): Promise<void> {
    const authenticate = createAuthMiddleware(db);
    const binaryDeps = buildInvoiceBinaryDeps();
    const service = new InvoiceService(db, binaryDeps);

    app.addHook('preHandler', authenticate);

    // ---------------------------------------------------------------
    // GET /api/invoices — list.
    //
    // No `invoice:read` permission gate (AC-298, AT-119): worker holds
    // no invoice permission but the repository-predicate scope
    // (ADR-0019) returns the empty set for worker callers — structural
    // exclusion rather than 403. A permission gate here would surface
    // worker calls as 403 instead of `200 + { data: [] }`, contrary to
    // the spec. The authenticated-session preHandler still runs so
    // unauthenticated callers see 401.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices',
      {
        schema: {
          querystring: {
            type: 'object',
            properties: {
              offset: { type: 'integer', minimum: 0 },
              limit: { type: 'integer', minimum: 1, maximum: 500 },
              status: { type: 'string', enum: [...INVOICE_STATUSES] },
              year: { type: 'integer', minimum: 1900, maximum: 9999 },
              projectId: { type: 'string', format: 'uuid' },
              customerId: { type: 'string', format: 'uuid' },
              includeCancelled: { type: 'string', enum: ['true', 'false'] },
              search: { type: 'string' },
            },
          },
        },
      },
      async (request, reply) => {
        const q = request.query as {
          offset?: number;
          limit?: number;
          status?: ListInvoicesOpts['status'];
          year?: number;
          projectId?: string;
          customerId?: string;
          includeCancelled?: 'true' | 'false';
          search?: string;
        };
        const opts: ListInvoicesOpts = {
          ...(q.offset !== undefined ? { offset: q.offset } : {}),
          ...(q.limit !== undefined ? { limit: q.limit } : {}),
          ...(q.status !== undefined ? { status: q.status } : {}),
          ...(q.year !== undefined ? { year: q.year } : {}),
          ...(q.projectId !== undefined ? { projectId: q.projectId } : {}),
          ...(q.customerId !== undefined ? { customerId: q.customerId } : {}),
          // Default `true` per api.md §14.2.14; the repo treats undefined
          // as the default so explicit absence and explicit `true` are
          // observationally equivalent.
          ...(q.includeCancelled === 'false' ? { includeCancelled: false } : {}),
          ...(q.search !== undefined ? { search: q.search } : {}),
        };
        const result = await service.list(request.user!, opts);
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/invoices/:id — three-way 200 / 403 / 404 (AC-298).
    //
    // No `invoice:read` permission gate: the service's three-way result
    // (in-scope row / OUT_OF_SCOPE / null) maps to 200 / 403 / 404. A
    // worker hitting an existing row gets 403 via `notPermitted()`
    // raised from the OUT_OF_SCOPE branch; a worker hitting an unknown
    // id gets 404 from the null branch. A permission gate here would
    // collapse both worker arms to 403 — including the unknown-id
    // arm — and contradict AT-119's 404 expectation.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const invoice = await service.get(request.user!, id);
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices — create draft
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices',
      {
        schema: {
          body: {
            type: 'object',
            required: ['projectId'],
            additionalProperties: false,
            properties: {
              projectId: { type: 'string', format: 'uuid' },
              lines: { type: 'array', items: lineSchema },
              recipient: recipientSchema,
              taxMode: { type: 'string', enum: [...TAX_MODES] },
              performanceDate: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const body = request.body as {
          projectId: string;
          lines?: InvoiceLine[];
          recipient?: InvoiceRecipientSnapshot;
          taxMode?: TaxMode;
          performanceDate?: string | null;
        };
        const invoice = await service.createDraft(
          {
            projectId: body.projectId,
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            ...(body.recipient !== undefined ? { recipient: body.recipient } : {}),
            ...(body.taxMode !== undefined ? { taxMode: body.taxMode } : {}),
            ...(body.performanceDate !== undefined
              ? { performanceDate: body.performanceDate }
              : {}),
          },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(201).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // PATCH /api/invoices/:id — update draft (INVOICE_FROZEN on issued/cancelled)
    // ---------------------------------------------------------------
    app.patch(
      '/api/invoices/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: 'object',
            additionalProperties: false,
            properties: {
              lines: { type: 'array', items: lineSchema },
              recipient: recipientSchema,
              taxMode: { type: 'string', enum: [...TAX_MODES] },
              performanceDate: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = request.body as {
          lines?: InvoiceLine[];
          recipient?: InvoiceRecipientSnapshot;
          taxMode?: TaxMode;
          performanceDate?: string | null;
        };
        const invoice = await service.updateDraft(
          id,
          {
            ...(body.lines !== undefined ? { lines: body.lines } : {}),
            ...(body.recipient !== undefined ? { recipient: body.recipient } : {}),
            ...(body.taxMode !== undefined ? { taxMode: body.taxMode } : {}),
            // The service treats `'performanceDate' in input` as the
            // touch-marker, so forward the body key only when the
            // caller actually sent it.
            ...('performanceDate' in body ? { performanceDate: body.performanceDate ?? null } : {}),
          },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // DELETE /api/invoices/:id — hard-delete draft (INVOICE_FROZEN otherwise)
    // ---------------------------------------------------------------
    app.delete(
      '/api/invoices/:id',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        await service.deleteDraft(id, request.user!.id, request.log, request.id ?? null);
        return reply.code(204).send();
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices/:id/issue — issuance transaction (AC-287)
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices/:id/issue',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const invoice = await service.issueDraft(
          id,
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(invoice);
      },
    );

    // ---------------------------------------------------------------
    // POST /api/invoices/:id/cancel — Storno atom (AC-290)
    // ---------------------------------------------------------------
    app.post(
      '/api/invoices/:id/cancel',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
          body: {
            type: ['object', 'null'],
            additionalProperties: false,
            properties: {
              reason: { type: ['string', 'null'] },
            },
          },
        },
        preHandler: requirePermission('invoice:write'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { reason?: string | null };
        const result = await service.cancel(
          id,
          { ...(body.reason !== undefined ? { reason: body.reason } : {}) },
          request.user!.id,
          request.log,
          request.id ?? null,
        );
        return reply.code(200).send(result);
      },
    );

    // ---------------------------------------------------------------
    // GET /api/invoices/:id/pdf — download rendered ZUGFeRD bytes.
    //
    // Three-way auth response (200 / 403 / 404) follows the get path
    // (AC-298). Draft → 409 INVOICE_NOT_ISSUED (AC-299). Bytes are
    // retrieved by fetching the rendered-PDF attachment row, unwrapping
    // its `wrappedDek` server-side, decrypting the ciphertext fetched
    // from object storage, and streaming the plaintext as
    // `application/pdf` with a Content-Disposition naming the invoice.
    // ---------------------------------------------------------------
    app.get(
      '/api/invoices/:id/pdf',
      {
        schema: {
          params: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string', format: 'uuid' } },
          },
        },
        preHandler: requirePermission('invoice:read'),
      },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        const { bytes, filename } = await service.downloadPdf(request.user!, id);
        return reply
          .code(200)
          .header('Content-Type', 'application/pdf')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('Content-Length', String(bytes.byteLength))
          .send(Buffer.from(bytes));
      },
    );
  };
}

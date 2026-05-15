/**
 * Per-render XSD validation of the embedded `factur-x.xml` payload
 * against the EN 16931 Comfort schema bundle.
 *
 * Why this exists: the XML builder (`facturXmlBuilder.ts`) is hand-
 * rolled with EN 16931 element-order pins. A future tax-mode addition
 * or refactor can silently produce an XML that the integration test
 * doesn't exercise; per the project's "refuse to serve" principle, the
 * issuance transaction validates the payload before the binary lands on
 * B2 and rolls back on failure. Industry shape: Mustangproject (Java),
 * akretion factur-x (Python), and SAP/Datev e-invoicing all XSD-validate
 * at render time.
 *
 * The XSD bundle is the canonical Factur-X 1.07.2 / EN 16931 Comfort set
 * (entry XSD + 3 imported UN/CEFACT siblings: QualifiedDataType_100,
 * ReusableAggregateBusinessInformationEntity_100, UnqualifiedDataType_100).
 * Sourced from `akretion/factur-x@d7fa1e7`. Import-path layout preserved
 * so xmllint resolves siblings during validation via `preload`.
 *
 * Validator: `xmllint-wasm` (libxml2 compiled to WebAssembly). Chosen
 * over the previous native binding (`libxmljs2`, marked "NO LONGER
 * MAINTAINED" upstream) to drop an unmaintained native dependency from
 * the tree. The WASM build of xmllint ships with no HTTP loader and
 * only Emscripten's in-memory FS, so the previous `nonet`/`dtdload`
 * defense-in-depth flags have nothing to guard against in this build.
 *
 * Cost shape (acknowledged tradeoff): `xmllint-wasm` forks a fresh
 * `worker_threads.Worker` and recompiles the schema inside it on every
 * `validateXML` call. The disk read is cached below; the worker fork
 * and schema recompile are not — the library exposes no parsed-schema
 * handle to persist. Acceptable for human-paced single-invoice
 * issuance; if bulk re-validation is introduced, move to a long-lived
 * worker or to a WASM library that persists the schema handle.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateXML, type XMLFileInfo } from 'xmllint-wasm';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const XSD_DIR = path.resolve(__dirname, './xsd');
const MAIN_XSD = 'Factur-X_1.07.2_EN16931.xsd';
const IMPORTED_XSDS = [
  'Factur-X_1.07.2_EN16931_urn_un_unece_uncefact_data_standard_QualifiedDataType_100.xsd',
  'Factur-X_1.07.2_EN16931_urn_un_unece_uncefact_data_standard_ReusableAggregateBusinessInformationEntity_100.xsd',
  'Factur-X_1.07.2_EN16931_urn_un_unece_uncefact_data_standard_UnqualifiedDataType_100.xsd',
] as const;

interface SchemaBundle {
  readonly schema: XMLFileInfo;
  readonly preload: ReadonlyArray<XMLFileInfo>;
}

/**
 * Cache only what the library lets us cache: the file contents. The
 * worker fork and schema recompile happen per call (see file header).
 * `fileName` values match the bare `schemaLocation` references in the
 * main XSD so xmllint resolves the imports from the in-memory FS.
 */
let cachedBundle: SchemaBundle | null = null;

function getSchemaBundle(): SchemaBundle {
  if (cachedBundle) return cachedBundle;
  cachedBundle = {
    schema: {
      fileName: MAIN_XSD,
      contents: readFileSync(path.join(XSD_DIR, MAIN_XSD), 'utf-8'),
    },
    preload: IMPORTED_XSDS.map((fileName) => ({
      fileName,
      contents: readFileSync(path.join(XSD_DIR, fileName), 'utf-8'),
    })),
  };
  return cachedBundle;
}

export class FacturXValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invoice XML failed EN 16931 XSD validation:\n${errors.join('\n')}`);
    this.name = 'FacturXValidationError';
    this.errors = errors;
  }
}

/**
 * Validate the rendered `factur-x.xml` against EN 16931. Throws on
 * any schema violation so the caller's transaction rolls back before
 * a non-conformant binary is written to B2.
 */
export async function validateFacturXml(xml: string): Promise<void> {
  const bundle = getSchemaBundle();
  const result = await validateXML({
    xml: { fileName: 'factur-x.xml', contents: xml },
    schema: bundle.schema,
    preload: bundle.preload,
  });
  if (!result.valid) {
    const errors = result.errors.map((e) => e.message);
    throw new FacturXValidationError(errors);
  }
}

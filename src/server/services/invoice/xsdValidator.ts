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
 * so libxml2 resolves siblings during validation.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as libxml from 'libxmljs2';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const XSD_ROOT = path.resolve(__dirname, './xsd/Factur-X_1.07.2_EN16931.xsd');

/**
 * Parsing the 4-file XSD tree (with `baseUrl` resolving siblings) is
 * non-trivial; the schema is process-static so the parsed doc is cached
 * after the first call. The cache is keyed on the module, not on a
 * mutable singleton — re-imports get a fresh parse, but a single-process
 * server hits the parser exactly once.
 */
let cachedXsdDoc: libxml.Document | null = null;

function getXsdDoc(): libxml.Document {
  if (cachedXsdDoc) return cachedXsdDoc;
  cachedXsdDoc = libxml.parseXml(readFileSync(XSD_ROOT, 'utf-8'), { baseUrl: XSD_ROOT });
  return cachedXsdDoc;
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
export function validateFacturXml(xml: string): void {
  const xsdDoc = getXsdDoc();
  const xmlDoc = libxml.parseXml(xml);
  if (!xmlDoc.validate(xsdDoc)) {
    const errors = (xmlDoc.validationErrors ?? []).map((e) => String(e.message ?? e));
    throw new FacturXValidationError(errors);
  }
}

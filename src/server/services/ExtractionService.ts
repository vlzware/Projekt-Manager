/**
 * Extraction service — LLM-based email data extraction via OpenRouter.
 *
 * Takes raw email text, sends it to OpenRouter with a structured prompt,
 * and returns extracted customer + project fields. See ADR-0016.
 */

import { getEnv } from '../config/env.js';
import { STRINGS } from '../../config/strings.js';
import { validationError, serverError } from '../errors.js';
import type { ServiceLogger } from './Logger.js';

export interface ExtractionResult {
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    street: string | null;
    zip: string | null;
    city: string | null;
  };
  project: {
    title: string | null;
    description: string | null;
  };
}

const SYSTEM_PROMPT = `Du bist ein Datenextraktor für ein Handwerker-Projektmanagement-System.
Extrahiere aus der folgenden E-Mail die Kundendaten und Projektdaten.

Antworte ausschließlich mit validem JSON im folgenden Format, ohne Erklärungen:
{
  "customer": {
    "name": "Kundenname oder null",
    "phone": "Telefonnummer oder null",
    "email": "E-Mail-Adresse oder null",
    "street": "Straße und Hausnummer oder null",
    "zip": "Postleitzahl oder null",
    "city": "Ort oder null"
  },
  "project": {
    "title": "Kurzer Projekttitel oder null",
    "description": "Kurze Projektbeschreibung oder null"
  }
}

Regeln:
- Extrahiere nur Informationen, die tatsächlich in der E-Mail stehen.
- Setze Felder auf null, wenn die Information nicht vorhanden ist.
- Der Projekttitel soll kurz und beschreibend sein (z.B. "Fassadenanstrich Einfamilienhaus").
- Kundenname: bevorzuge den Firmennamen, falls vorhanden, sonst den Personennamen.`;

/**
 * Validate and clamp an LLM-extracted field: must be a string or null,
 * truncated to maxLen to match DB column limits. Non-string values → null.
 */
function clampStr(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

export class ExtractionService {
  async extract(emailText: string, log: ServiceLogger): Promise<ExtractionResult> {
    const env = getEnv();

    if (!env.OPENROUTER_API_KEY) {
      throw validationError(STRINGS.extraction.notConfigured);
    }

    if (!emailText.trim()) {
      throw validationError(STRINGS.extraction.emptyInput);
    }

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        },
        body: JSON.stringify({
          model: env.OPENROUTER_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: emailText },
          ],
        }),
      });

      if (!response.ok) {
        log.error({ status: response.status }, 'openrouter_api_error');
        throw serverError();
      }

      const data = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };

      const rawContent = data.choices?.[0]?.message?.content;
      if (!rawContent) {
        log.error({}, 'openrouter_empty_response');
        throw serverError();
      }

      // Strip markdown code fences — LLMs often wrap JSON in ```json ... ```
      // Try boundary-based stripping first, fall back to finding first { and last }
      let content = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      if (!content.trimStart().startsWith('{')) {
        const first = rawContent.indexOf('{');
        const last = rawContent.lastIndexOf('}');
        if (first !== -1 && last > first) {
          content = rawContent.slice(first, last + 1);
        }
      }

      const parsed = JSON.parse(content) as Record<string, unknown>;

      // Runtime validation: ensure the parsed structure has the expected shape
      // and all fields are strings or null, clamped to DB column max lengths.
      const customer =
        typeof parsed.customer === 'object' && parsed.customer !== null
          ? (parsed.customer as Record<string, unknown>)
          : {};
      const project =
        typeof parsed.project === 'object' && parsed.project !== null
          ? (parsed.project as Record<string, unknown>)
          : {};

      log.info({}, 'extraction_completed');
      return {
        customer: {
          name: clampStr(customer.name, 255),
          phone: clampStr(customer.phone, 100),
          email: clampStr(customer.email, 255),
          street: clampStr(customer.street, 255),
          zip: clampStr(customer.zip, 20),
          city: clampStr(customer.city, 255),
        },
        project: {
          title: clampStr(project.title, 500),
          description: clampStr(project.description, 10000),
        },
      };
    } catch (err) {
      if (err instanceof SyntaxError) {
        log.error({ err }, 'extraction_json_parse_failed');
        throw serverError();
      }
      throw err;
    }
  }
}

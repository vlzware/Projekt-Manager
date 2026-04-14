/**
 * Sample emails for testing LLM extraction.
 *
 * Used by extraction unit tests and available for manual testing
 * (copy-paste into the E-Mail Import modal).
 *
 * Each entry has a description, the raw email text, and the expected
 * extraction result (what a correct extraction should produce).
 */

export interface SampleEmail {
  /** Short description of what this sample tests. */
  description: string;
  /** Raw email text to paste / feed to the extractor. */
  text: string;
  /** Expected extraction output (for assertions and reference). */
  expected: {
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
  };
}

export const SAMPLE_EMAILS: SampleEmail[] = [
  // ---------------------------------------------------------------
  // 1. Complete email — all fields present
  // ---------------------------------------------------------------
  {
    description: 'Vollständige Anfrage mit allen Feldern',
    text: `Sehr geehrte Damen und Herren,

wir möchten Sie bitten, uns ein Angebot für die Renovierung unserer Büroräume zu erstellen.
Es handelt sich um ca. 200 qm Bürofläche. Die Arbeiten umfassen Malerarbeiten (Wände und Decken)
sowie die Erneuerung des Bodenbelags in drei Büroräumen.

Mit freundlichen Grüßen,
Hans Meier
Geschäftsführer
Meier & Partner Steuerberatung GmbH
Tel: +49 2202 98765
E-Mail: h.meier@meier-partner.de
Hauptstraße 42
51465 Bergisch Gladbach`,
    expected: {
      customer: {
        name: 'Meier & Partner Steuerberatung GmbH',
        phone: '+49 2202 98765',
        email: 'h.meier@meier-partner.de',
        street: 'Hauptstraße 42',
        zip: '51465',
        city: 'Bergisch Gladbach',
      },
      project: {
        title: 'Renovierung Büroräume',
        description: 'Malerarbeiten und Bodenbelag, ca. 200 qm',
      },
    },
  },

  // ---------------------------------------------------------------
  // 2. Private person — no company name
  // ---------------------------------------------------------------
  {
    description: 'Privatperson ohne Firmenname',
    text: `Hallo,

ich suche einen Maler für unser Wohnzimmer und Flur. Die Wände müssen neu gestrichen werden,
ca. 60 qm. Wann hätten Sie Zeit?

Viele Grüße
Sabine Krüger
Tel 0221 / 334455`,
    expected: {
      customer: {
        name: 'Sabine Krüger',
        phone: '0221 / 334455',
        email: null,
        street: null,
        zip: null,
        city: null,
      },
      project: {
        title: 'Malerarbeiten Wohnzimmer und Flur',
        description: 'Wände streichen, ca. 60 qm',
      },
    },
  },

  // ---------------------------------------------------------------
  // 3. Minimal email — almost no structured data
  // ---------------------------------------------------------------
  {
    description: 'Minimale Anfrage, kaum Daten',
    text: `Können Sie bei uns vorbeikommen und sich das mal anschauen?
Wir bräuchten einen neuen Anstrich.

Gruß, Herr Schmidt`,
    expected: {
      customer: {
        name: 'Herr Schmidt',
        phone: null,
        email: null,
        street: null,
        zip: null,
        city: null,
      },
      project: {
        title: 'Anstricharbeiten',
        description: null,
      },
    },
  },

  // ---------------------------------------------------------------
  // 4. Reply chain with quoted text
  // ---------------------------------------------------------------
  {
    description: 'Antwort mit zitiertem Text (Reply-Chain)',
    text: `Ja, das passt. Bitte kommen Sie am Montag vorbei.

Am 10.04.2026 um 14:32 schrieb info@malerbetrieb.de:
> Sehr geehrter Herr Hoffmann,
>
> vielen Dank für Ihre Anfrage. Wir können den Fassadenanstrich
> gerne übernehmen. Wäre nächste Woche ein Termin möglich?
>
> Mit freundlichen Grüßen,
> Malerbetrieb Weber

--
Peter Hoffmann
Hoffmann Immobilien GmbH & Co. KG
Bonner Str. 15, 50677 Köln
Tel: 0221 9988776
peter@hoffmann-immo.de`,
    expected: {
      customer: {
        name: 'Hoffmann Immobilien GmbH & Co. KG',
        phone: '0221 9988776',
        email: 'peter@hoffmann-immo.de',
        street: 'Bonner Str. 15',
        zip: '50677',
        city: 'Köln',
      },
      project: {
        title: 'Fassadenanstrich',
        description: null,
      },
    },
  },

  // ---------------------------------------------------------------
  // 5. English email
  // ---------------------------------------------------------------
  {
    description: 'Englische E-Mail',
    text: `Dear Sir or Madam,

We are looking for a painting contractor to repaint the interior of our office
at Bahnhofstraße 7, 51465 Bergisch Gladbach. Approximately 150 sqm.

Please send us a quote.

Best regards,
John Miller
International Consulting Ltd.
john@ic-consulting.com
+49 170 1234567`,
    expected: {
      customer: {
        name: 'International Consulting Ltd.',
        phone: '+49 170 1234567',
        email: 'john@ic-consulting.com',
        street: 'Bahnhofstraße 7',
        zip: '51465',
        city: 'Bergisch Gladbach',
      },
      project: {
        title: 'Innenanstrich Büro',
        description: 'Interior painting, 150 sqm',
      },
    },
  },

  // ---------------------------------------------------------------
  // 6. Weak formatting — no signature block
  // ---------------------------------------------------------------
  {
    description: 'Schwache Formatierung, keine Signatur',
    text: `hallo wir bräuchten jemanden der unsere wohnung streicht. 3 zimmer küche bad.
adresse ist mülheimer str 23 in 51063 köln. meine nummer ist 0176-5554433.
bitte melden sie sich.
gruß maria weber`,
    expected: {
      customer: {
        name: 'Maria Weber',
        phone: '0176-5554433',
        email: null,
        street: 'Mülheimer Str. 23',
        zip: '51063',
        city: 'Köln',
      },
      project: {
        title: 'Wohnung streichen',
        description: '3 Zimmer, Küche, Bad',
      },
    },
  },

  // ---------------------------------------------------------------
  // 7. Multiple projects mentioned
  // ---------------------------------------------------------------
  {
    description: 'Mehrere Projekte in einer E-Mail',
    text: `Guten Tag,

wir haben zwei Objekte, die gestrichen werden müssen:
1. Einfamilienhaus in der Gartenstr. 5, Rösrath — Fassade komplett
2. Doppelhaushälfte Am Sonnenhang 12, Rösrath — nur Innenräume

Bitte erstellen Sie uns für beides ein Angebot.

Freundliche Grüße,
Thomas Schulz
Schulz Hausverwaltung
0 22 05 / 12 34 56
schulz@hausverwaltung-schulz.de`,
    expected: {
      customer: {
        name: 'Schulz Hausverwaltung',
        phone: '0 22 05 / 12 34 56',
        email: 'schulz@hausverwaltung-schulz.de',
        street: null,
        zip: null,
        city: null,
      },
      project: {
        title: 'Fassaden- und Innenanstrich',
        description: 'Zwei Objekte in Rösrath: Fassade EFH + Innenräume DHH',
      },
    },
  },

  // ---------------------------------------------------------------
  // 8. Only customer data, no project
  // ---------------------------------------------------------------
  {
    description: 'Nur Kundendaten, kein konkretes Projekt',
    text: `Guten Tag,

ein Bekannter hat Sie empfohlen. Ich würde mich gerne mal beraten lassen,
was bei uns so alles gemacht werden könnte. Können Sie mich zurückrufen?

Frau Dr. Elisabeth Braun
Praxis für Zahnmedizin
Kölner Str. 88
51429 Bergisch Gladbach
Tel: 02204 / 77 88 99`,
    expected: {
      customer: {
        name: 'Praxis für Zahnmedizin Dr. Elisabeth Braun',
        phone: '02204 / 77 88 99',
        email: null,
        street: 'Kölner Str. 88',
        zip: '51429',
        city: 'Bergisch Gladbach',
      },
      project: {
        title: null,
        description: null,
      },
    },
  },
];

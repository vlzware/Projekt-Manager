/**
 * Centralized German UI and error strings.
 *
 * All user-facing text lives here so that:
 * - Strings are identifiable and grouped (spec §11.5, §12.2)
 * - Future i18n extraction has a single source
 * - The same message used in multiple places stays consistent
 *
 * Convention: keys are English, values are German.
 * Template functions accept parameters and return the composed string.
 */

export const STRINGS = {
  auth: {
    loginButton: 'Anmelden',
    username: 'Benutzername',
    password: 'Passwort',
    logout: 'Abmelden',
    loginFailed: 'Anmeldung fehlgeschlagen.',
    unauthenticated: 'Nicht angemeldet.',
    sessionExpired: 'Sitzung abgelaufen.',
    sessionExpiredLogin: 'Sitzung abgelaufen. Bitte erneut anmelden.',
    notPermitted: 'Keine Berechtigung.',
  },

  errors: {
    mutationFailed: 'Änderung fehlgeschlagen. Bitte erneut versuchen.',
    networkError: 'Netzwerkfehler. Bitte Verbindung überprüfen.',
    invalidResponse: 'Server-Antwort ungültig. Bitte erneut versuchen.',
    rateLimited: 'Zu viele Anfragen. Bitte später erneut versuchen.',
    serverError: 'Ein interner Fehler ist aufgetreten.',
    invalidInput: 'Ungültige Eingabe.',
    notFound: (entity: string) => `${entity} nicht gefunden.`,
    idempotencyConflict: 'Diese Anfrage-ID wurde bereits mit abweichenden Daten verwendet.',
    schemaVersionMismatch:
      'Die Datenformat-Version der Datei passt nicht zur aktuellen Version des Systems.',
    targetNotEmpty:
      'Die Datenbank ist nicht leer. Bestätigen Sie das Überschreiben, um fortzufahren.',
  },

  entities: {
    project: 'Projekt',
    customer: 'Kunde',
    user: 'Benutzer',
    resource: 'Ressource',
  },

  states: {
    anfrage: 'Anfrage',
    angebot: 'Angebot',
    beauftragt: 'Beauftragt',
    geplant: 'Geplant',
    in_arbeit: 'In Arbeit',
    abnahme: 'Abnahme',
    rechnung_faellig: 'Rechnung fällig',
    abgerechnet: 'Abgerechnet',
    erledigt: 'Erledigt',
  },

  projects: {
    noDate: 'Kein Termin',
    numberTaken: (n: string) => `Projektnummer "${n}" ist bereits vergeben.`,
    numberAvailable: 'Verfügbar',
    transitionConfirm: (from: string, to: string) => `Status ändern: ${from} → ${to}?`,
    cannotAdvanceTerminal:
      'Projekt kann nicht weiter vorgerückt werden. Der aktuelle Status ist ein Endstatus.',
    cannotRevertFirst:
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist bereits der erste Status.',
    cannotRevertTerminal:
      'Projekt kann nicht zurückgestuft werden. Der aktuelle Status ist ein Endstatus.',
    invalidStatus: (s: string) => `status '${s}' ist kein gültiger Workflow-Status.`,
    invalidPlannedStart: 'plannedStart muss ein gültiges ISO-Datum sein.',
    invalidPlannedEnd: 'plannedEnd muss ein gültiges ISO-Datum sein.',
    endWithoutStart: 'Enddatum kann nicht ohne Startdatum gesetzt werden.',
    endBeforeStart: 'Das Enddatum darf nicht vor dem Startdatum liegen.',
    invalidEstimatedValue: 'estimatedValue muss ein gültiger numerischer Wert sein.',
    unknownImportError: 'Unbekannter Fehler beim Import.',
    // Import error translations — never leak pg constraint names, table
    // names, column names, SQLSTATE codes, or English text. See C-5.
    duplicateNumber: (n: string) => `Projektnummer "${n}" ist bereits vergeben.`,
    foreignKeyViolation: 'Verknüpfter Datensatz existiert nicht (z. B. zugeordnete Mitarbeiter).',
    dateConstraintViolation: 'Datumsangaben verletzen eine Integritätsregel.',
    concurrentModification:
      'Der Projektstatus wurde zwischenzeitlich geändert. Bitte Seite neu laden.',
  },

  validation: {
    requiredString: (field: string) =>
      `${field} ist erforderlich und muss ein nicht-leerer String sein.`,
    requiredObject: (field: string) => `${field} ist erforderlich und muss ein Objekt sein.`,
    mustBeString: (field: string) => `${field} muss ein String sein.`,
    mustBeObject: (field: string) => `${field} muss ein Objekt sein.`,
    mustBeUuidArray: (field: string) => `${field} muss ein Array von UUIDs sein.`,
    mustBeNumeric: (field: string) => `${field} muss eine Zahl oder ein numerischer String sein.`,
    mustBeUuid: (field: string) => `${field} muss eine gültige UUID sein.`,
    maxLength: (field: string, max: number) => `${field} darf maximal ${max} Zeichen lang sein.`,
  },

  customers: {
    duplicateName: 'Ein Kunde mit diesem Namen existiert bereits.',
    duplicateNameConfirm: (name: string) =>
      `Ein Kunde mit dem Namen "${name}" existiert bereits. Trotzdem erstellen?`,
    nameRequired: 'Kundenname ist erforderlich.',
    hasProjects: 'Kunde kann nicht gelöscht werden, da noch aktive Projekte zugeordnet sind.',
    deleteWithArchived: (n: number) =>
      `Achtung: ${n} archivierte Projekt${n === 1 ? '' : 'e'} werden dabei endgültig gelöscht. Fortfahren?`,
    ambiguousName: 'Mehrere Kunden mit diesem Namen gefunden. Import-Zuordnung nicht eindeutig.',
  },

  extraction: {
    notConfigured: 'E-Mail-Extraktion ist nicht konfiguriert (OPENROUTER_API_KEY fehlt).',
    emptyInput: 'E-Mail-Text darf nicht leer sein.',
  },

  users: {
    duplicateUsername: 'Benutzername ist bereits vergeben.',
    cannotDeactivateSelf: 'Sie können sich nicht selbst deaktivieren.',
    cannotDeleteSelf: 'Sie können sich nicht selbst löschen.',
    alreadyActive: 'Benutzer ist bereits aktiv.',
    alreadyInactive: 'Benutzer ist bereits deaktiviert.',
  },

  roles: {
    owner: 'Inhaber',
    office: 'Büro',
    worker: 'Mitarbeiter',
    bookkeeper: 'Buchhalter',
  } as Record<string, string>,

  password: {
    tooShort: 'Neues Passwort ist zu kurz (mindestens 8 Zeichen).',
    tooLong: 'Neues Passwort ist zu lang.',
    tooCommon: 'Dieses Passwort ist zu häufig. Bitte ein sichereres Passwort wählen.',
    confirm: 'Passwort bestätigen',
    mismatch: 'Passwörter stimmen nicht überein.',
    change: 'Passwort ändern',
    currentPassword: 'Aktuelles Passwort',
    newPassword: 'Neues Passwort',
    changeSuccess: 'Passwort wurde geändert.',
    resetPassword: 'Passwort zurücksetzen',
    resetSuccess: 'Passwort wurde zurückgesetzt.',
  },

  // Theme selector in the user menu — labels pinned by spec §8.7.2 and by
  // the e2e contract in e2e/theme-preference.spec.ts.
  theme: {
    section: 'Darstellung',
    light: 'Hell',
    dark: 'Dunkel',
    system: 'Systemstandard',
  },

  ui: {
    confirm: 'Bestätigen',
    ok: 'OK',
    cancel: 'Abbrechen',
    clearFilter: 'Filter aufheben',
    close: 'Schließen',
    closeError: 'Fehlermeldung schließen',
    loading: 'Laden...',
    nextStep: 'Nächster Schritt',
    prevStep: 'Vorheriger Schritt',
    statusForward: (label: string) => `Status weiter: ${label}`,
    projectsNoDates: (n: number) => `${n} Projekte ohne Termin`,
    customer: 'Kunde',
    address: 'Adresse',
    dates: 'Termine',
    dateStart: 'Beginn',
    dateEnd: 'Ende',
    workers: 'Mitarbeiter',
    estimatedValue: 'Geschätzter Wert',
    notes: 'Notizen',
    created: 'Erstellt:',
    updated: 'Aktualisiert:',
    statusSince: 'Status seit:',
    openMaps: 'In Google Maps öffnen',
    viewKanban: 'Kanban',
    viewCalendar: 'Kalender',
    viewCustomers: 'Kunden',
    viewProjects: 'Projekte',
    viewUsers: 'Benutzer',
    viewData: 'Daten',
    viewMonth: 'Monat',
    viewWeek: 'Woche',

    // Management actions
    create: 'Erstellen',
    createAnyway: 'Trotzdem erstellen',
    save: 'Speichern',
    edit: 'Bearbeiten',
    viewDetails: 'Details',
    delete: 'Löschen',
    search: 'Suchen...',
    noResults: 'Keine Ergebnisse.',
    name: 'Name',
    phone: 'Telefon',
    email: 'E-Mail',
    street: 'Straße',
    zip: 'PLZ',
    city: 'Ort',
    status: 'Status',
    number: 'Nummer',
    title: 'Titel',
    active: 'Aktiv',
    inactive: 'Deaktiviert',
    username: 'Benutzername',
    displayName: 'Anzeigename',
    roles: 'Rollen',
    actions: 'Aktionen',
    projectCount: 'Projekte',
    value: 'Wert',
    deactivate: 'Deaktivieren',
    reactivate: 'Reaktivieren',
    deactivateConfirm: (name: string) => `${name} wirklich deaktivieren?`,
    reactivateConfirm: (name: string) => `${name} wirklich reaktivieren?`,
    deleteConfirm: (item: string) => `${item} wirklich löschen?`,

    // Extraction
    extractEmail: 'E-Mail Import',
    extractButton: 'Daten extrahieren',
    extractPlaceholder: 'E-Mail-Text hier einfügen...',
    extracting: 'Extrahiere Daten...',
    customerData: 'Kundendaten',
    projectData: 'Projektdaten',
    existingCustomer: 'Vorhandener Kunde',
    newCustomer: 'Neuer Kunde',
    description: 'Beschreibung',

    // Data exchange (Daten view) — kept here for shared labels.
    entityType: 'Datentyp',
    customers: 'Kunden',
    projects: 'Projekte',
    all: 'Alle',
    uploadFile: 'JSON-Datei auswählen',
    fileTooLarge: (maxMb: number) => `Datei zu groß. Maximal ${maxMb} MB erlaubt.`,
    noPermission: 'Keine Berechtigung.',

    // Not-permitted route surface (AC-149). Rendered when an
    // authenticated user opens a URL their role cannot access. Stays
    // on the forbidden path — the client does not redirect, only
    // displays this message.
    notPermittedHeading: 'Kein Zugriff',
    notPermittedBody:
      'Sie sind für diesen Bereich nicht berechtigt. Bitte wählen Sie eine verfügbare Ansicht.',
    notPermittedHome: 'Zur Startansicht',
  },

  /**
   * Unified data-exchange surface (ADR-0018, ui.md §8.11). Strings pinned
   * here so the Daten view and any future CLI-parity message share one
   * source. German copy reflects the spec: a single "Herunterladen" action
   * for export, a two-step upload→commit flow for import.
   */
  dataExchange: {
    exportHeading: 'Export',
    exportDescription: 'Lädt alle Kunden, Projekte und Zuordnungen als eine JSON-Datei herunter.',
    exportAction: 'Herunterladen',

    importHeading: 'Import',
    importDescription:
      'Stellt den Datenbestand aus einer zuvor exportierten JSON-Datei wieder her.',
    importAction: 'Importieren',
    projectWorkers: 'Zuordnungen',
    wouldWriteHeader: 'Anzahl',
    validationErrorsHeading: 'Validierungsfehler',
    overrideWarning:
      'Die bestehenden Daten werden ersetzt. Hiermit bestätige ich, dass ich dies möchte.',
    importSuccessHeading: 'Wiederherstellung erfolgreich.',
  },

  aging: {
    sinceNDays: (n: number) => `seit ${n} Tagen`,
    agedBuffer: (count: number, label: string, days: number) =>
      `${count} ${label} seit >${days} Tagen`,
  },
} as const;

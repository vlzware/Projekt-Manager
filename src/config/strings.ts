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
  },

  entities: {
    project: 'Projekt',
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
  },

  validation: {
    requiredString: (field: string) =>
      `${field} ist erforderlich und muss ein nicht-leerer String sein.`,
    requiredObject: (field: string) => `${field} ist erforderlich und muss ein Objekt sein.`,
    mustBeString: (field: string) => `${field} muss ein String sein.`,
    mustBeObject: (field: string) => `${field} muss ein Objekt sein.`,
    mustBeUuidArray: (field: string) => `${field} muss ein Array von UUIDs sein.`,
    mustBeNumeric: (field: string) => `${field} muss eine Zahl oder ein numerischer String sein.`,
  },

  password: {
    tooShort: 'Neues Passwort ist zu kurz (mindestens 8 Zeichen).',
    tooLong: 'Neues Passwort ist zu lang.',
    tooCommon: 'Dieses Passwort ist zu häufig. Bitte ein sichereres Passwort wählen.',
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
    viewMonth: 'Monat',
    viewWeek: 'Woche',
  },

  aging: {
    sinceNDays: (n: number) => `seit ${n} Tagen`,
    agedBuffer: (count: number, label: string, days: number) =>
      `${count} ${label} seit >${days} Tagen`,
  },
} as const;

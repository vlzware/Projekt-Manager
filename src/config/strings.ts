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
    restoreConfirmationMismatch:
      'Bestätigung fehlt oder stimmt nicht. Bitte den angezeigten Text exakt eingeben.',
    missingUserRefs:
      'Die Datei verweist auf Benutzer, die in der Zieldatenbank nicht vorhanden sind.',
  },

  entities: {
    project: 'Projekt',
    customer: 'Kunde',
    user: 'Benutzer',
    audit: 'Audit-Eintrag',
    notificationRule: 'Benachrichtigungsregel',
    pushSubscription: 'Push-Abonnement',
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
    archive: 'Archivieren',
    archiveConfirm: (identifier: string) => `Projekt ${identifier} wirklich archivieren?`,
    showArchived: 'Archivierte einblenden',
    archivedBadge: 'Archiviert',
    purge: 'Endgültig löschen',
    purgeConfirm: (identifier: string) =>
      `Projekt ${identifier} wird endgültig gelöscht. Alle zugeordneten Daten gehen dabei verloren. Fortfahren?`,
    purgeRequiresArchive:
      'Das Projekt muss zunächst archiviert werden, bevor es endgültig gelöscht werden kann.',
    restore: 'Wiederherstellen',
    restoreConfirm: (identifier: string) =>
      `Projekt ${identifier} aus dem Archiv wiederherstellen?`,
    restoreRequiresArchive:
      'Das Projekt ist nicht archiviert und kann daher nicht wiederhergestellt werden.',
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
    minLength: (field: string, min: number) => `${field} muss mindestens ${min} Zeichen lang sein.`,
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

  /**
   * Push-notifications group in the user menu (spec ui/index.md §8.7.2,
   * ui/behavior.md §9.8). Labels pinned by the spec and the e2e contract
   * in e2e/push-permission.spec.ts.
   *
   * The permission-denied copy intentionally does NOT offer an in-app
   * remediation — a denied browser permission is near-irreversible and
   * the user must clear it via browser settings.
   */
  push: {
    section: 'Push-Benachrichtigungen',
    enable: 'Push-Benachrichtigungen aktivieren',
    mute: 'Stummschalten',
    unsubscribe: 'Gerät abmelden',
    subscribed: 'Dieses Gerät ist angemeldet.',
    denied:
      'Push-Benachrichtigungen wurden für diese Webseite blockiert. Bitte in den Browser-Einstellungen freigeben.',
    unsupported: 'Dieser Browser unterstützt keine Push-Benachrichtigungen.',
    notConfigured: 'Push-Benachrichtigungen sind auf diesem Server nicht konfiguriert.',
    subscribeFailed: 'Anmeldung für Push-Benachrichtigungen fehlgeschlagen.',
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
    viewMyProjects: 'Meine Projekte',
    viewKanban: 'Kanban',
    viewCalendar: 'Kalender',
    viewCustomers: 'Kunden',
    viewProjects: 'Projekte',
    viewUsers: 'Benutzer',
    viewData: 'Daten',
    viewAudit: 'Aktivität',
    viewNotifications: 'Benachrichtigungen',
    myProjectsToday: 'Heute',
    myProjectsUpcoming: 'Demnächst',
    myProjectsOther: 'Weitere',
    myProjectsEmpty: 'Keine zugewiesenen Projekte.',
    viewMonth: 'Monat',
    viewWeek: 'Woche',
    navAdminMenu: 'Verwaltung',
    navHome: 'Zur Startseite',

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
   * Unified data-exchange surface (ADR-0018, ui/daten.md §8.11). Strings pinned
   * here so the Daten view and any future CLI-parity message share one
   * source. German copy reflects the spec: a single "Herunterladen" action
   * for export, a two-step upload→commit flow for import.
   */
  dataExchange: {
    exportHeading: 'Export',
    exportDescription: 'Lädt alle Kunden, Projekte und Zuordnungen als eine JSON-Datei herunter.',
    exportAction: 'Herunterladen',

    importHeading: 'Wiederherstellen',
    importDescription:
      'Stellt den Datenbestand aus einer zuvor exportierten JSON-Datei wieder her.',
    importAction: 'Wiederherstellen',
    projectWorkers: 'Zuordnungen',
    wouldWriteHeader: 'Anzahl',
    validationErrorsHeading: 'Validierungsfehler',
    restoreDestructiveNotice: 'Die bestehenden Daten werden unwiderruflich gelöscht.',
    restorePhrasePrompt: (phrase: string) => `Zur Bestätigung bitte „${phrase}" eingeben:`,
    importSuccessHeading: 'Wiederherstellung erfolgreich.',
  },

  aging: {
    sinceNDays: (n: number) => `seit ${n} Tagen`,
    agedBuffer: (count: number, label: string, days: number) =>
      `${count} ${label} seit >${days} Tagen`,
    /** Short form for use inside a column header where the state label is redundant. */
    agedBufferShort: (count: number, days: number) => `${count}× seit >${days} Tagen`,
  },

  /**
   * Audit / Aktivität surface (spec ui/workflow-views.md §8.4.1,
   * ui/management.md §8.13). The action-to-label map lives in a
   * dedicated config (auditActionLabels.ts) — this section carries the
   * labels that are shared between the activity feed and the global
   * Aktivität view.
   */
  audit: {
    emptyState: 'Keine Aktivität',
    /**
     * Recipient-scoped empty-state copy on the global Aktivität view
     * (AC-200). Rendered when the default (recipient-scoped) mode is
     * active and the filtered set is empty because rules exist but
     * none admit the caller as recipient. The plain "Keine Aktivität"
     * fallback applies only under "Alles anzeigen".
     */
    emptyStateRecipient:
      'Keine Benachrichtigungen für Sie. Alles anzeigen für den vollständigen Aktivitätsverlauf.',
    /** Label on the "Alles anzeigen" toggle (AC-200, §8.13.1). */
    toggleShowAll: 'Alles anzeigen',
    detailsShow: 'Details anzeigen',
    detailsHide: 'Details ausblenden',
    loadOlder: 'Ältere anzeigen',
    system: 'System',
    /** Fallback label when a user-actor row's actorId is null — the
     *  authoring user has been hard-deleted and AC-98's ON DELETE SET
     *  NULL nullified the FK (data-model.md §5.10 "Referential
     *  integrity"). Rendered in place of a resolved displayName. */
    userNeutral: 'Benutzer',
    /** Column / filter labels on the global Aktivität view. */
    colTimestamp: 'Zeitpunkt',
    colActor: 'Akteur',
    colEntity: 'Objekt',
    colAction: 'Aktion',
    colPayload: 'Details',
    filterEntityType: 'Objekttyp',
    filterEntityLabel: 'Objektname',
    filterEntityLabelPlaceholder: 'Name suchen…',
    filterActor: 'Akteur',
    filterAction: 'Aktion',
    filterFrom: 'Von',
    filterTo: 'Bis',
    filterDateInverted: 'Das "Bis"-Datum darf nicht vor dem "Von"-Datum liegen.',
    entityProject: 'Projekt',
    entityCustomer: 'Kunde',
    entityUser: 'Benutzer',
    entityProjectWorker: 'Zuweisung',
    entityAttachment: 'Anhang',
    /** Before/after panel labels in the payload drawer. */
    drawerBefore: 'Vorher',
    drawerAfter: 'Nachher',
    drawerField: 'Feld',
    heading: 'Aktivität',
    allActors: 'Alle Akteure',
    allActions: 'Alle Aktionen',
    allEntityTypes: 'Alle Objekttypen',
  },

  /**
   * Notification rule editor + validation messages (api.md §14.2.9,
   * data-model.md §5.11). Each message maps to one AC-190 rejection
   * branch so a regression surfaces the specific validator that broke.
   */
  notifications: {
    invalidEventClass: 'Unbekannte Ereignisklasse.',
    stateFilterNotAllowed: 'Ziel-Status ist nur für Statuswechsel-Ereignisse zulässig.',
    invalidStateFilter: 'Ziel-Status ist kein gültiger Workflow-Status.',
    includeAssignedWorkersNotAllowed:
      'Zugewiesene Mitarbeiter können nur für projektbezogene Ereignisse benachrichtigt werden.',
    invalidRole: (role: string) => `Unbekannte Rolle: "${role}".`,
    invalidUserId: 'Mindestens eine angegebene Benutzer-ID ist nicht gültig oder inaktiv.',
    invalidRecipientSpec: 'Empfänger-Spezifikation ist ungültig.',
    emptyRecipientSpec: 'Empfänger-Spezifikation darf nicht leer sein.',
    invalidEnabled: '"enabled" muss ein Boolean sein.',
    invalidPushSubscription: 'Push-Abonnement ist ungültig.',

    /**
     * Rule-editor surface (ui/management.md §8.14). Kept under the
     * existing `notifications` key so the admin-surface copy lives next
     * to the validator messages it pairs with.
     */
    rules: {
      heading: 'Benachrichtigungsregeln',
      createButton: 'Regel erstellen',
      createTitle: 'Regel erstellen',
      editTitle: 'Regel bearbeiten',
      emptyList: 'Keine Regeln',
      colEvent: 'Ereignis',
      colFilter: 'Filter',
      colRecipients: 'Empfänger',
      colEnabled: 'Aktiv',
      colActions: 'Aktionen',
      event: 'Ereignis',
      stateFilter: 'Ziel-Status',
      stateFilterAny: 'Beliebig',
      recipients: 'Empfänger',
      recipientRoles: 'Rollen',
      recipientAssignedWorkers: 'Zugewiesene Mitarbeiter benachrichtigen',
      recipientUsers: 'Einzelne Benutzer',
      userPickerPlaceholder: 'Benutzer suchen…',
      userPickerEmpty: 'Keine Treffer.',
      addUser: 'Hinzufügen',
      removeUser: 'Entfernen',
      enabled: 'Aktiv',
      deleteConfirm: 'Regel wirklich löschen?',
      /** Compact recipientSpec summary for the list's Empfänger cell. */
      summaryRoles: (labels: string) => `Rollen: ${labels}`,
      summaryAssignedWorkers: 'Zugewiesene Mitarbeiter',
      summaryUsers: (count: number) => `${count} Benutzer`,
      summaryEmpty: '—',
    },
  },

  /**
   * Project-detail / attachment surface (ui/project-detail.md §8.15).
   * The dropdown labels for `AttachmentLabel` live in
   * `src/domain/attachments.ts`'s `ATTACHMENT_LABELS` catalog — this
   * block carries the page-chrome copy that isn't a closed-enum label.
   */
  attachments: {
    /** Öffnen affordance on the quick-glance panel (spec §8.4, AC-207). */
    openDetailPage: 'Öffnen',
    /** Not-found surface — 404 on `GET /projects/:id`. */
    notFoundHeading: 'Projekt nicht gefunden',
    notFoundBody: 'Das angeforderte Projekt existiert nicht.',
    /** Banner shown atop the read-only preview of an archived project. */
    archivedReadOnlyNotice: 'Dieses Projekt ist archiviert. Bearbeitung nicht möglich.',

    // Region headings
    coreFields: 'Kernfelder',
    assignedWorkers: 'Zugewiesene Mitarbeiter',
    photoGallery: 'Fotogalerie',
    binaryList: 'Dateien',
    upload: 'Hochladen',
    activity: 'Aktivität',

    // Worker editor
    addWorker: 'Mitarbeiter hinzufügen',
    removeWorker: 'Entfernen',
    /**
     * Disambiguated aria-label for the per-chip remove button so
     * screen-reader users hear "Entfernen: Anna Arbeiter" instead of
     * every chip reading identically.
     */
    removeWorkerNamed: (name: string) => `Entfernen: ${name}`,
    noUnassignedWorkers: 'Keine weiteren Mitarbeiter verfügbar.',

    // Upload surface
    uploadDrop: 'Datei hier ablegen oder auswählen',
    uploadPickFile: 'Datei auswählen',
    uploadPickPhoto: 'Foto auswählen',
    uploadPickPhotos: 'Fotos auswählen',
    uploadPickBinary: 'Dokument auswählen',
    takePhoto: 'Foto aufnehmen',
    photoSectionTitle: 'Fotos',
    binarySectionTitle: 'Dokument',
    uploadLabel: 'Beschriftung',
    uploadRetry: 'Erneut versuchen',
    uploadDismiss: 'Verwerfen',
    uploadProgressInit: 'Vorbereiten…',
    uploadProgressUpload: 'Hochladen…',
    uploadProgressComplete: 'Fertigstellen…',
    uploadFileTooLarge: 'Datei zu groß.',
    uploadImageProcessingFailed: 'Bildbearbeitung fehlgeschlagen.',
    uploadSuccessToast: (fileName: string) => `Hochgeladen: ${fileName}`,
    uploadFailureToast: (fileName: string, reason: string) =>
      `Upload fehlgeschlagen: ${fileName} — ${reason}`,
    /**
     * MIME-rejection copy — names the supported formats explicitly so a
     * user picking a HEIC / GIF / etc. has a concrete answer on what to
     * do instead. HEIC is the canonical miss (Apple camera default); the
     * list-the-supported approach future-proofs the message against any
     * other format drift.
     */
    uploadMimeNotAllowed:
      'Dateityp nicht unterstützt. Bitte als JPEG, PNG oder WebP (Fotos) oder als PDF oder DOCX (Dokumente) hochladen.',

    // Missing-file placeholder (AC-224)
    fileMissing: 'Datei fehlt',

    // Deletion
    deleteConfirmTitle: 'Datei löschen?',
    deleteConfirmMessage: 'Diese Aktion kann nicht rückgängig gemacht werden.',

    // Download actions
    download: 'Herunterladen',
    view: 'Ansehen',
    bulkDownload: 'Auswahl als ZIP',
    downloadAll: 'Alle herunterladen',
    noAttachments: 'Keine Dateien zum Herunterladen.',
    /**
     * Fallback filename hinted to the browser when the bulk-download
     * anchor is created. The server's Content-Disposition is still
     * authoritative; this is the "filename the user sees if the
     * browser honours the hint."
     */
    bulkZipFileName: 'Dateien.zip',
    selectAll: 'Alle auswählen',
    /**
     * Bulk-download cap violation message (AC-223) — MUST name both caps
     * (file count AND summed bytes) per ui/project-detail.md §8.15.5.
     */
    bulkLimitExceeded: (maxFiles: number, maxMb: number) =>
      `Auswahl überschreitet das Limit: maximal ${maxFiles} Dateien und maximal ${maxMb} MB Gesamtgröße.`,

    // Table headers for the binary list
    colFileName: 'Dateiname',
    colLabel: 'Beschriftung',
    colUploader: 'Hochgeladen von',
    colUploaded: 'Hochgeladen am',
  },

  backup: {
    green: 'Backup: aktuell',
    drillStale: 'Backup: aktuell, Drill-Schlüssel neu laden',
    backupStale: 'Backup: veraltet',
    lastRunFailed: 'Backup: fehlgeschlagen',
    backupNeverRun: 'Backup: noch nie ausgeführt',
    drillNeverRun: 'Drill: noch nie ausgeführt',
    unknown: 'Status unbekannt',
    /**
     * Augments any badge label with the timestamp of the last backup
     * run so the tooltip / toast carries actionable detail rather than
     * a bare status word. The timestamp comes pre-formatted by
     * `formatBackupTimestampDE`.
     */
    withTimestamp: (label: string, timestamp: string) => `${label} (${timestamp})`,
  },
} as const;

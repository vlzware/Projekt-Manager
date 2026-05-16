/**
 * Company-profile section on the Daten view (ui/daten.md §8.11.4,
 * ADR-0026).
 *
 * Argumented C-SIZE exception (review/conventions-code.md §C-SIZE,
 * 200 LOC guideline): this file is ~340 LOC. It hosts one cohesive
 * mutation surface — the section's permission gate + fetch-error
 * fallback, the form's owner-vs-read-only field rendering with
 * client-side validation, and the `LabeledInput` atom the form
 * repeats per field. The atom could extract to a sibling file; the
 * section + form are one round-trip and one state owner, so further
 * splitting would scatter responsibility.
 *
 * Owner-only mutation surface — every authenticated role sees the
 * section as a read-only summary so the values invoices will snapshot
 * are visible. The owner-vs-read-only gate is by ROLE (the server
 * folds the invariant into a role check, not a permission key —
 * api.md §14.2.15 design note).
 *
 * Client-side required-field validation is a UX affordance only; the
 * server re-validates and remains authoritative (AC-303). The
 * USt-IdNr. requiredness re-renders when `defaultTaxMode` changes
 * (`standard` / `reverse_charge` require it; `kleinunternehmer` does
 * not).
 *
 * Logo upload is out of scope of this Chunk — see the inline finding
 * in the task scope. No logo affordance is rendered.
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { STRINGS } from '@/config/strings';
import { useAuthStore } from '@/state/authStore';
import {
  useCompanyProfileStore,
  type CompanyProfileSavePayload,
} from '@/state/companyProfileStore';
import { TAX_MODES, labelForTaxMode, type CompanyProfile, type TaxMode } from '@/domain/invoice';
import styles from './CompanyProfileSection.module.css';

interface FormValues {
  companyName: string;
  street: string;
  zip: string;
  city: string;
  taxId: string;
  ustId: string;
  iban: string;
  accentColor: string;
  footerText: string;
  defaultTaxMode: TaxMode;
}

/** USt-IdNr. is mandatory for two of the three tax modes (AC-303). */
function ustIdRequiredFor(mode: TaxMode): boolean {
  return mode === 'standard' || mode === 'reverse_charge';
}

function isFormValid(values: FormValues): boolean {
  if (!values.companyName.trim()) return false;
  if (!values.street.trim()) return false;
  if (!values.zip.trim()) return false;
  if (!values.city.trim()) return false;
  if (!values.taxId.trim()) return false;
  if (ustIdRequiredFor(values.defaultTaxMode) && !values.ustId.trim()) return false;
  return true;
}

function profileToFormValues(profile: CompanyProfile): FormValues {
  return {
    companyName: profile.companyName,
    street: profile.address.street,
    zip: profile.address.zip,
    city: profile.address.city,
    taxId: profile.taxId,
    ustId: profile.ustId ?? '',
    iban: profile.iban ?? '',
    accentColor: profile.accentColor ?? '',
    footerText: profile.footerText ?? '',
    defaultTaxMode: profile.defaultTaxMode,
  };
}

interface FieldSpec {
  key: keyof FormValues;
  label: string;
  required: boolean;
  full?: boolean;
}

export function CompanyProfileSection() {
  const data = useCompanyProfileStore((s) => s.data);
  const fetchError = useCompanyProfileStore((s) => s.fetchError);
  const fetchProfile = useCompanyProfileStore((s) => s.fetch);

  useEffect(() => {
    void fetchProfile();
  }, [fetchProfile]);

  // Mount the form only once the server snapshot has arrived. The
  // `key={profile.updatedAt}` re-mounts the form when the server
  // returns a refreshed snapshot after a successful save — `useState`
  // initializer re-runs against the new data without a setState-in-effect.
  //
  // Until then, surface the fetch error explicitly. The form is the only
  // place `saveError` is rendered, so a failed initial GET would
  // otherwise hide the diagnostic behind an empty section. The retry
  // button re-dispatches `fetch()` so the user can recover without a
  // full page reload.
  // The host (InvoiceListView's `<details>`) provides the heading via
  // its `<summary>`; the section renders only the description + form.
  if (!data) {
    return (
      <section className={styles.section}>
        <p className={styles.description}>{STRINGS.companyProfile.description}</p>
        {fetchError && (
          <div className={styles.fetchError} role="alert" data-testid="company-profile-fetch-error">
            <span className={styles.fetchErrorHeading}>
              {STRINGS.companyProfile.fetchErrorHeading}
            </span>
            <span>{fetchError}</span>
            <button
              type="button"
              className={styles.fetchErrorRetry}
              onClick={() => void fetchProfile()}
              data-testid="company-profile-fetch-retry"
            >
              {STRINGS.companyProfile.fetchRetry}
            </button>
          </div>
        )}
      </section>
    );
  }

  return <CompanyProfileForm key={data.updatedAt} profile={data} />;
}

function CompanyProfileForm({ profile }: { profile: CompanyProfile }) {
  const authUser = useAuthStore((s) => s.authUser);
  const saveError = useCompanyProfileStore((s) => s.saveError);
  const saveProfile = useCompanyProfileStore((s) => s.save);
  const clearSaveError = useCompanyProfileStore((s) => s.clearSaveError);

  // Drop the stale save-error on unmount so navigating away and
  // returning to Firmendaten does not resurrect last attempt's red
  // banner. The error lives in the Zustand store (cross-mount) so the
  // form has to clear it explicitly.
  useEffect(() => () => clearSaveError(), [clearSaveError]);

  const isOwner = (authUser?.roles ?? []).includes('owner');

  const [values, setValues] = useState<FormValues>(() => profileToFormValues(profile));
  const [submitting, setSubmitting] = useState(false);
  // Show validation errors after a submit attempt — keeps the form
  // quiet on first paint while still surfacing field-level guidance
  // the moment the owner tries to save with an incomplete row. AC-303
  // says client-side validation is a UX affordance; the server is
  // authoritative regardless.
  const [showErrors, setShowErrors] = useState(false);

  const setField = (key: keyof FormValues) => {
    return (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      const value = e.target.value;
      setValues((prev) => ({ ...prev, [key]: value }));
    };
  };

  const valid = isFormValid(values);
  const ustIdMissing = ustIdRequiredFor(values.defaultTaxMode) && !values.ustId.trim();

  const handleSubmit = async () => {
    if (!isOwner || submitting) return;
    if (!valid) {
      setShowErrors(true);
      return;
    }

    setSubmitting(true);
    // Logo upload is out of scope of this Chunk (#189) — there is no
    // orphan (non-project) binary descriptor pipeline yet, and the form
    // exposes no logo affordance. PUT semantics require every writable
    // field (api.md §14.2.15), so the save round-trips the descriptor
    // from the loaded profile back to the server unchanged; any value
    // set by a future flow (or out-of-band write) survives the save.
    const payload: CompanyProfileSavePayload = {
      companyName: values.companyName.trim(),
      address: {
        street: values.street.trim(),
        zip: values.zip.trim(),
        city: values.city.trim(),
      },
      taxId: values.taxId.trim(),
      ustId: values.ustId.trim() || null,
      iban: values.iban.trim() || null,
      accentColor: values.accentColor.trim() || null,
      footerText: values.footerText.trim() || null,
      logoBinaryDescriptorId: profile.logoBinaryDescriptorId ?? null,
      defaultTaxMode: values.defaultTaxMode,
    };
    await saveProfile(payload);
    setSubmitting(false);
  };

  // For non-owner: inputs stay visible-but-frozen via `readOnly` so the
  // current values are legible (HTML `disabled` would gray them out and
  // the spec wants a "read-only summary"). The native <select> has no
  // readOnly attribute; use `disabled` there — values still render.
  const readOnly = !isOwner;

  const fields: FieldSpec[] = [
    { key: 'companyName', label: STRINGS.companyProfile.companyName, required: true, full: true },
    { key: 'street', label: STRINGS.companyProfile.street, required: true },
    { key: 'zip', label: STRINGS.companyProfile.zip, required: true },
    { key: 'city', label: STRINGS.companyProfile.city, required: true, full: true },
    { key: 'taxId', label: STRINGS.companyProfile.taxId, required: true },
    {
      key: 'ustId',
      label: STRINGS.companyProfile.ustId,
      required: ustIdRequiredFor(values.defaultTaxMode),
    },
    { key: 'iban', label: STRINGS.companyProfile.iban, required: false },
    { key: 'accentColor', label: STRINGS.companyProfile.accentColor, required: false },
  ];

  return (
    <section className={styles.section}>
      <p className={styles.description}>{STRINGS.companyProfile.description}</p>

      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSubmit();
        }}
        data-testid="company-profile-form"
      >
        {fields.map((f) => (
          <LabeledInput
            key={f.key}
            fieldKey={f.key}
            label={f.label}
            required={f.required}
            full={f.full}
            value={values[f.key]}
            onChange={setField(f.key)}
            readOnly={readOnly}
            inlineError={
              showErrors && f.key === 'ustId' && ustIdMissing
                ? STRINGS.companyProfile.ustIdRequiredForMode
                : null
            }
          />
        ))}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="company-profile-defaultTaxMode">
            {STRINGS.companyProfile.defaultTaxMode} *
          </label>
          <select
            id="company-profile-defaultTaxMode"
            className={styles.select}
            value={values.defaultTaxMode}
            onChange={setField('defaultTaxMode')}
            disabled={readOnly}
            data-testid="company-profile-defaultTaxMode-select"
          >
            {TAX_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {labelForTaxMode(mode, {
                  standard: STRINGS.companyProfile.taxModeStandard,
                  kleinunternehmer: STRINGS.companyProfile.taxModeKleinunternehmer,
                  reverseCharge: STRINGS.companyProfile.taxModeReverseCharge,
                })}
              </option>
            ))}
          </select>
        </div>

        <LabeledInput
          fieldKey="footerText"
          label={STRINGS.companyProfile.footerText}
          required={false}
          full
          value={values.footerText}
          onChange={setField('footerText')}
          readOnly={readOnly}
          inlineError={null}
        />

        {saveError && (
          <div className={styles.error} role="alert">
            {saveError}
          </div>
        )}

        {isOwner && (
          <div className={styles.actions}>
            <button
              type="submit"
              className={styles.saveButton}
              disabled={submitting}
              data-testid="company-profile-save"
            >
              {STRINGS.companyProfile.save}
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

interface LabeledInputProps {
  fieldKey: keyof FormValues;
  label: string;
  required: boolean;
  full?: boolean;
  value: string;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  readOnly: boolean;
  inlineError: string | null;
}

function LabeledInput(props: LabeledInputProps) {
  const id = `company-profile-${props.fieldKey}`;
  const testId = `company-profile-${props.fieldKey}-input`;
  const errorTestId = `company-profile-${props.fieldKey}-error`;
  return (
    <div className={`${styles.field} ${props.full ? styles.fieldFull : ''}`}>
      <label className={styles.label} htmlFor={id}>
        {props.label}
        {props.required ? ' *' : ''}
      </label>
      <input
        id={id}
        className={styles.input}
        type="text"
        value={props.value}
        onChange={props.onChange}
        readOnly={props.readOnly}
        data-testid={testId}
      />
      {props.inlineError && (
        <p className={styles.fieldError} data-testid={errorTestId}>
          {props.inlineError}
        </p>
      )}
    </div>
  );
}

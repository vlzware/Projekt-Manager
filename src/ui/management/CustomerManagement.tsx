/**
 * Customer management view — list, create, edit, delete customers.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 18.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCustomerStore } from '@/state/customerStore';
import { usePermission } from '@/hooks/usePermission';
import { useConfirmStore } from '@/state/confirmStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { Customer } from '@/domain/types';
import { normalizeName } from '@/domain/nameNormalize';
import styles from './Management.module.css';

const AUTOCOMPLETE_DEBOUNCE_MS = 300;

export function CustomerManagement() {
  const customers = useCustomerStore((s) => s.customers);
  const loading = useCustomerStore((s) => s.loading);
  const error = useCustomerStore((s) => s.error);
  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
  const searchCustomers = useCustomerStore((s) => s.searchCustomers);
  const createCustomer = useCustomerStore((s) => s.createCustomer);
  const updateCustomer = useCustomerStore((s) => s.updateCustomer);
  const deleteCustomer = useCustomerStore((s) => s.deleteCustomer);
  const clearError = useCustomerStore((s) => s.clearError);
  const requestConfirm = useConfirmStore((s) => s.request);

  const canWrite = usePermission('customer:write');
  const canDelete = usePermission('customer:delete');

  const [formOpen, setFormOpen] = useState(false);
  const [editCustomer, setEditCustomer] = useState<Customer | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [street, setStreet] = useState('');
  const [zip, setZip] = useState('');
  const [city, setCity] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Client-supplied UUID for idempotent create. Generated on form open,
  // stable across re-renders and retries within the same form instance.
  // Null when no create form is open.
  const [createId, setCreateId] = useState<string | null>(null);

  // Autocomplete state (create form only).
  const [matches, setMatches] = useState<Customer[]>([]);
  const [matchDropdownOpen, setMatchDropdownOpen] = useState(false);
  const matchRef = useRef<HTMLDivElement>(null);
  // Monotonic request id — a slow fetch must not commit its results if
  // the user has since typed and kicked off a newer fetch.
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    fetchCustomers();
  }, [fetchCustomers]);

  const resetForm = () => {
    setName('');
    setPhone('');
    setEmail('');
    setStreet('');
    setZip('');
    setCity('');
    setMatches([]);
    setMatchDropdownOpen(false);
  };

  const populateForm = (c: Customer) => {
    setName(c.name);
    setPhone(c.phone ?? '');
    setEmail(c.email ?? '');
    setStreet(c.address?.street ?? '');
    setZip(c.address?.zip ?? '');
    setCity(c.address?.city ?? '');
  };

  // Debounced duplicate-name search while the create form is open.
  useEffect(() => {
    if (!formOpen) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setMatches([]);
      setMatchDropdownOpen(false);
      return;
    }
    const timer = setTimeout(async () => {
      // Drop stale results from the previous query so the dropdown does
      // not flicker old rows while the new fetch is in flight.
      setMatches([]);
      const myReq = ++searchRequestIdRef.current;
      const results = await searchCustomers(trimmed);
      if (myReq !== searchRequestIdRef.current) return;
      setMatches(results);
      if (results.length > 0) setMatchDropdownOpen(true);
    }, AUTOCOMPLETE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [name, formOpen, searchCustomers]);

  // Close match dropdown on outside click.
  useEffect(() => {
    if (!matchDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (matchRef.current && !matchRef.current.contains(e.target as Node)) {
        setMatchDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [matchDropdownOpen]);

  const exactMatch = useMemo(() => {
    const key = normalizeName(name);
    if (!key) return null;
    return matches.find((c) => normalizeName(c.name) === key) ?? null;
  }, [matches, name]);

  const handleCreate = async () => {
    if (submitting || !name.trim() || !createId) return;

    // Set submitting BEFORE any await so a second click cannot slip past
    // the guard. `useConfirmStore.request` does not block pointer events
    // on the underlying form and its preemption semantic silently
    // cancels the first request if a second one opens — the combination
    // would discard the user's first submit with no feedback.
    setSubmitting(true);

    // Soft-confirm on an exact case-insensitive duplicate — legitimate
    // duplicates are allowed but the user must opt in.
    if (exactMatch) {
      const proceed = await requestConfirm(STRINGS.customers.duplicateNameConfirm(name.trim()), {
        confirmLabel: STRINGS.ui.createAnyway,
      });
      if (!proceed) {
        setSubmitting(false);
        return;
      }
    }

    const address =
      street.trim() || zip.trim() || city.trim()
        ? { street: street.trim(), zip: zip.trim(), city: city.trim() }
        : null;

    const outcome = await createCustomer({
      id: createId,
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address,
    });

    setSubmitting(false);

    if (outcome.status === 'ok' || outcome.status === 'conflict') {
      // Conflict path: the backing row already exists with different data.
      // The form instance is unrecoverable — close it. The store has
      // already refreshed the list and set its error message.
      setFormOpen(false);
      setCreateId(null);
      resetForm();
    }
  };

  const handleUpdate = async () => {
    if (submitting || !editCustomer || !name.trim()) return;
    setSubmitting(true);

    const address =
      street.trim() || zip.trim() || city.trim()
        ? { street: street.trim(), zip: zip.trim(), city: city.trim() }
        : null;

    const ok = await updateCustomer(editCustomer.id, {
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address,
    });

    setSubmitting(false);
    if (ok) {
      setEditCustomer(null);
      resetForm();
    }
  };

  const handleDelete = async (e: React.MouseEvent, customer: Customer) => {
    e.stopPropagation();
    const confirmed = await requestConfirm(STRINGS.ui.deleteConfirm(customer.name));
    if (!confirmed) return;
    await deleteCustomer(customer.id);
  };

  const handleRowClick = (customer: Customer) => {
    setEditCustomer(customer);
    populateForm(customer);
    clearError();
  };

  const openCreateForm = () => {
    clearError();
    resetForm();
    setEditCustomer(null);
    setCreateId(crypto.randomUUID());
    setFormOpen(true);
  };

  const openEditFromMatch = (customer: Customer) => {
    setFormOpen(false);
    setCreateId(null);
    handleRowClick(customer);
  };

  const closeCreateForm = useCallback(() => {
    if (submitting) return;
    setFormOpen(false);
    setCreateId(null);
    resetForm();
  }, [submitting]);

  const closeEditForm = useCallback(() => {
    if (submitting) return;
    setEditCustomer(null);
    resetForm();
  }, [submitting]);

  useEscapeKey(closeCreateForm, formOpen);
  useEscapeKey(closeEditForm, !!editCustomer && !formOpen);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canWrite && (
          <button
            className={styles.createButton}
            onClick={openCreateForm}
            data-testid="customer-create-button"
          >
            {STRINGS.ui.create}
          </button>
        )}
      </div>

      {error && !formOpen && !editCustomer && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="customer-table">
        <thead>
          <tr>
            <th>{STRINGS.ui.name}</th>
            <th>{STRINGS.ui.phone}</th>
            <th>{STRINGS.ui.email}</th>
            <th>{STRINGS.ui.city}</th>
            {canDelete && <th>{STRINGS.ui.actions}</th>}
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id} className={styles.clickableRow} onClick={() => handleRowClick(c)}>
              <td>{c.name}</td>
              <td>{c.phone ?? '—'}</td>
              <td>{c.email ?? '—'}</td>
              <td>{c.address?.city ?? '—'}</td>
              {canDelete && (
                <td>
                  <button className={styles.dangerButton} onClick={(e) => handleDelete(e, c)}>
                    {STRINGS.ui.delete}
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && customers.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {/* Create form */}
      {formOpen && (
        <div className={styles.formOverlay}>
          <form
            className={styles.formPanel}
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreate();
            }}
          >
            <h2 className={styles.formTitle}>
              {STRINGS.entities.customer} {STRINGS.ui.create}
            </h2>

            {renderCreateFormFields()}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={closeCreateForm}
                disabled={submitting}
              >
                {STRINGS.ui.cancel}
              </button>
              <button
                type="submit"
                className={styles.submitButton}
                disabled={submitting || !name.trim()}
                data-testid="customer-submit"
              >
                {STRINGS.ui.create}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Edit form (click row) */}
      {editCustomer && !formOpen && (
        <div className={styles.formOverlay}>
          <form
            className={styles.formPanel}
            onSubmit={(e) => {
              e.preventDefault();
              if (!canWrite) return;
              void handleUpdate();
            }}
          >
            <h2 className={styles.formTitle}>
              {STRINGS.entities.customer} {canWrite ? STRINGS.ui.edit : STRINGS.ui.viewDetails}
            </h2>

            {renderEditFormFields(!canWrite)}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button
                type="button"
                className={styles.cancelButton}
                onClick={closeEditForm}
                disabled={submitting}
              >
                {STRINGS.ui.cancel}
              </button>
              {canWrite && (
                <button
                  type="submit"
                  className={styles.submitButton}
                  disabled={submitting || !name.trim()}
                  data-testid="customer-save"
                >
                  {STRINGS.ui.save}
                </button>
              )}
            </div>
          </form>
        </div>
      )}
    </div>
  );

  function renderCreateFormFields() {
    return (
      <>
        <div className={styles.formGroup} ref={matchRef}>
          <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
          <div className={styles.selectWrapper}>
            <input
              className={styles.formInput}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setMatchDropdownOpen(true);
              }}
              onFocus={() => {
                if (matches.length > 0) setMatchDropdownOpen(true);
              }}
              onBlur={() => {
                // Delay so an onClick on a dropdown row fires before the
                // blur handler closes the dropdown.
                window.setTimeout(() => setMatchDropdownOpen(false), 150);
              }}
              disabled={submitting}
              data-testid="customer-name-input"
              autoFocus
              autoComplete="off"
            />
            {matchDropdownOpen && matches.length > 0 && (
              <div className={styles.selectDropdown} data-testid="customer-match-dropdown">
                {matches.map((c) => (
                  <div
                    key={c.id}
                    className={styles.selectOption}
                    onMouseDown={(e) => {
                      // Prevent the input's blur from firing before click.
                      e.preventDefault();
                    }}
                    onClick={() => openEditFromMatch(c)}
                    data-testid={`customer-match-${c.id}`}
                  >
                    {c.name}
                    {c.phone ? (
                      <span className={styles.selectOptionSecondary}> — {c.phone}</span>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {renderRestOfFields(false)}
      </>
    );
  }

  function renderEditFormFields(readOnly: boolean) {
    return (
      <>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
          <input
            className={styles.formInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly || submitting}
            data-testid="customer-name-input"
            autoFocus
          />
        </div>

        {renderRestOfFields(readOnly)}
      </>
    );
  }

  function renderRestOfFields(readOnly: boolean) {
    const disabled = readOnly || submitting;
    return (
      <>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.street}</label>
          <input
            className={styles.formInput}
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            disabled={disabled}
            data-testid="customer-street-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
          <input
            className={styles.formInput}
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            disabled={disabled}
            data-testid="customer-zip-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.city}</label>
          <input
            className={styles.formInput}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            disabled={disabled}
            data-testid="customer-city-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.phone}</label>
          <input
            className={styles.formInput}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={disabled}
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.email}</label>
          <input
            className={styles.formInput}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={disabled}
          />
        </div>
      </>
    );
  }
}

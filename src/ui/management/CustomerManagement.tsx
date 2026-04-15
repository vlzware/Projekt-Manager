/**
 * Customer management view — list, create, edit, delete customers.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 18.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCustomerStore } from '@/state/customerStore';
import { usePermission } from '@/hooks/usePermission';
import { useConfirmStore } from '@/state/confirmStore';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import { STRINGS } from '@/config/strings';
import type { Customer } from '@/domain/types';
import styles from './Management.module.css';

export function CustomerManagement() {
  const customers = useCustomerStore((s) => s.customers);
  const loading = useCustomerStore((s) => s.loading);
  const error = useCustomerStore((s) => s.error);
  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
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
  };

  const populateForm = (c: Customer) => {
    setName(c.name);
    setPhone(c.phone ?? '');
    setEmail(c.email ?? '');
    setStreet(c.address?.street ?? '');
    setZip(c.address?.zip ?? '');
    setCity(c.address?.city ?? '');
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSubmitting(true);

    const address =
      street.trim() || zip.trim() || city.trim()
        ? { street: street.trim(), zip: zip.trim(), city: city.trim() }
        : null;

    const ok = await createCustomer({
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address,
    });

    setSubmitting(false);
    if (ok) {
      setFormOpen(false);
      resetForm();
    }
  };

  const handleUpdate = async () => {
    if (!editCustomer || !name.trim()) return;
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

  const closeCreateForm = useCallback(() => {
    setFormOpen(false);
  }, []);
  const closeEditForm = useCallback(() => {
    setEditCustomer(null);
  }, []);

  useEscapeKey(closeCreateForm, formOpen);
  useEscapeKey(closeEditForm, !!editCustomer && !formOpen);

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        {canWrite && (
          <button
            className={styles.createButton}
            onClick={() => {
              clearError();
              resetForm();
              setEditCustomer(null);
              setFormOpen(true);
            }}
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

            {renderFormFields(false)}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button type="button" className={styles.cancelButton} onClick={closeCreateForm}>
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

            {renderFormFields(!canWrite)}

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button type="button" className={styles.cancelButton} onClick={closeEditForm}>
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

  function renderFormFields(readOnly: boolean) {
    return (
      <>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
          <input
            className={styles.formInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={readOnly}
            data-testid="customer-name-input"
            autoFocus
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.street}</label>
          <input
            className={styles.formInput}
            value={street}
            onChange={(e) => setStreet(e.target.value)}
            disabled={readOnly}
            data-testid="customer-street-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
          <input
            className={styles.formInput}
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            disabled={readOnly}
            data-testid="customer-zip-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.city}</label>
          <input
            className={styles.formInput}
            value={city}
            onChange={(e) => setCity(e.target.value)}
            disabled={readOnly}
            data-testid="customer-city-input"
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.phone}</label>
          <input
            className={styles.formInput}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            disabled={readOnly}
          />
        </div>

        <div className={styles.formGroup}>
          <label className={styles.formLabel}>{STRINGS.ui.email}</label>
          <input
            className={styles.formInput}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={readOnly}
          />
        </div>
      </>
    );
  }
}

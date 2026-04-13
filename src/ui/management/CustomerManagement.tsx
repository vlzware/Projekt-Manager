/**
 * Customer management view — list, create, update customers.
 *
 * Test IDs follow the established naming convention (kebab-case).
 * See e2e/management-flows.spec.ts steps 18.
 */

import { useEffect, useState } from 'react';
import { useCustomerStore } from '@/state/customerStore';
import { STRINGS } from '@/config/strings';
import styles from './Management.module.css';

export function CustomerManagement() {
  const customers = useCustomerStore((s) => s.customers);
  const loading = useCustomerStore((s) => s.loading);
  const error = useCustomerStore((s) => s.error);
  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
  const createCustomer = useCustomerStore((s) => s.createCustomer);
  const clearError = useCustomerStore((s) => s.clearError);

  const [formOpen, setFormOpen] = useState(false);
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

  return (
    <div className={styles.container}>
      <div className={styles.toolbar}>
        <button
          className={styles.createButton}
          onClick={() => {
            clearError();
            resetForm();
            setFormOpen(true);
          }}
          data-testid="customer-create-button"
        >
          {STRINGS.ui.create}
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <table className={styles.table} data-testid="customer-table">
        <thead>
          <tr>
            <th>{STRINGS.ui.name}</th>
            <th>{STRINGS.ui.phone}</th>
            <th>{STRINGS.ui.email}</th>
            <th>{STRINGS.ui.city}</th>
          </tr>
        </thead>
        <tbody>
          {customers.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.phone ?? '—'}</td>
              <td>{c.email ?? '—'}</td>
              <td>{c.address?.city ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {!loading && customers.length === 0 && (
        <div className={styles.noResults}>{STRINGS.ui.noResults}</div>
      )}

      {formOpen && (
        <div className={styles.formOverlay} onClick={() => setFormOpen(false)}>
          <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
            <h2 className={styles.formTitle}>
              {STRINGS.entities.customer} {STRINGS.ui.create}
            </h2>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
              <input
                className={styles.formInput}
                value={name}
                onChange={(e) => setName(e.target.value)}
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
                data-testid="customer-street-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
              <input
                className={styles.formInput}
                value={zip}
                onChange={(e) => setZip(e.target.value)}
                data-testid="customer-zip-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.city}</label>
              <input
                className={styles.formInput}
                value={city}
                onChange={(e) => setCity(e.target.value)}
                data-testid="customer-city-input"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.phone}</label>
              <input
                className={styles.formInput}
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.email}</label>
              <input
                className={styles.formInput}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={() => setFormOpen(false)}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleCreate}
                disabled={submitting || !name.trim()}
                data-testid="customer-submit"
              >
                {STRINGS.ui.create}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

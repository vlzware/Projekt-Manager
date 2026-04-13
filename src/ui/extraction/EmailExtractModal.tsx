/**
 * Email extraction modal — paste email text, extract customer + project data.
 *
 * Opened from a button in the Header. Contains a textarea for the email,
 * extracted customer/project fields for review, and a sequential save
 * (customer first, then project with returned customerId). See ADR-0015/0016.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { extractApi, customerApi, projectApi } from '@/api/client';
import { useCustomerStore } from '@/state/customerStore';
import { useProjectManagementStore } from '@/state/projectManagementStore';
import { useProjectStore } from '@/state/projectStore';
import { STRINGS } from '@/config/strings';
import type { Customer } from '@/domain/types';
import styles from '../management/Management.module.css';

interface Props {
  onClose: () => void;
}

export function EmailExtractModal({ onClose }: Props) {
  // Extraction state
  const [emailText, setEmailText] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extracted, setExtracted] = useState(false);

  // Customer fields
  const [customerName, setCustomerName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [street, setStreet] = useState('');
  const [zip, setZip] = useState('');
  const [city, setCity] = useState('');

  // Existing customer match
  const [matchSearch, setMatchSearch] = useState('');
  const [matchResults, setMatchResults] = useState<Customer[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);
  const [matchDropdownOpen, setMatchDropdownOpen] = useState(false);
  const matchRef = useRef<HTMLDivElement>(null);

  // Project fields
  const [projectTitle, setProjectTitle] = useState('');
  const [projectNumber, setProjectNumber] = useState('');

  // Save state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchCustomers = useCustomerStore((s) => s.fetchCustomers);
  const fetchMgmtProjects = useProjectManagementStore((s) => s.fetchProjects);

  // Search for existing customers when match search changes
  useEffect(() => {
    if (!matchSearch.trim()) {
      setMatchResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      const result = await customerApi.list({ search: matchSearch });
      if (result.ok) {
        setMatchResults(result.data.customers);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [matchSearch]);

  // Close match dropdown on outside click
  const closeDropdown = useCallback((e: MouseEvent) => {
    if (matchRef.current && !matchRef.current.contains(e.target as Node)) {
      setMatchDropdownOpen(false);
    }
  }, []);

  useEffect(() => {
    if (!matchDropdownOpen) return;
    document.addEventListener('mousedown', closeDropdown);
    return () => document.removeEventListener('mousedown', closeDropdown);
  }, [matchDropdownOpen, closeDropdown]);

  const handleExtract = async () => {
    setError(null);
    setExtracting(true);

    const result = await extractApi.extract(emailText);

    setExtracting(false);

    if (!result.ok) {
      setError(result.error.message);
      return;
    }

    const { customer, project } = result.data;
    setCustomerName(customer.name ?? '');
    setPhone(customer.phone ?? '');
    setEmail(customer.email ?? '');
    setStreet(customer.street ?? '');
    setZip(customer.zip ?? '');
    setCity(customer.city ?? '');
    setMatchSearch(customer.name ?? '');
    setProjectTitle(project.title ?? '');
    setExtracted(true);
  };

  const handleSave = async () => {
    setError(null);
    setSaving(true);

    let custId = selectedCustomerId;

    // Step 1: create customer if no existing match selected
    if (!custId) {
      if (!customerName.trim()) {
        setError(STRINGS.customers.nameRequired);
        setSaving(false);
        return;
      }

      const address =
        street.trim() || zip.trim() || city.trim()
          ? { street: street.trim(), zip: zip.trim(), city: city.trim() }
          : null;

      const custResult = await customerApi.create({
        name: customerName.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address,
      });

      if (!custResult.ok) {
        setError(custResult.error.message);
        setSaving(false);
        return;
      }

      custId = custResult.data.id;
    }

    // Step 2: create project if title is provided
    if (projectTitle.trim()) {
      const num = projectNumber.trim() || generateProjectNumber();

      const projResult = await projectApi.create({
        number: num,
        title: projectTitle.trim(),
        customerId: custId,
      });

      if (!projResult.ok) {
        setError(projResult.error.message);
        setSaving(false);
        // Customer was already created — that's fine, it's a real customer
        return;
      }
    }

    // Refresh stores
    fetchCustomers();
    fetchMgmtProjects();
    useProjectStore.getState().fetchProjects();

    setSaving(false);
    onClose();
  };

  return (
    <div className={styles.formOverlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={styles.formPanel} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.formTitle}>{STRINGS.ui.extractEmail}</h2>

        {!extracted ? (
          <>
            <div className={styles.formGroup}>
              <textarea
                className={styles.formTextarea}
                value={emailText}
                onChange={(e) => setEmailText(e.target.value)}
                placeholder={STRINGS.ui.extractPlaceholder}
                rows={10}
                autoFocus
                data-testid="extract-email-input"
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={onClose}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleExtract}
                disabled={extracting || !emailText.trim()}
                data-testid="extract-submit"
              >
                {extracting ? STRINGS.ui.extracting : STRINGS.ui.extractButton}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Customer section */}
            <h3>{STRINGS.ui.customerData}</h3>

            {/* Existing customer search */}
            <div className={styles.formGroup} ref={matchRef}>
              <label className={styles.formLabel}>{STRINGS.ui.existingCustomer}</label>
              <input
                className={styles.formInput}
                value={
                  selectedCustomerId
                    ? (matchResults.find((c) => c.id === selectedCustomerId)?.name ?? matchSearch)
                    : matchSearch
                }
                onChange={(e) => {
                  setMatchSearch(e.target.value);
                  setSelectedCustomerId(null);
                  setMatchDropdownOpen(true);
                }}
                onClick={() => matchResults.length > 0 && setMatchDropdownOpen(true)}
                placeholder={STRINGS.ui.search}
                data-testid="extract-customer-search"
              />
              {matchDropdownOpen && matchResults.length > 0 && (
                <div className={styles.selectDropdown}>
                  {matchResults.map((c) => (
                    <div
                      key={c.id}
                      className={styles.selectOption}
                      onClick={() => {
                        setSelectedCustomerId(c.id);
                        setMatchSearch(c.name);
                        setMatchDropdownOpen(false);
                      }}
                    >
                      {c.name}
                      {c.phone ? ` — ${c.phone}` : ''}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {!selectedCustomerId && (
              <>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.name} *</label>
                  <input
                    className={styles.formInput}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    data-testid="extract-customer-name"
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.street}</label>
                  <input
                    className={styles.formInput}
                    value={street}
                    onChange={(e) => setStreet(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
                  <input
                    className={styles.formInput}
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                  />
                </div>
                <div className={styles.formGroup}>
                  <label className={styles.formLabel}>{STRINGS.ui.city}</label>
                  <input
                    className={styles.formInput}
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
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
              </>
            )}

            {/* Project section */}
            <h3>{STRINGS.ui.projectData}</h3>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.number}</label>
              <input
                className={styles.formInput}
                value={projectNumber}
                onChange={(e) => setProjectNumber(e.target.value)}
                placeholder={generateProjectNumber()}
                data-testid="extract-project-number"
              />
            </div>

            <div className={styles.formGroup}>
              <label className={styles.formLabel}>{STRINGS.ui.title}</label>
              <input
                className={styles.formInput}
                value={projectTitle}
                onChange={(e) => setProjectTitle(e.target.value)}
                data-testid="extract-project-title"
              />
            </div>

            {error && <div className={styles.error}>{error}</div>}

            <div className={styles.formActions}>
              <button className={styles.cancelButton} onClick={onClose}>
                {STRINGS.ui.cancel}
              </button>
              <button
                className={styles.submitButton}
                onClick={handleSave}
                disabled={saving || (!selectedCustomerId && !customerName.trim())}
                data-testid="extract-save"
              >
                {STRINGS.ui.save}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function generateProjectNumber(): string {
  const year = new Date().getFullYear();
  const rand = String(Math.floor(Math.random() * 900) + 100);
  return `${year}-${rand}`;
}

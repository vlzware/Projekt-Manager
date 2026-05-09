/**
 * Baustelle (site-address) form group used by both the project Create
 * form and the project Detail page edit surface. See ui/management.md
 * §8.8.6 for the form rule.
 *
 * Owns its own draft state — toggle + street/zip/city — and never
 * dispatches a request as a side-effect of a toggle or input change.
 * The parent reads the draft via {@link SiteAddressGroupHandle} and
 * builds the submit body; commit is the parent's call.
 *
 * Toggle behavior pinned by AC-281:
 *   - ON  : inputs disabled and visually muted; submit body's
 *           `siteAddress` is `null`.
 *   - OFF : inputs enabled; submit body's `siteAddress` is
 *           `{ street, zip, city }`. Switching back to ON discards
 *           the typed values without dispatching anything.
 */

import { useImperativeHandle, useState, type Ref } from 'react';
import { STRINGS } from '@/config/strings';
import type { Address } from '@/domain/types';
import styles from './Management.module.css';

/**
 * Tagged outcome of {@link SiteAddressGroupHandle.read}.
 *
 * - `valid` carries the request-body value the parent should submit:
 *     - toggle ON                     → `value: null`
 *     - toggle OFF + all three filled → `value: { street, zip, city }` (trimmed)
 * - `partial` is the AC-284 form-error case: toggle is OFF and exactly
 *   one or two of street/zip/city are populated (whitespace-only counts
 *   as empty). The parent surfaces `STRINGS.projects.siteAddressPartial`
 *   and refuses to dispatch.
 *
 * The "toggle OFF, all three blank" axis is unreachable by spec — the
 * toggle ON arm is the canonical "site at customer billing address"
 * submission. If a user manages it anyway, we treat it as `partial`
 * rather than silently coercing to null; the user must use the toggle
 * to express that intent.
 */
export type SiteAddressDraftReadResult =
  | { kind: 'valid'; value: Address | null }
  | { kind: 'partial' };

export interface SiteAddressGroupHandle {
  read: () => SiteAddressDraftReadResult;
}

interface Props {
  /**
   * Initial value seeded into the draft. `null` → toggle ON, inputs
   * empty + disabled. Non-null → toggle OFF, inputs pre-filled. Used
   * for both the create branch (always `null`) and the edit branch
   * (reflects the loaded `project.siteAddress`).
   */
  initial: Address | null;
  /** External lock (e.g. submit-in-flight). Independent of toggle ON. */
  disabled?: boolean;
  /** Imperative handle so parent reads the draft at submit time. */
  handleRef?: Ref<SiteAddressGroupHandle>;
}

export function SiteAddressGroup({ initial, disabled = false, handleRef }: Props) {
  // Initial toggle state derives from the seed: null ↔ ON.
  const [identical, setIdentical] = useState<boolean>(initial === null);
  // Inputs always carry the most recent typed value, even when the
  // toggle is ON (and the inputs are visually disabled). Switching
  // OFF → ON discards those values per AC-281.
  const [street, setStreet] = useState<string>(initial?.street ?? '');
  const [zip, setZip] = useState<string>(initial?.zip ?? '');
  const [city, setCity] = useState<string>(initial?.city ?? '');

  useImperativeHandle(
    handleRef,
    () => ({
      read: (): SiteAddressDraftReadResult => {
        if (identical) return { kind: 'valid', value: null };
        const s = street.trim();
        const z = zip.trim();
        const c = city.trim();
        const filledCount = [s, z, c].filter((v) => v.length > 0).length;
        // All three filled → valid triple. All three blank or exactly
        // 1–2 filled → partial (the all-blank-OFF case is unreachable
        // by spec; routing it through `partial` forces the user to use
        // the toggle to express "site = customer address" intent).
        if (filledCount === 3) return { kind: 'valid', value: { street: s, zip: z, city: c } };
        return { kind: 'partial' };
      },
    }),
    [identical, street, zip, city],
  );

  const inputsDisabled = disabled || identical;

  return (
    <fieldset className={styles.formGroup}>
      <legend className={styles.formLabel}>{STRINGS.projects.siteAddressLabel}</legend>

      <label className={styles.checkboxLabel}>
        <input
          type="checkbox"
          checked={identical}
          onChange={(e) => {
            const next = e.target.checked;
            setIdentical(next);
            // OFF → ON discards typed values per AC-281. Clearing
            // here keeps the next OFF flip visibly empty without a
            // separate "have I been here before?" piece of state.
            if (next) {
              setStreet('');
              setZip('');
              setCity('');
            }
          }}
          disabled={disabled}
        />
        {STRINGS.projects.siteAddressIdenticalToggle}
      </label>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.street}</label>
        <input
          className={styles.formInput}
          value={street}
          onChange={(e) => setStreet(e.target.value)}
          disabled={inputsDisabled}
          data-testid="project-site-street-input"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.zip}</label>
        <input
          className={styles.formInput}
          value={zip}
          onChange={(e) => setZip(e.target.value)}
          disabled={inputsDisabled}
          data-testid="project-site-zip-input"
        />
      </div>

      <div className={styles.formGroup}>
        <label className={styles.formLabel}>{STRINGS.ui.city}</label>
        <input
          className={styles.formInput}
          value={city}
          onChange={(e) => setCity(e.target.value)}
          disabled={inputsDisabled}
          data-testid="project-site-city-input"
        />
      </div>
    </fieldset>
  );
}

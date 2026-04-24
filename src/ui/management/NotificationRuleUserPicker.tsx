/**
 * User autocomplete + chip list for the notification-rule form.
 *
 * Extracted from `NotificationRuleForm` so both files stay under the
 * C-SIZE guideline. Receives already-fetched users + selected ids from
 * the parent — the picker itself holds only local UI state (the search
 * needle).
 *
 * The suggestion list is a plain `role="listbox"` of buttons (each one
 * the accessible `option`-equivalent). No keyboard-navigation contract
 * today — clicking a suggestion adds it to the list; empty needle
 * hides the suggestion surface entirely.
 */

import { useMemo, useState } from 'react';
import type { User } from '@/domain/types';
import { STRINGS } from '@/config/strings';
import managementStyles from './Management.module.css';
import styles from './NotificationRuleForm.module.css';

const MAX_SUGGESTIONS = 8;

interface Props {
  /** Full user list (active + inactive — filtering is internal). */
  users: User[];
  selectedIds: string[];
  onAdd: (id: string) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}

export function NotificationRuleUserPicker({
  users,
  selectedIds,
  onAdd,
  onRemove,
  disabled = false,
}: Props) {
  const [search, setSearch] = useState('');

  // Full map lets us render a chip label for an already-selected user
  // even if that user is no longer active — edits to a rule pre-dating
  // a deactivation should still show the name rather than a bare UUID.
  const userById = useMemo(() => {
    const map = new Map<string, User>();
    for (const u of users) map.set(u.id, u);
    return map;
  }, [users]);

  const suggestions = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle === '') return [];
    return users
      .filter((u) => u.active && !selectedIds.includes(u.id))
      .filter(
        (u) =>
          u.displayName.toLowerCase().includes(needle) || u.username.toLowerCase().includes(needle),
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [users, selectedIds, search]);

  const handleAdd = (id: string) => {
    onAdd(id);
    setSearch('');
  };

  return (
    <>
      <div className={styles.userPicker}>
        <input
          id="notification-rule-user-search"
          className={managementStyles.formInput}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={STRINGS.notifications.rules.userPickerPlaceholder}
          disabled={disabled}
          data-testid="notification-rule-user-search"
        />
        {search.trim() !== '' && (
          <div className={styles.suggestionList} role="listbox">
            {suggestions.length === 0 ? (
              <div className={styles.suggestionEmpty}>
                {STRINGS.notifications.rules.userPickerEmpty}
              </div>
            ) : (
              suggestions.map((u) => (
                <button
                  key={u.id}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => handleAdd(u.id)}
                  data-testid={`notification-rule-user-suggestion-${u.id}`}
                >
                  {u.displayName} <span className={styles.suggestionSecondary}>({u.username})</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
      {selectedIds.length > 0 && (
        <ul className={styles.chipList}>
          {selectedIds.map((id) => {
            const u = userById.get(id);
            const label = u ? `${u.displayName} (${u.username})` : id;
            return (
              <li key={id} className={styles.chip}>
                <span>{label}</span>
                <button
                  type="button"
                  className={styles.chipRemove}
                  onClick={() => onRemove(id)}
                  disabled={disabled}
                  aria-label={STRINGS.notifications.rules.removeUser}
                  data-testid={`notification-rule-user-chip-remove-${id}`}
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

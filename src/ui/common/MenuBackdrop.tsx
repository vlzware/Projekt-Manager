import styles from './MenuBackdrop.module.css';

interface Props {
  onClose: () => void;
}

/**
 * Invisible viewport-covering layer for an open menu/dropdown. Render as
 * a sibling immediately *before* the dropdown's JSX so the dropdown
 * paints on top. The backdrop intercepts clicks that would otherwise
 * close the menu via a document-level listener while also activating
 * whatever sat under the cursor (#130). One click closes the menu;
 * a second click is needed to interact with anything else — the same
 * UX every popover library converges on.
 */
export function MenuBackdrop({ onClose }: Props) {
  return <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />;
}

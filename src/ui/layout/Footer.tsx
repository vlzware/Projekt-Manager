import { BRANDING } from '@/config/brandingConfig';
import { StorageUsageBadge } from './StorageUsageBadge';
import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      <span className={styles.brand}>{BRANDING.footerText}</span>
      <StorageUsageBadge />
    </footer>
  );
}

import { BRANDING } from '@/config/brandingConfig';
import styles from './Footer.module.css';

export function Footer() {
  return (
    <footer className={styles.footer}>
      {BRANDING.footerText}
    </footer>
  );
}

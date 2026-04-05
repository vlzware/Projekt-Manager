/**
 * Branding configuration — customer-specific per ADR-0001.
 * Each installation overrides these values for their company.
 */
export interface BrandingConfig {
  appName: string;
  footerText: string;
}

export const BRANDING: BrandingConfig = {
  appName: 'Projekt-Manager',
  footerText: 'Projekt-Manager \u00B7 Iteration 2',
};

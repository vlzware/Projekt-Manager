/**
 * SVG icons for the mobile bottom tab bar.
 *
 * Inline rather than icon-font: no extra HTTP request, themeable via
 * `currentColor`, and trivially tree-shakable. The route→icon mapping
 * lives in `tabBarIconMap.ts`; keep that and this file in sync when
 * adding a new primary route.
 */
import type { SVGProps } from 'react';

export type IconProps = SVGProps<SVGSVGElement>;

const Base = ({ children, ...props }: IconProps & { children: React.ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...props}
  >
    {children}
  </svg>
);

export const MyProjectsIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="8" y="3" width="8" height="4" rx="1" />
    <path d="M9 12h6M9 16h4" />
    <path d="M5 7v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7" />
  </Base>
);

export const KanbanIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="4" width="5" height="16" rx="1" />
    <rect x="10" y="4" width="5" height="10" rx="1" />
    <rect x="17" y="4" width="4" height="13" rx="1" />
  </Base>
);

export const CalendarIcon = (props: IconProps) => (
  <Base {...props}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 9h18M8 3v4M16 3v4" />
  </Base>
);

export const ProjectsIcon = (props: IconProps) => (
  <Base {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </Base>
);

export const CustomersIcon = (props: IconProps) => (
  <Base {...props}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
    <circle cx="17" cy="9" r="2.5" />
    <path d="M21.5 18a4.5 4.5 0 0 0-7-3.7" />
  </Base>
);

import type { ComponentType } from 'react';
import type { RouteView } from '@/config/routes';
import {
  type IconProps,
  CalendarIcon,
  CustomersIcon,
  KanbanIcon,
  MyProjectsIcon,
  ProjectsIcon,
} from './tabBarIcons';

export const TAB_BAR_ICONS: Partial<Record<RouteView, ComponentType<IconProps>>> = {
  meineProjekte: MyProjectsIcon,
  kanban: KanbanIcon,
  kalender: CalendarIcon,
  projekte: ProjectsIcon,
  kunden: CustomersIcon,
};

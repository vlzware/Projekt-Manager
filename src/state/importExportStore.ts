/**
 * Import/Export state — bulk import and filtered export.
 *
 * Handles file parsing on the client side, API calls for import/export,
 * and file download generation for exports.
 */

import { create } from 'zustand';
import type { ImportResult } from '@/domain/types';
import { customerApi, projectApi, exportApi } from '@/api/client';
import { formatDateOnly } from '@/domain/dateFormat';
import { handleSessionExpired } from './sessionExpired';
import { useProjectStore } from './projectStore';
import { useCustomerStore } from './customerStore';

type EntityType = 'customers' | 'projects';

interface ImportExportState {
  // Import
  importEntity: EntityType;
  importData: Record<string, unknown>[] | null;
  importResult: ImportResult | null;
  importError: string | null;
  importing: boolean;

  // Export
  exportEntity: EntityType;
  exportStatus: string;
  exportCustomerFilter: '' | 'true' | 'false';
  exporting: boolean;
  exportError: string | null;

  setImportEntity: (entity: EntityType) => void;
  setImportData: (data: Record<string, unknown>[] | null) => void;
  setImportError: (error: string | null) => void;
  clearImportState: () => void;

  setExportEntity: (entity: EntityType) => void;
  setExportStatus: (status: string) => void;
  setExportCustomerFilter: (filter: '' | 'true' | 'false') => void;

  runImport: () => Promise<void>;
  runExport: () => Promise<void>;
}

export const useImportExportStore = create<ImportExportState>((set, get) => ({
  importEntity: 'customers',
  importData: null,
  importResult: null,
  importError: null,
  importing: false,

  exportEntity: 'projects',
  exportStatus: '',
  exportCustomerFilter: '',
  exporting: false,
  exportError: null,

  setImportEntity: (entity) =>
    set({ importEntity: entity, importData: null, importResult: null, importError: null }),
  setImportData: (data) => set({ importData: data, importResult: null, importError: null }),
  setImportError: (error) => set({ importError: error }),
  clearImportState: () => set({ importData: null, importResult: null, importError: null }),

  setExportEntity: (entity) =>
    set({ exportEntity: entity, exportStatus: '', exportCustomerFilter: '', exportError: null }),
  setExportStatus: (status) => set({ exportStatus: status }),
  setExportCustomerFilter: (filter) => set({ exportCustomerFilter: filter }),

  runImport: async () => {
    const { importEntity, importData } = get();
    if (!importData || importData.length === 0) return;

    set({ importing: true, importError: null, importResult: null });

    const result =
      importEntity === 'customers'
        ? await customerApi.bulkImport(importData)
        : await projectApi.bulkImport(importData);

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ importing: false, importError: result.error.message });
      return;
    }

    set({ importing: false, importResult: result.data });

    // Refresh the affected stores so newly imported records are visible
    // without a manual page reload.
    if (importEntity === 'projects') {
      useProjectStore.getState().fetchProjects();
    } else {
      useCustomerStore.getState().fetchCustomers();
    }
  },

  runExport: async () => {
    const { exportEntity, exportStatus, exportCustomerFilter } = get();
    set({ exporting: true, exportError: null });

    const result =
      exportEntity === 'projects'
        ? await exportApi.projects(exportStatus ? { status: exportStatus } : undefined)
        : await exportApi.customers(
            exportCustomerFilter ? { hasProjects: exportCustomerFilter } : undefined,
          );

    if (!result.ok) {
      if (result.sessionExpired) {
        handleSessionExpired();
        return;
      }
      set({ exporting: false, exportError: result.error.message });
      return;
    }

    set({ exporting: false });

    // Trigger file download
    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const entityLabel = exportEntity === 'projects' ? 'projekte' : 'kunden';
    const datePart = formatDateOnly(new Date());
    a.href = url;
    a.download = `${entityLabel}-${datePart}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },
}));

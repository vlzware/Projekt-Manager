import { create } from 'zustand';
import type { Attachment, AttachmentLabel } from '@/domain/types';

export interface PendingUpload {
  clientId: string;
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  status: 'initializing' | 'uploading' | 'completing' | 'failed';
  attachmentId: string | null;
  progress: number;
  errorMessage: string | null;
}

interface AttachmentState {
  byProject: Record<string, Attachment[]>;
  pendingUploads: Record<string, PendingUpload>;
  error: string | null;

  fetchForProject: (projectId: string) => Promise<void>;
  uploadFile: (
    projectId: string,
    file: File,
    input: { label: AttachmentLabel; hasThumbnail: boolean },
  ) => Promise<void>;
  retryUpload: (clientId: string) => Promise<void>;
  dismissUpload: (clientId: string) => void;
  deleteAttachment: (projectId: string, attachmentId: string) => Promise<void>;
  requestDownloadUrl: (
    projectId: string,
    attachmentId: string,
    variant: 'original' | 'thumbnail',
  ) => Promise<string | null>;
  requestBulkDownloadUrl: (projectId: string, attachmentIds: string[]) => Promise<string | null>;
  clearError: () => void;
}

export const useAttachmentStore = create<AttachmentState>(() => ({
  byProject: {},
  pendingUploads: {},
  error: null,

  fetchForProject: async (_projectId: string) => {},

  uploadFile: async (_projectId: string, _file: File, _input) => {},

  retryUpload: async (_clientId: string) => {},

  dismissUpload: (_clientId: string) => {},

  deleteAttachment: async (_projectId: string, _attachmentId: string) => {},

  requestDownloadUrl: async (
    _projectId: string,
    _attachmentId: string,
    _variant: 'original' | 'thumbnail',
  ) => null,

  requestBulkDownloadUrl: async (_projectId: string, _attachmentIds: string[]) => null,

  clearError: () => {},
}));

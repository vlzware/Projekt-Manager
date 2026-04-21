import type { Database } from '../db/connection.js';
import type { AuthUser } from '../middleware/auth.js';
import type { ServiceLogger } from './Logger.js';
import type { Attachment, AttachmentLabel } from '../../domain/types.js';

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
  expiresAt: string;
}

export interface InitUploadInput {
  projectId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  label: AttachmentLabel;
  hasThumbnail: boolean;
}

export interface InitUploadResult {
  attachment: Attachment;
  originalUpload: PresignedPost;
  thumbnailUpload?: PresignedPost;
}

export interface DownloadUrlResult {
  url: string;
  expiresAt: string;
}

export type DownloadVariant = 'original' | 'thumbnail';

export class AttachmentService {
  constructor(private db: Database) {
    void this.db;
  }

  async initUpload(
    _caller: AuthUser,
    _input: InitUploadInput,
    _log: ServiceLogger,
    _correlationId: string | null,
  ): Promise<InitUploadResult> {
    throw new Error('not implemented');
  }

  async completeUpload(
    _caller: AuthUser,
    _projectId: string,
    _attachmentId: string,
    _log: ServiceLogger,
    _correlationId: string | null,
  ): Promise<Attachment> {
    throw new Error('not implemented');
  }

  async deleteAttachment(
    _caller: AuthUser,
    _projectId: string,
    _attachmentId: string,
    _log: ServiceLogger,
    _correlationId: string | null,
  ): Promise<void> {
    throw new Error('not implemented');
  }

  async listForProject(_caller: AuthUser, _projectId: string): Promise<Attachment[]> {
    throw new Error('not implemented');
  }

  async issueDownloadUrl(
    _caller: AuthUser,
    _projectId: string,
    _attachmentId: string,
    _variant: DownloadVariant,
  ): Promise<DownloadUrlResult> {
    throw new Error('not implemented');
  }

  async issueBulkDownloadUrl(
    _caller: AuthUser,
    _projectId: string,
    _attachmentIds: string[],
  ): Promise<DownloadUrlResult> {
    throw new Error('not implemented');
  }
}

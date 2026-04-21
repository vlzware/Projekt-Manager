import type { Database, MutatingDatabase } from '../db/connection.js';
import type { attachments } from '../db/schema.js';
import type { AttachmentKind, AttachmentLabel, AttachmentStatus } from '../../domain/types.js';

export type AttachmentRow = typeof attachments.$inferSelect;

export interface CreatePendingAttachmentInput {
  projectId: string;
  kind: AttachmentKind;
  label: AttachmentLabel;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  originalKey: string;
  thumbKey: string | null;
  hasThumbnail: boolean;
  createdBy: string | null;
}

export async function listByProject(db: Database, projectId: string): Promise<AttachmentRow[]> {
  void db;
  void projectId;
  throw new Error('not implemented');
}

export async function getById(db: Database, id: string): Promise<AttachmentRow | null> {
  void db;
  void id;
  throw new Error('not implemented');
}

export async function createPending(
  db: MutatingDatabase,
  input: CreatePendingAttachmentInput,
): Promise<AttachmentRow> {
  void db;
  void input;
  throw new Error('not implemented');
}

export async function markReady(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  void db;
  void id;
  throw new Error('not implemented');
}

export async function deleteById(db: MutatingDatabase, id: string): Promise<AttachmentRow | null> {
  void db;
  void id;
  throw new Error('not implemented');
}

export async function listReadyForProject(
  db: Database,
  projectId: string,
  attachmentIds: string[],
): Promise<AttachmentRow[]> {
  void db;
  void projectId;
  void attachmentIds;
  throw new Error('not implemented');
}

export type { AttachmentStatus };

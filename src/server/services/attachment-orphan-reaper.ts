import type { Database } from '../db/connection.js';
import type { StorageClient } from '../storage/client.js';
import type { ServiceLogger } from './Logger.js';

export interface RunAttachmentOrphanReaperDeps {
  db: Database;
  storage: StorageClient;
  logger: ServiceLogger;
  ttlMinutes: number;
  now?: Date;
}

export const EVENT_ATTACHMENT_ORPHAN_REAPER = 'attachment-orphan-reaper';

export async function runAttachmentOrphanReaper(
  _deps: RunAttachmentOrphanReaperDeps,
): Promise<void> {
  throw new Error('not implemented');
}

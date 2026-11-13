import './config';

import { Module } from '@nestjs/common';

import { BackendRuntimeModule } from '../backend-runtime';
import { PermissionModule } from '../permission';
import { QuotaModule } from '../quota';
import { StorageModule } from '../storage';
import { PgUserspaceDocStorageAdapter } from './adapters/userspace';
import { PgWorkspaceDocStorageAdapter } from './adapters/workspace';
import { DocBlockEditor } from './blocks';
import { DocEventsListener } from './event';
import { DocStorageCronJob } from './job';
import { DocStorageOptions } from './options';
import { DocOrganizer } from './organizer';
import { DatabaseDocReader, DocReader, DocReaderProvider } from './reader';
import { DocWriter } from './writer';

@Module({
  imports: [BackendRuntimeModule, QuotaModule, PermissionModule, StorageModule],
  providers: [
    DocStorageOptions,
    PgWorkspaceDocStorageAdapter,
    PgUserspaceDocStorageAdapter,
    DocStorageCronJob,
    DocReaderProvider,
    DatabaseDocReader,
    DocEventsListener,
    DocWriter,
    DocOrganizer,
    DocBlockEditor,
  ],
  exports: [
    DatabaseDocReader,
    DocReader,
    DocWriter,
    DocOrganizer,
    DocBlockEditor,
    PgWorkspaceDocStorageAdapter,
    PgUserspaceDocStorageAdapter,
  ],
})
export class DocStorageModule {}
export {
  // only for doc-service
  DatabaseDocReader,
  DocBlockEditor,
  DocOrganizer,
  DocReader,
  DocWriter,
  PgUserspaceDocStorageAdapter,
  PgWorkspaceDocStorageAdapter,
};

export {
  CANVAS_COLORS,
  type CanvasItemInput,
  DATABASE_COLUMN_TYPES,
  SHAPE_TYPES,
} from './blocks';
export { TAG_COLORS } from './organizer';
export { DocStorageAdapter, type Editor } from './storage';

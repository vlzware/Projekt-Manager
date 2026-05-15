// Local ambient declarations for `archiver` v8.
//
// archiver@8 dropped CJS and the function default export; the runtime
// now exports named ESM classes (`ZipArchive`, `TarArchive`,
// `JsonArchive`) extending a base `Archiver` Transform. As of
// 2026-05-15, `@types/archiver@7` on DefinitelyTyped still types the
// pre-v8 function shape (`declare function archiver(format, options)`)
// and has no class exports. We override locally; remove this file when
// DefinitelyTyped publishes a v8-aware release.

declare module 'archiver' {
  import * as stream from 'node:stream';
  import { ZlibOptions } from 'node:zlib';

  interface EntryData {
    name: string;
    date?: Date | string;
    mode?: number;
    prefix?: string;
  }

  interface ZipEntryData extends EntryData {
    store?: boolean;
  }

  interface ArchiverOptions {
    zlib?: ZlibOptions;
    comment?: string;
    forceLocalTime?: boolean;
    forceZip64?: boolean;
    namePrependSlash?: boolean;
    store?: boolean;
    statConcurrency?: number;
    gzip?: boolean;
    gzipOptions?: ZlibOptions;
  }

  class ArchiverError extends Error {
    code: string;
    data: unknown;
  }

  class Archiver extends stream.Transform {
    abort(): this;
    append(source: stream.Readable | Buffer | string, data?: EntryData | ZipEntryData): this;
    finalize(): Promise<void>;
    pointer(): number;
    on(event: 'error' | 'warning', listener: (error: ArchiverError) => void): this;
    on(event: 'data', listener: (data: Buffer) => void): this;
    on(event: 'end' | 'close' | 'finish' | 'drain', listener: () => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export { Archiver };
  export class ZipArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
  export class TarArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
  export class JsonArchive extends Archiver {
    constructor(options?: ArchiverOptions);
  }
}

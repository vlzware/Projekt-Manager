/// <reference types="vite/client" />

// Ambient shim for `piexifjs`, which ships no type declarations and has
// no `@types/piexifjs` on npm. Only the surface we use in the image
// pipeline (`src/domain/imagePipeline.ts`) is typed — `dump`, `insert`,
// and the `ImageIFD` / `ExifIFD` / `GPSIFD` / `TAGS` catalogues. Kept
// intentionally narrow so additions are deliberate.
declare module 'piexifjs' {
  interface PiexifNamespace {
    dump(exif: Record<string, unknown>): string;
    insert(exifBytes: string, jpegDataUri: string): string;
    load(jpegDataUri: string): Record<string, unknown>;
    ImageIFD: Record<string, number>;
    ExifIFD: Record<string, number>;
    GPSIFD: Record<string, number>;
    TAGS: Record<string, Record<number, { name: string; type: string }>>;
  }
  const piexif: PiexifNamespace;
  export default piexif;
}

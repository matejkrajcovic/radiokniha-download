// Type declarations for mp3tag.js (Deno)
import { Buffer } from "node:buffer";

declare interface MP3TagSaveOptions {
  strict?: boolean;
  id3v2?: { padding?: number };
}
declare interface MP3TagTags {
  title?: string;
  artist?: string;
  album?: string;
  track?: string | number;
  [key: string]: unknown;
}
declare class MP3TagBase {
  constructor(buffer: ArrayBuffer | Uint8Array | Buffer, useId3v1?: boolean);
  error: string;
  tags: MP3TagTags;
  read(options?: { id3v1?: boolean }): void;
  save(options?: MP3TagSaveOptions): Uint8Array | ArrayBuffer | number[];
}
declare const MP3Tag: typeof MP3TagBase;
export default MP3Tag;

// In-memory ZIP reader, ported from the prototype's engine/archive-files.mjs and
// hardened for server use. Nothing is written to disk or executed; paths, sizes,
// compression ratios and checksums are checked before any content is returned.
import {deflateRawSync, inflateRawSync} from 'node:zlib';

export const ZIP_LIMITS = Object.freeze({archiveBytes: 50_000_000, entries: 10_000, entryBytes: 25_000_000, totalBytes: 200_000_000, maxRatio: 200});

export type ZipEntry = {name: string; method: number; compressedSize: number; size: number; crc: number; localOffset: number; encrypted: boolean; symlink: boolean};
export type ZipArchive = {entries: ZipEntry[]; read(name: string): Buffer; text(name: string): string | null; has(name: string): boolean};

export class ZipError extends Error {
  constructor(message: string) { super(message); this.name = 'ZipError'; }
}

function checkedPath(name: string): string {
  const path = name.replaceAll('\\', '/');
  if (path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..') || path.includes('\0')) throw new ZipError('The archive contains an unsafe file path.');
  return path;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
})();
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function openZip(input: Uint8Array): ZipArchive {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > ZIP_LIMITS.archiveBytes) throw new ZipError('Use an archive smaller than 50 MB.');
  const u16 = (offset: number) => bytes.readUInt16LE(offset), u32 = (offset: number) => bytes.readUInt32LE(offset);

  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset--)
    if (u32(offset) === 0x06054b50 && offset + 22 + u16(offset + 20) === bytes.length) { end = offset; break; }
  if (end < 0) throw new ZipError('This file is not a valid ZIP-based document.');
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10)) throw new ZipError('Split archives are unsupported.');
  const count = u16(end + 10), size = u32(end + 12), offset = u32(end + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) throw new ZipError('ZIP64 archives are unsupported.');
  if (count > ZIP_LIMITS.entries || offset + size > end) throw new ZipError('The archive directory exceeds supported limits.');

  const entries: ZipEntry[] = [], byName = new Map<string, ZipEntry>();
  let cursor = offset, total = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > offset + size || u32(cursor) !== 0x02014b50) throw new ZipError('The archive directory is damaged.');
    const flags = u16(cursor + 8), method = u16(cursor + 10), compressedSize = u32(cursor + 20), uncompressed = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extraLength = u16(cursor + 30), commentLength = u16(cursor + 32), attributes = u32(cursor + 38);
    if (cursor + 46 + nameLength + extraLength + commentLength > offset + size) throw new ZipError('The archive directory is truncated.');
    const name = checkedPath(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    if (byName.has(name)) throw new ZipError('The archive contains duplicate paths.');
    total += uncompressed;
    if (total > ZIP_LIMITS.totalBytes) throw new ZipError('The archive expands beyond 200 MB.');
    const entry: ZipEntry = {name, method, compressedSize, size: uncompressed, crc: u32(cursor + 16), localOffset: u32(cursor + 42), encrypted: Boolean(flags & 1), symlink: ((attributes >>> 16) & 0xf000) === 0xa000};
    entries.push(entry); byName.set(name, entry);
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const read = (name: string): Buffer => {
    const entry = byName.get(name);
    if (!entry) throw new ZipError(`${name} is missing from the archive.`);
    if (entry.encrypted) throw new ZipError(`${name} is encrypted.`);
    if (entry.symlink) throw new ZipError(`${name} is a symbolic link.`);
    if (entry.size > ZIP_LIMITS.entryBytes) throw new ZipError(`${name} is larger than 25 MB.`);
    if (entry.compressedSize > 0 && entry.size / entry.compressedSize > ZIP_LIMITS.maxRatio) throw new ZipError(`${name} has a suspicious compression ratio.`);
    const local = entry.localOffset;
    if (local + 30 > bytes.length || u32(local) !== 0x04034b50) throw new ZipError(`${name} has a damaged header.`);
    const start = local + 30 + u16(local + 26) + u16(local + 28), raw = bytes.subarray(start, start + entry.compressedSize);
    if (raw.length !== entry.compressedSize) throw new ZipError(`${name} is truncated.`);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(raw);
    else if (entry.method === 8) {
      try { data = inflateRawSync(raw, {maxOutputLength: entry.size + 1}); }
      catch { throw new ZipError(`${name} could not be decompressed.`); }
    } else throw new ZipError(`${name} uses an unsupported compression method.`);
    if (data.length !== entry.size || crc32(data) !== entry.crc) throw new ZipError(`${name} failed its integrity check.`);
    return data;
  };
  return {
    entries, read, has: name => byName.has(name),
    text: name => byName.has(name) ? read(name).toString('utf8') : null,
  };
}

// Minimal ZIP writer for tests and fixtures (stored or deflated, no encryption).
export function writeZip(files: Record<string, string | Uint8Array>, {deflate = true} = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content), packed = deflate ? deflateRawSync(data) : data, nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc32(data), 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc32(data), 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22), count = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

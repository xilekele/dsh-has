/**
 * Minimal ZIP reader/writer — just enough for Office OOXML packages.
 *
 * Reading supports stored (0) and deflated (8) entries, which covers everything
 * Word/PowerPoint/Excel produce. Writing stores entries uncompressed (method 0),
 * which every OOXML consumer accepts and keeps this dependency-free.
 */
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

let crcTable = null;

function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let value = i;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[i] = value;
    }
  }
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

/**
 * Read a ZIP archive.
 * @returns {Map<string, Buffer>} entry name → uncompressed bytes, in archive order
 */
export function readZip(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);

  let eocd = -1;
  for (let i = source.length - 22; i >= Math.max(0, source.length - 65558); i -= 1) {
    if (source.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive: end of central directory not found');

  const count = source.readUInt16LE(eocd + 10);
  let offset = source.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let index = 0; index < count; index += 1) {
    if (source.readUInt32LE(offset) !== CENTRAL_SIG) throw new Error('Corrupt ZIP: bad central directory entry');
    const flags = source.readUInt16LE(offset + 8);
    const method = source.readUInt16LE(offset + 10);
    const compressedSize = source.readUInt32LE(offset + 20);
    const uncompressedSize = source.readUInt32LE(offset + 24);
    const nameLength = source.readUInt16LE(offset + 28);
    const extraLength = source.readUInt16LE(offset + 30);
    const commentLength = source.readUInt16LE(offset + 32);
    const localOffset = source.readUInt32LE(offset + 42);
    const name = source.toString(flags & 0x800 ? 'utf8' : 'latin1', offset + 46, offset + 46 + nameLength);

    if (source.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`Corrupt ZIP: bad local header for ${name}`);
    const localNameLength = source.readUInt16LE(localOffset + 26);
    const localExtraLength = source.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = source.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);

    if (data.length !== uncompressedSize) {
      throw new Error(`Corrupt ZIP: size mismatch for ${name} (${data.length} != ${uncompressedSize})`);
    }
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/**
 * Write a ZIP archive with stored (uncompressed) entries.
 * @param {Map<string, Buffer|string>|Array<[string, Buffer|string]>} entries
 */
export function writeZip(entries) {
  const list = entries instanceof Map ? [...entries.entries()] : entries;
  const { time, day } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const [name, value] of list) {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuffer, data);
    centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(list.length, 8);
  eocd.writeUInt16LE(list.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, eocd]);
}

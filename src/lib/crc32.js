// Slicing-by-8 tables: media dominates archive size, so CRC32 processes eight
// bytes per step instead of one.
const CRC_TABLES = (() => {
  const tables = Array.from({ length: 8 }, () => new Uint32Array(256));
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    tables[0][index] = value >>> 0;
  }
  for (let index = 0; index < 256; index++) {
    for (let table = 1; table < 8; table++) tables[table][index] = (tables[table - 1][index] >>> 8) ^ tables[0][tables[table - 1][index] & 0xff];
  }
  return tables;
})();

export function updateCrc(crc, data) {
  const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
  const length = data.length, aligned = length - (length % 8);
  let index = 0;
  for (; index < aligned; index += 8) {
    const low = crc ^ (data[index] | data[index + 1] << 8 | data[index + 2] << 16 | data[index + 3] << 24);
    crc = t7[low & 0xff] ^ t6[(low >>> 8) & 0xff] ^ t5[(low >>> 16) & 0xff] ^ t4[low >>> 24] ^
      t3[data[index + 4]] ^ t2[data[index + 5]] ^ t1[data[index + 6]] ^ t0[data[index + 7]];
  }
  for (; index < length; index++) crc = t0[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
  return crc;
}

export function crc32(data) { return (updateCrc(0xffffffff, data) ^ 0xffffffff) >>> 0; }

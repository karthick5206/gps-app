/** CRC-16/X-25 (CRC-ITU as used by GT06): reflected poly 0x8408, init 0xFFFF, xorout 0xFFFF. */
const TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crcItu(buf: Uint8Array, start = 0, end = buf.length): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = (crc >>> 8) ^ TABLE[(crc ^ buf[i]) & 0xff];
  return ~crc & 0xffff;
}

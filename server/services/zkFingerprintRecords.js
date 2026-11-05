const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function indexFingerprintRecords(data, userUids) {
  assert.ok(data.length === 0 || (data.length >= 4 && data.readUInt32LE(0) === data.length - 4), 'Listado de huellas incompleto.');
  const groups = new Map();
  const owners = new Set();
  let recordCount = 0;
  for (let offset = 4; offset < data.length;) {
    assert.ok(offset + 6 <= data.length, 'Cabecera de huella incompleta.');
    const size = data.readUInt16LE(offset);
    assert.ok(size > 6 && offset + size <= data.length, 'Plantilla de huella incompleta.');
    const uid = data.readUInt16LE(offset + 2);
    const finger = data[offset + 4];
    assert.ok(uid > 0 && userUids.has(uid) && finger <= 9, 'Huella sin usuario o dedo invalido.');
    const key = `${uid}:${finger}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(hash(data.subarray(offset, offset + size)));
    owners.add(uid);
    recordCount++;
    offset += size;
  }
  const templates = new Map();
  for (const [key, hashes] of groups) {
    // A clock may return several records for one finger. Preserve every record,
    // including repetitions, while making integrity checks independent of order.
    templates.set(key, hashes.length === 1 ? hashes[0] : hash(`asisto-finger-records-v1:${JSON.stringify(hashes.sort())}`));
  }
  return { templates, recordCount, owners };
}

module.exports = { indexFingerprintRecords };

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../src/utils/deviceSelection.js'), 'utf8');
const modulePromise = import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const devices = [{ id: 'thessa' }, { id: 'yl' }];

test('keeps Base YL selected after a reload rather than silently switching to Thessa', async () => {
  const { preferredDevice, rememberDevice } = await modulePromise;
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  rememberDevice('yl', 'admin', storage);
  assert.equal(preferredDevice(devices, 'admin', storage).id, 'yl');
  assert.equal(preferredDevice(devices, 'other-user', storage).id, 'thessa');
});

test('only restores devices present in the current authorized device list', async () => {
  const { preferredDevice } = await modulePromise;
  const storage = { getItem: () => 'yl' };
  assert.equal(preferredDevice([devices[0]], 'admin', storage).id, 'thessa');
  assert.equal(preferredDevice([], 'admin', storage), null);
});

test('browser storage failures and missing user identity do not break device selection', async () => {
  const { preferredDevice, rememberDevice } = await modulePromise;
  const storage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(preferredDevice(devices, 'admin', storage).id, 'thessa');
  assert.doesNotThrow(() => rememberDevice('yl', 'admin', storage));
  assert.doesNotThrow(() => rememberDevice('yl', null, storage));
});

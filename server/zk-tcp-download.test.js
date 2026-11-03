const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { COMMANDS: C, MAX_CHUNK } = require('zklib-js/constants');
const { createTCPHeader } = require('zklib-js/utils');
const { readTcpPreparedData, validateRecordBuffer } = require('./services/zkTcpDownload');

function fixture(data, options = {}) {
  const socket = new EventEmitter();
  const requests = [];
  const frame = (command, payload = Buffer.alloc(0)) => createTCPHeader(command, 1, 1, payload);
  socket.write = (message, callback) => {
    callback();
    queueMicrotask(() => {
      if (options.silent) return;
      const command = message.readUInt16LE(8);
      if (command === C.CMD_DATA_WRRQ) {
        if (options.direct) return socket.emit('data', frame(C.CMD_DATA, data));
        const payload = Buffer.alloc(13);
        payload.writeUInt32LE(data.length, 1);
        socket.emit('data', frame(C.CMD_ACK_OK, payload));
        return;
      }
      assert.equal(command, C.CMD_DATA_RDY);
      const start = message.readUInt32LE(16), size = message.readUInt32LE(20);
      requests.push([start, size]);
      const header = Buffer.alloc(8);
      header.writeUInt32LE(size);
      const payload = data.subarray(start, start + size - (options.truncate ? 1 : 0));
      const response = Buffer.concat([
        frame(C.CMD_PREPARE_DATA, header),
        frame(C.CMD_DATA, payload),
        frame(options.reject ? C.CMD_ACK_ERROR : C.CMD_ACK_OK),
      ]);
      // Both incomplete headers and coalesced frames occur over a VPN.
      socket.emit('data', response.subarray(0, 3));
      socket.emit('data', response.subarray(3, 13));
      socket.emit('data', response.subarray(13));
      if (options.close) socket.emit('close');
    });
    return true;
  };
  return { socket, sessionId: 1, replyId: 0, timeout: 30, requests };
}

test('downloads every byte of a 23,314-record history using sequential ranges', async () => {
  const data = Buffer.alloc(4 + 23314 * 40);
  data.writeUInt32LE(data.length - 4);
  for (let i = 4; i < data.length; i++) data[i] = i % 251;
  const tcp = fixture(data);
  assert.deepEqual(await readTcpPreparedData(tcp, Buffer.alloc(11)), data);
  assert.equal(validateRecordBuffer(data, 40).length / 40, 23314);
  assert.equal(tcp.requests.length, Math.ceil(data.length / MAX_CHUNK));
  assert.deepEqual(tcp.requests[1], [MAX_CHUNK, MAX_CHUNK]);
  assert.equal(tcp.socket.listenerCount('data'), 0);
  assert.equal(tcp.socket.listenerCount('close'), 0);
  assert.equal(tcp.socket.listenerCount('error'), 0);
});

test('accepts a direct response and an empty prepared history', async () => {
  const data = Buffer.alloc(44);
  data.writeUInt32LE(40);
  assert.deepEqual(await readTcpPreparedData(fixture(data, { direct: true }), Buffer.alloc(0)), data);
  assert.equal((await readTcpPreparedData(fixture(Buffer.alloc(0)), Buffer.alloc(0))).length, 0);
});

test('rejects a partial block instead of returning a successful partial history', async () => {
  const tcp = fixture(Buffer.alloc(200), { truncate: true });
  await assert.rejects(readTcpPreparedData(tcp, Buffer.alloc(0)), /incompleta/);
  assert.equal(tcp.socket.listenerCount('data'), 0);
});

test('rejects a device error and cleans up its listeners', async () => {
  const tcp = fixture(Buffer.alloc(200), { reject: true });
  await assert.rejects(readTcpPreparedData(tcp, Buffer.alloc(0)), /inesperada/);
  assert.equal(tcp.socket.listenerCount('error'), 0);
});

test('timeouts stop waiting and release listeners', async () => {
  const tcp = fixture(Buffer.alloc(0), { silent: true });
  await assert.rejects(readTcpPreparedData(tcp, Buffer.alloc(0)), /espera agotado/);
  assert.equal(tcp.socket.listenerCount('data'), 0);
});

test('a disconnect never returns a successful download', async () => {
  const tcp = fixture(Buffer.alloc(200), { close: true });
  await assert.rejects(readTcpPreparedData(tcp, Buffer.alloc(0)), /cerrada/);
});

test('validates the declared byte count and complete record boundaries', () => {
  const correct = Buffer.alloc(4 + 72 * 2);
  correct.writeUInt32LE(144);
  assert.equal(validateRecordBuffer(correct, 72).length, 144);
  assert.throws(() => validateRecordBuffer(correct.subarray(0, -1), 72), /incompleto/);
  assert.throws(() => validateRecordBuffer(correct, 40), /incompleto/);
  assert.throws(() => validateRecordBuffer(Buffer.alloc(3), 40), /incompleto/);
});

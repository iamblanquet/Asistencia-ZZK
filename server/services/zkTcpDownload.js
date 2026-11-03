const { COMMANDS, MAX_CHUNK } = require('zklib-js/constants');
const { createTCPHeader } = require('zklib-js/utils');

// TCP reads can split or combine ZK frames independently of device packets.
function createFrameReader(socket, timeout) {
  let buffer = Buffer.alloc(0);
  let failure = null;
  let pending = null;
  const frames = [];
  function fail(error) {
    failure = error;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
  }
  function onData(chunk) {
    if (failure) return;
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const length = buffer.readUInt32LE(4);
      if (buffer.readUInt32LE(0) !== 0x7d825050 || length < 8 || length > 64 * 1024 * 1024) {
        fail(new Error('Trama TCP ZK invalida.'));
        return;
      }
      if (buffer.length < length + 8) return;
      const frame = buffer.subarray(0, length + 8);
      buffer = buffer.subarray(length + 8);
      if (pending) {
        clearTimeout(pending.timer);
        pending.resolve(frame);
        pending = null;
      } else {
        frames.push(frame);
      }
    }
  }
  const onClose = () => fail(new Error('Conexion cerrada durante la descarga ZK.'));
  socket.on('data', onData);
  socket.on('close', onClose);
  socket.on('error', fail);
  return {
    next() {
      if (failure) return Promise.reject(failure);
      if (frames.length) return Promise.resolve(frames.shift());
      return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => fail(new Error('Tiempo de espera agotado durante la descarga ZK.')), timeout) };
      });
    },
    close() {
      if (pending) fail(new Error('Descarga ZK finalizada.'));
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', fail);
    },
  };
}

async function readTcpPreparedData(tcp, request) {
  const reader = createFrameReader(tcp.socket, tcp.timeout || 15000);
  const send = (command, data) => new Promise((resolve, reject) => {
    tcp.replyId++;
    tcp.socket.write(createTCPHeader(command, tcp.sessionId, tcp.replyId, data), error => error ? reject(error) : resolve());
  });
  try {
    await send(COMMANDS.CMD_DATA_WRRQ, request);
    const initial = await reader.next();
    const command = initial.readUInt16LE(8);
    if (command === COMMANDS.CMD_DATA) return initial.subarray(16);
    if (![COMMANDS.CMD_ACK_OK, COMMANDS.CMD_PREPARE_DATA].includes(command) || initial.length < 21) {
      throw new Error(`Respuesta ZK inesperada al preparar descarga: ${command}.`);
    }
    const size = initial.readUInt32LE(17);
    if (size > 64 * 1024 * 1024) throw new Error('Historial ZK excede el limite de descarga.');
    const parts = [];
    // Request one block at a time so a large history cannot overrun the reader.
    for (let start = 0; start < size; start += MAX_CHUNK) {
      const length = Math.min(MAX_CHUNK, size - start);
      const range = Buffer.alloc(8);
      range.writeUInt32LE(start, 0);
      range.writeUInt32LE(length, 4);
      await send(COMMANDS.CMD_DATA_RDY, range);
      let received = 0;
      let prepared = false;
      while (true) {
        const frame = await reader.next();
        const type = frame.readUInt16LE(8);
        const payload = frame.subarray(16);
        if (type === COMMANDS.CMD_PREPARE_DATA && !prepared && received === 0) {
          if (payload.length < 4 || payload.readUInt32LE(0) !== length) throw new Error('Tamano de bloque ZK incorrecto.');
          prepared = true;
        } else if (type === COMMANDS.CMD_DATA && payload.length > 0) {
          received += payload.length;
          if (received > length) throw new Error('Bloque ZK contiene datos adicionales.');
          parts.push(payload);
        } else if (type === COMMANDS.CMD_ACK_OK) {
          if (received !== length) throw new Error(`Descarga ZK incompleta: ${received}/${length} bytes en bloque ${start}.`);
          break;
        } else {
          throw new Error(`Respuesta ZK inesperada durante descarga: ${type}.`);
        }
      }
    }
    return Buffer.concat(parts, size);
  } finally {
    reader.close();
  }
}

function validateRecordBuffer(data, recordSize) {
  if (!data.length) return data;
  if (data.length < 4 || data.readUInt32LE(0) !== data.length - 4 || (data.length - 4) % recordSize !== 0) {
    throw new Error('El historial ZK esta incompleto o tiene un formato no compatible.');
  }
  return data.subarray(4);
}

module.exports = { readTcpPreparedData, validateRecordBuffer };

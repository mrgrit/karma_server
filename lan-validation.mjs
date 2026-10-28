import net from 'node:net';

export const LAN_PROTOCOL = 1;
export const LAN_DEFAULT_PORT = 29020;
export const LAN_MAX_LINE_BYTES = 64 * 1024;
const STATE_INTERVAL_MS = 50;
const HANDSHAKE_TIMEOUT_MS = 5000;
const MAX_WRITE_QUEUE_BYTES = 256 * 1024;
const GAME_TYPES = new Set(['state', 'hit', 'death', 'respawn', 'pause', 'leave']);
const ACTOR_TYPES = new Set(['state', 'hit', 'death', 'respawn']);

function fail(message) { throw new TypeError(message); }
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${name}`);
  return value;
}
function finite(value, name, limit = 1e7) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) fail(`Invalid ${name}`);
  return value;
}
function vector(value, name) {
  if (!Array.isArray(value) || value.length !== 3) fail(`Invalid ${name}`);
  value.forEach((n, i) => finite(n, `${name}[${i}]`));
}
function identifier(value, name) {
  if (typeof value === 'string' && value.length > 0 && value.length <= 96 && !/[\u0000-\u001f\u007f]/.test(value)) return;
  integer(value, name);
}
function boolean(value, name) {
  if (typeof value !== 'boolean') fail(`Invalid ${name}`);
}
function jsonValue(value, depth = 0, ancestors = new Set()) {
  if (depth > 8) fail('Message nesting is too deep');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Non-finite number');
    return value;
  }
  if (typeof value === 'string') {
    if (value.length > 2048) fail('String is too long');
    return value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) fail('Message must contain finite JSON values');
  const isArray = Array.isArray(value);
  if (!isArray && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('Invalid JSON object');
  if ((isArray ? value.length : Object.keys(value).length) > (isArray ? 256 : 64)) fail('Too many JSON members');
  ancestors.add(value);
  let result;
  if (isArray) {
    result = value.map(item => jsonValue(item, depth + 1, ancestors));
  } else {
    result = {};
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || key.length > 96) fail('Invalid JSON key');
      result[key] = jsonValue(item, depth + 1, ancestors);
    }
  }
  ancestors.delete(value);
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function configValue(value) {
  const config = jsonValue(value);
  if (!config || Array.isArray(config) || typeof config !== 'object') fail('Invalid room config');
  integer(config.age, 'config.age', 0, 255);
  if (typeof config.map === 'number') integer(config.map, 'config.map', 0, 65535);
  else if (typeof config.map !== 'string' || !/^[A-Za-z0-9_ -]{1,80}$/.test(config.map)) fail('Invalid config.map');
  const character = config.character;
  if (!character || typeof character !== 'object' || Array.isArray(character)) fail('Invalid config.character');
  integer(character.index, 'character.index', 0, 65535);
  integer(character.camp, 'character.camp', 0, 255);
  if (typeof character.model !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,47}\.chr$/i.test(character.model)) fail('Invalid character.model');
  if (typeof character.name !== 'string' || character.name.length < 1 || character.name.length > 96 || /[\u0000-\u001f\u007f]/.test(character.name)) fail('Invalid character.name');
  if (config.camp !== undefined) integer(config.camp, 'config.camp', 0, 255);
  if (config.settings === undefined) config.settings = {};
  if (!config.settings || typeof config.settings !== 'object' || Array.isArray(config.settings)) fail('Invalid config.settings');
  if (config.settings.build !== undefined &&
      (typeof config.settings.build !== 'string' || !/^[A-Za-z0-9_.-]{1,96}$/.test(config.settings.build))) fail('Invalid settings.build');
  // Leave ample room for handshake metadata inside the 64 KiB wire limit.
  if (Buffer.byteLength(JSON.stringify(config), 'utf8') > 16 * 1024) fail('Room config exceeds 16 KiB');
  return freeze(config);
}
function stateFields(message) {
  vector(message.pos, 'pos');
  finite(message.yaw, 'yaw', 1e6);
  finite(message.pitch, 'pitch', 1e6);
  integer(message.sector, 'sector', -1, 65535);
  integer(message.weapon, 'weapon', 0, 255);
  finite(message.hp, 'hp', 1e6);
  for (const key of ['stance', 'body', 'weaponAnim']) {
    if (message[key] !== undefined) integer(message[key], key, 0, 65535);
  }
  if (message.eyeHeight !== undefined) {
    finite(message.eyeHeight, 'eyeHeight', 2000);
    if (message.eyeHeight < 0) fail('Invalid eyeHeight');
  }
  if (message.paused !== undefined) boolean(message.paused, 'paused');
  if (message.viewFov !== undefined) {
    finite(message.viewFov, 'viewFov', 2.8);
    if (message.viewFov < 0.03) fail('Invalid viewFov');
  }
  if (message.shotSequence !== undefined) integer(message.shotSequence, 'shotSequence');
  if (message.shot !== undefined && message.shot !== null) {
    const shot = message.shot;
    if (typeof shot !== 'object' || Array.isArray(shot)) fail('Invalid shot');
    identifier(shot.id, 'shot.id');
    integer(shot.life, 'shot.life', 1);
    integer(shot.weapon, 'shot.weapon', 0, 255);
    vector(shot.origin, 'shot.origin');
    vector(shot.direction, 'shot.direction');
    integer(shot.sector, 'shot.sector', -1, 65535);
    integer(shot.renderSector, 'shot.renderSector', -1, 65535);
    finite(shot.yaw, 'shot.yaw', 1e6);
    finite(shot.pitch, 'shot.pitch', 1e6);
  }
}
export function validateLanMessage(value) {
  const message = jsonValue(value);
  if (!message || typeof message !== 'object' || Array.isArray(message) || !GAME_TYPES.has(message.type)) fail('Unsupported message type');
  if (message.version !== undefined && message.version !== LAN_PROTOCOL) fail('Unsupported message version');
  message.version = LAN_PROTOCOL;
  if (ACTOR_TYPES.has(message.type)) {
    integer(message.life, 'life', 1);
    integer(message.seq, 'seq');
  } else {
    if (message.life !== undefined) integer(message.life, 'life', 1);
    if (message.seq !== undefined) integer(message.seq, 'seq');
  }
  if (message.type === 'state' || message.type === 'respawn') stateFields(message);
  if (message.type === 'hit') {
    identifier(message.id, 'hit.id');
    integer(message.victimLife, 'victimLife', 1);
    integer(message.weapon, 'weapon', 0, 255);
    vector(message.direction, 'direction');
    if (message.kind === 'bullet') integer(message.region, 'region', 0, 14);
    else if (message.kind === 'pellets') integer(message.count, 'count', 1, 10);
    else fail('Invalid hit.kind');
    if (message.armorPierce !== undefined) integer(message.armorPierce, 'armorPierce', 0, 1);
  }
  if (message.type === 'death') {
    if (!['remote', 'self', 'environment'].includes(message.killer)) fail('Invalid killer');
    if (message.weapon !== undefined) integer(message.weapon, 'weapon', -1, 255);
  }
  if (message.type === 'pause') boolean(message.paused, 'paused');
  if (Buffer.byteLength(JSON.stringify(message), 'utf8') > LAN_MAX_LINE_BYTES) fail('Message exceeds 64 KiB');
  return message;
}

/**
 * Two-player LAN transport, TCP protocol1 with newline-delimited JSON.
 * onStatus receives {status, ...details}; onMessage receives validated gameplay.
 * send returns false before ready/after disconnect; invalid local data throws.
 * A new shot-bearing state bypasses coalescing so each observed shot is reliable.
 */
export async function createLanPeer({
  role, host = role === 'host' ? '0.0.0.0' : '127.0.0.1',
  port = LAN_DEFAULT_PORT, code, config, onMessage = () => {}, onStatus = () => {},
} = {}) {
  if (!['host', 'join'].includes(role)) fail('role must be host or join');
  if (typeof host !== 'string' || host.length < 1 || host.length > 253 || /[\s\u0000-\u001f]/.test(host)) fail('Invalid host address');
  integer(port, 'port', role === 'host' ? 0 : 1, 65535);
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('A six-digit connection code is required');
  if (typeof onMessage !== 'function' || typeof onStatus !== 'function') fail('Callbacks must be functions');
  const ownConfig = configValue(config);
  let effectiveConfig = ownConfig;
  let server = null, active = null, closed = false, connected = false, settled = false;
  let disconnectedReported = false;
  let pendingState = null, flushTimer = null, lastShotKey = null, listenPort = port;
  const candidates = new Set();
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  // Keep close-before-await and connection errors from causing unhandled rejection.
  ready.catch(() => {});
  function status(statusName, details = {}) {
    try { onStatus({status: statusName, role, ...details}); } catch {}
  }
  function rejectReadyOnce(error) {
    if (!settled) { settled = true; rejectReady(error); }
  }
  function disconnected(reason) {
    if (!disconnectedReported) {
      disconnectedReported = true;
      status('disconnected', {reason});
    }
  }
  function stopTimers() {
    if (flushTimer) clearInterval(flushTimer);
    flushTimer = null;
    pendingState = null;
  }
  function closeServer() {
    if (server?.listening) server.close();
  }
  function protocolError(session, errorCode, message) {
    if (session.finished) return;
    session.finished = true;
    session.error = Object.assign(new Error(message), {code: errorCode});
    status('error', {code: errorCode, message, recoverable: role === 'host' && session !== active});
    const line = JSON.stringify({type: 'error', version: LAN_PROTOCOL, code: errorCode, message}) + '\n';
    session.socket.end(line);
    const forcedClose = setTimeout(() => session.socket.destroy(), 100);
    forcedClose.unref();
  }
  function write(session, message) {
    if (!session || session.finished || session.socket.destroyed || !session.socket.writable) return false;
    if (session.socket.writableLength > MAX_WRITE_QUEUE_BYTES) {
      protocolError(session, 'SLOW_PEER', 'Peer is not reading messages');
      return false;
    }
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line, 'utf8') > LAN_MAX_LINE_BYTES) fail('Message exceeds 64 KiB');
    session.socket.write(line + '\n');
    return true;
  }
  function flushState(force = false) {
    if (!connected || !active || !pendingState) return;
    if (!force && active.socket.writableLength > MAX_WRITE_QUEUE_BYTES / 2) return;
    const state = pendingState;
    pendingState = null;
    write(active, state);
  }
  function connectionReady(session, hello) {
    if (closed || session.finished || connected) return;
    session.ready = true;
    clearTimeout(session.handshakeTimer);
    active = session;
    connected = true;
    flushTimer = setInterval(flushState, STATE_INTERVAL_MS);
    flushTimer.unref();
    if (!settled) { settled = true; resolveReady(freeze(hello)); }
    status('connected', {remoteAddress: session.socket.remoteAddress, remotePort: session.socket.remotePort, config: effectiveConfig});
  }
  function helloMessage() {
    return {type: 'hello', version: LAN_PROTOCOL, protocol: LAN_PROTOCOL, role, code, config: ownConfig};
  }
  function publicHello(message, validatedConfig) {
    return {type: 'hello', version: LAN_PROTOCOL, protocol: LAN_PROTOCOL, role: message.role, config: validatedConfig};
  }
  function remoteGameplay(session, message) {
    let validated;
    try { validated = validateLanMessage(message); }
    catch (error) { protocolError(session, 'BAD_MESSAGE', error.message); return; }
    try { onMessage(validated); }
    catch (error) { status('error', {code: 'CALLBACK_ERROR', message: error?.message || 'Message callback failed', recoverable: true}); }
    if (validated.type === 'leave') session.socket.end();
  }
  function receive(session, message) {
    if (session.finished || closed) return;
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      protocolError(session, 'BAD_MESSAGE', 'Expected a JSON object'); return;
    }
    if (message.type === 'error') {
      session.error = Object.assign(new Error(typeof message.message === 'string' ? message.message.slice(0, 256) : 'Peer rejected connection'), {code: typeof message.code === 'string' ? message.code.slice(0, 64) : 'PEER_ERROR'});
      status('error', {code: session.error.code, message: session.error.message, recoverable: false});
      session.finished = true;
      session.socket.destroy();
      return;
    }
    if (session.ready) {
      remoteGameplay(session, message);
      return;
    }
    if (!session.receivedHello) {
      if (message.type !== 'hello' || message.protocol !== LAN_PROTOCOL || message.version !== LAN_PROTOCOL || message.role !== (role === 'host' ? 'join' : 'host')) {
        protocolError(session, 'BAD_HELLO', 'Incompatible LAN handshake'); return;
      }
      if (message.code !== code) { protocolError(session, 'AUTH_FAILED', 'Connection code does not match'); return; }
      let remoteConfig;
      try { remoteConfig = configValue(message.config); }
      catch (error) { protocolError(session, 'BAD_CONFIG', error.message); return; }
      // Gameplay settings are adopted from the host, but an installed binary
      // build cannot be adopted over the wire. Check its original offered tag.
      if ((ownConfig.settings.build !== undefined || remoteConfig.settings.build !== undefined) &&
          ownConfig.settings.build !== remoteConfig.settings.build) {
        protocolError(session, 'BUILD_MISMATCH', 'Both players must use the same LAN build'); return;
      }
      session.receivedHello = true;
      if (role === 'host') {
        if (active && active !== session) { protocolError(session, 'ROOM_FULL', 'This room already has two players'); return; }
        active = session;
        // Room settings come from the host; remote identity remains the guest's.
        const guestConfig = freeze({...ownConfig, character: remoteConfig.character, ...(ownConfig.camp !== undefined ? {camp: remoteConfig.character.camp} : {})});
        session.remoteHello = publicHello(message, guestConfig);
        write(session, helloMessage());
        for (const other of candidates) {
          if (other !== session) protocolError(other, 'ROOM_FULL', 'This room already has two players');
        }
      } else {
        effectiveConfig = freeze({...remoteConfig, character: ownConfig.character, ...(remoteConfig.camp !== undefined ? {camp: ownConfig.character.camp} : {})});
        session.remoteHello = publicHello(message, remoteConfig);
        // The host resolves ready only after this acknowledgement proves both
        // sides have parsed and validated each other's hello.
        write(session, {type: 'ready', version: LAN_PROTOCOL, protocol: LAN_PROTOCOL});
        connectionReady(session, session.remoteHello);
      }
      return;
    }
    if (role === 'host' && message.type === 'ready' && message.version === LAN_PROTOCOL && message.protocol === LAN_PROTOCOL) {
      connectionReady(session, session.remoteHello);
    } else {
      protocolError(session, 'BAD_HANDSHAKE', 'Expected handshake acknowledgement');
    }
  }
  function acceptSocket(socket) {
    const session = {socket, buffer: Buffer.alloc(0), finished: false, ready: false, receivedHello: false, error: null, handshakeTimer: null};
    candidates.add(session);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10000);
    session.handshakeTimer = setTimeout(() => protocolError(session, 'HANDSHAKE_TIMEOUT', 'LAN handshake timed out'), HANDSHAKE_TIMEOUT_MS);
    session.handshakeTimer.unref();
    socket.on('data', chunk => {
      if (session.finished || closed) return;
      session.buffer = Buffer.concat([session.buffer, chunk]);
      while (!session.finished) {
        const newline = session.buffer.indexOf(10);
        if (newline < 0) {
          if (session.buffer.length > LAN_MAX_LINE_BYTES) protocolError(session, 'LINE_TOO_LONG', 'LAN line exceeds 64 KiB');
          break;
        }
        if (newline > LAN_MAX_LINE_BYTES) { protocolError(session, 'LINE_TOO_LONG', 'LAN line exceeds 64 KiB'); break; }
        const line = session.buffer.subarray(0, newline);
        session.buffer = session.buffer.subarray(newline + 1);
        let message;
        try { message = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(line)); }
        catch { protocolError(session, 'BAD_JSON', 'Invalid UTF-8 JSON line'); break; }
        receive(session, message);
      }
    });
    socket.on('error', error => {
      session.error = error;
      status('error', {code: error.code || 'SOCKET_ERROR', message: error.message, recoverable: role === 'host' && session !== active});
    });
    socket.on('close', () => {
      clearTimeout(session.handshakeTimer);
      candidates.delete(session);
      if (role === 'join' || session === active) {
        const wasConnected = connected;
        connected = false;
        closed = true;
        stopTimers();
        closeServer();
        for (const other of candidates) other.socket.destroy();
        rejectReadyOnce(session.error || new Error('LAN connection closed before handshake completed'));
        disconnected(session.error?.code || (wasConnected ? 'peer-closed' : 'handshake-closed'));
      }
    });
    return session;
  }
  const peer = {
    ready,
    get port() { return listenPort; },
    get connected() { return connected; },
    get effectiveConfig() { return effectiveConfig; },
    send(value) {
      const message = validateLanMessage(value);
      if (!connected || closed || !active) return false;
      if (message.type === 'state') {
        const shotKey = message.shot ? `${message.shot.life}:${typeof message.shot.id}:${message.shot.id}` :
          message.shotSequence > 0 ? `${message.life}:sequence:${message.shotSequence}` : null;
        if (shotKey !== null && shotKey !== lastShotKey) {
          pendingState = null;
          lastShotKey = shotKey;
          return write(active, message);
        }
        pendingState = message;
        return true;
      }
      flushState(true);
      return write(active, message);
    },
    close() {
      if (closed) return;
      closed = true;
      if (connected && active) {
        flushState(true);
        write(active, {type: 'leave', version: LAN_PROTOCOL, reason: 'local-close'});
      }
      connected = false;
      stopTimers();
      closeServer();
      rejectReadyOnce(new Error('LAN peer closed'));
      for (const session of candidates) {
        if (session === active && session.ready) {
          session.socket.end();
          const forcedClose = setTimeout(() => session.socket.destroy(), 250);
          forcedClose.unref();
        } else session.socket.destroy();
      }
      disconnected('local-close');
    },
  };
  if (role === 'host') {
    server = net.createServer(socket => {
      if (closed) { socket.destroy(); return; }
      const session = acceptSocket(socket);
      if (active || candidates.size > 4) protocolError(session, 'ROOM_FULL', 'This room already has two players');
    });
    server.on('error', error => {
      status('error', {code: error.code || 'SERVER_ERROR', message: error.message, recoverable: false});
      rejectReadyOnce(error);
    });
    await new Promise((resolve, reject) => {
      const failed = error => { server.off('listening', listening); reject(error); };
      const listening = () => { server.off('error', failed); resolve(); };
      server.once('error', failed);
      server.once('listening', listening);
      server.listen({host, port, exclusive: true});
    });
    listenPort = server.address().port;
    status('listening', {host, port: listenPort});
  } else {
    const socket = net.createConnection({host, port});
    const session = acceptSocket(socket);
    active = session;
    socket.once('connect', () => write(session, helloMessage()));
  }
  return peer;
}

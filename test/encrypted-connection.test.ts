/**
 * Basic tests for Encrypted Connection Handler
 * Note: Full encrypted connection tests require complex mocking of Noise protocol.
 * These tests focus on basic validation and initialization.
 */

import { EncryptedConnection } from '../src/connection/encrypted-connection';
import { NoiseEncryption } from '../src/connection/noise-encryption';
import { MessageType } from '../src/types';

// Mock Socket
jest.mock('net', () => ({
  Socket: jest.fn(() => ({
    connect: jest.fn(),
    write: jest.fn(),
    destroy: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
  })),
}));

// Mock NoiseEncryption
jest.mock('../src/connection/noise-encryption');

// Mock the WASM noise loader used inside performNoiseHandshake
jest.mock('@richardhopton/noise-c.wasm', () => {
  return (cb: any) => {
    const handshake = {
      Initialize: jest.fn(),
      WriteMessage: jest.fn(() => new Uint8Array([1, 2])),
      ReadMessage: jest.fn(),
      Split: jest.fn(() => [{ EncryptWithAd: jest.fn() }, { DecryptWithAd: jest.fn() }]),
    };
    cb({ HandshakeState: jest.fn(() => handshake), constants: { NOISE_ROLE_INITIATOR: 0 } });
  };
});

describe('EncryptedConnection', () => {
  const defaultOptions = {
    host: 'test.local',
    port: 6053,
    password: 'testpass',
    encryptionKey: Buffer.from('a'.repeat(32)).toString('base64'),
  };

  afterEach(() => {
    jest.clearAllTimers();
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with encryption key', () => {
      const connection = new EncryptedConnection(defaultOptions);

      expect(NoiseEncryption).toHaveBeenCalledWith(defaultOptions.encryptionKey);
      expect(connection.isConnected()).toBe(false);
      expect(connection.isAuthenticated()).toBe(false);

      connection.destroy();
    });

    it('should accept custom options', () => {
      const options = {
        host: 'custom.local',
        port: 8080,
        password: 'custom',
        encryptionKey: Buffer.from('b'.repeat(32)).toString('base64'),
        reconnect: false,
        pingInterval: 30000,
      };

      const connection = new EncryptedConnection(options);
      expect(connection.getState().connected).toBe(false);
      connection.destroy();
    });

    it('should use default port if not specified', () => {
      const connection = new EncryptedConnection({
        host: 'test.local',
        encryptionKey: defaultOptions.encryptionKey,
      });

      expect(connection).toBeDefined();
      connection.destroy();
    });
  });

  describe('handshake and receive decryption', () => {
    it('should reject on handshake timeout', async () => {
      jest.useFakeTimers();
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey });

      const handlers: Record<string, (data: Buffer) => void> = {};
      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          handlers[evt] = cb;
        }),
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      // Advance to trigger handshake timeout (5s)
      jest.advanceTimersByTime(5001);
      await expect(p).rejects.toThrow('Handshake timeout');
      jest.useRealTimers();
    });

    it('should reject on wrong frame type during handshake', async () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey });

      let dataHandler: ((b: Buffer) => void) | undefined;
      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          if (evt === 'data') dataHandler = cb;
        }),
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      expect((conn as any).socket.write).toHaveBeenCalled();
      // Emit a frame with wrong type 0x02
      const bad = Buffer.from([0x02, 0x00, 0x01, 0xaa]);
      dataHandler!(bad);
      await expect(p).rejects.toThrow('Expected frame type 0x01');
    });

    it('should reject when server selects unknown protocol', async () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey });

      let dataHandler: ((b: Buffer) => void) | undefined;
      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          if (evt === 'data') dataHandler = cb;
        }),
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      // Frame type 0x01, length 1, payload chosenProto=2
      const hello = Buffer.from([0x01, 0x00, 0x01, 0x02]);
      dataHandler!(hello);
      await expect(p).rejects.toThrow('Unknown protocol selected by server');
    });

    it('should reject when expected server name mismatches', async () => {
      const conn = new EncryptedConnection({
        host: 'h',
        encryptionKey: defaultOptions.encryptionKey,
        expectedServerName: 'mydev',
      });

      let dataHandler: ((b: Buffer) => void) | undefined;
      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          if (evt === 'data') dataHandler = cb;
        }),
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      // chosenProto=1, server name 'other' + NUL
      const payload = Buffer.concat([Buffer.from([1]), Buffer.from('other\0')]);
      const hello = Buffer.concat([Buffer.from([0x01, 0x00, payload.length]), payload]);
      dataHandler!(hello);
      await expect(p).rejects.toThrow('Server name mismatch');
    });

    it('should reject when decrypting an encrypted frame fails', async () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey });

      // Force decrypt branch before handshake logic
      (conn as any).encryptionEstablished = true;
      (conn as any).decryptor = { DecryptWithAd: jest.fn(() => { throw new Error('bad'); }) };

      let dataHandler: ((b: Buffer) => void) | undefined;
      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          if (evt === 'data') dataHandler = cb;
        }),
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      // Send an encrypted frame (type=0x01, length=4 with dummy bytes)
      const enc = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const frame = Buffer.concat([Buffer.from([0x01, 0x00, enc.length]), enc]);
      dataHandler!(frame);
      await expect(p).rejects.toThrow('bad');
    });

    it('should complete handshake and emit encryptionEstablished, then emit decrypted message', async () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey });

      let dataHandler: ((b: Buffer) => void) | undefined;
      const writes: Buffer[] = [];
      const onEnc = jest.fn();
      conn.on('encryptionEstablished', onEnc);

      (conn as any).socket = {
        on: jest.fn((evt: string, cb: any) => {
          if (evt === 'data') dataHandler = cb;
        }),
        write: (b: Buffer) => { writes.push(b); return true; },
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
        off: jest.fn(),
      } as any;

      const p = (conn as any).performNoiseHandshake();
      // Step 0: server hello, chosenProto=1
      const helloPayload = Buffer.from([1]);
      const hello = Buffer.concat([Buffer.from([0x01, 0x00, helloPayload.length]), helloPayload]);
      dataHandler!(hello);
      // Should have written handshake message frame
      expect(writes.length).toBeGreaterThan(0);

      // Step 1: handshake response header=0 + message [3,4]
      const hsRespPayload = Buffer.from([0, 3, 4]);
      const hsResp = Buffer.concat([Buffer.from([0x01, 0x00, hsRespPayload.length]), hsRespPayload]);
      dataHandler!(hsResp);

      await expect(p).resolves.toBeUndefined();
      expect(onEnc).toHaveBeenCalled();
      expect((conn as any).encryptionEstablished).toBe(true);

      // Now feed an encrypted data frame which decrypts to a valid message
      const onMsg = jest.fn();
      conn.on('message', onMsg);
      const msgType = MessageType.SubscribeLogsResponse;
      const payload = Buffer.from([9, 8]);
      const plaintext = Buffer.concat([
        Buffer.from([(msgType >> 8) & 0xff, msgType & 0xff]),
        Buffer.from([0x00, payload.length]),
        payload,
      ]);

      // Replace decryptor to return our plaintext
      (conn as any).decryptor = { DecryptWithAd: jest.fn(() => new Uint8Array(plaintext)) };

      const encFrameData = Buffer.from([0xaa, 0xbb, 0xcc, 0xdd]);
      const encFrame = Buffer.concat([Buffer.from([0x01, 0x00, encFrameData.length]), encFrameData]);
      dataHandler!(encFrame);

      expect(onMsg).toHaveBeenCalledWith({ type: msgType, data: payload });
    });
  });

  describe('reconnect and ping timers', () => {
    it('should schedule reconnect and call connect', async () => {
      jest.useFakeTimers();
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey, reconnectInterval: 10 });
      (conn as any).connect = jest.fn().mockResolvedValue(undefined);

      (conn as any).scheduleReconnect();
      jest.advanceTimersByTime(11);

      expect((conn as any).connect).toHaveBeenCalledTimes(1);
      jest.useRealTimers();
    });

    it('handleDisconnect triggers scheduleReconnect when enabled', () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey, reconnect: true });
      (conn as any).state = { connected: true, authenticated: false };
      const spy = jest.spyOn(conn as any, 'scheduleReconnect');

      (conn as any).handleDisconnect();
      expect(spy).toHaveBeenCalled();
    });

    it('should send ping on interval and disconnect on timeout when no pong', () => {
      jest.useFakeTimers();
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey, pingInterval: 10, pingTimeout: 20 });
      (conn as any).state = { connected: true, authenticated: false };
      (conn as any).encryptor = { EncryptWithAd: jest.fn(() => Buffer.from([1])) };
      (conn as any).encryptionEstablished = true;

      const writes: Buffer[] = [];
      (conn as any).socket = {
        write: (b: Buffer) => { writes.push(b); return true; },
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
      } as any;

      // Send a ping manually and then start the timeout
      conn.sendMessage(MessageType.PingRequest, Buffer.alloc(0));
      expect((conn as any).encryptor.EncryptWithAd).toHaveBeenCalled();
      expect(writes.length).toBe(1);

      // Start the ping-timeout timer explicitly
      (conn as any).startPingTimeoutTimer();
      jest.advanceTimersByTime(21); // ping timeout triggers disconnect
      // Verify state changed to disconnected
      expect(conn.getState().connected).toBe(false);
      jest.useRealTimers();
      conn.destroy();
    });
  });

  describe('encrypted send and deep sleep', () => {
    const encryptionKey = Buffer.from('a'.repeat(32)).toString('base64');

    it('should send encrypted data frames with proper header and length', () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey });

      // Pretend we are connected
      (conn as any).state = { connected: true, authenticated: false };

      // Stub socket with write spy
      const writes: Buffer[] = [];
      (conn as any).socket = {
        write: (buf: Buffer) => {
          writes.push(buf);
          return true;
        },
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
      } as any;

      // Mock encryptor and set encryption established
      const ciphertext = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const encryptor = { EncryptWithAd: jest.fn(() => ciphertext) };
      (conn as any).encryptor = encryptor;
      (conn as any).encryptionEstablished = true;

      const data = Buffer.from([1, 2, 3]);
      conn.sendMessage(MessageType.SwitchCommandRequest, data);

      expect(encryptor.EncryptWithAd).toHaveBeenCalledTimes(1);
      expect(writes.length).toBe(1);
      expect(writes[0]).toBeDefined();
      const frame = writes[0]!;
      expect(frame[0]).toBe(0x01); // FRAME_TYPE
      const len = frame.readUInt16BE(1);
      expect(len).toBe(ciphertext.length);
      expect(frame.slice(3)).toEqual(ciphertext);

      conn.destroy();
    });

    it('should handle deep sleep disconnect and disable reconnect', () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey, reconnect: true });
      // connected state required for sendMessage during disconnect handling
      (conn as any).state = { connected: true, authenticated: false };

      // Socket stub so sendMessage doesn't throw
      (conn as any).socket = {
        write: jest.fn(),
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
      } as any;

      conn.setDeepSleepMode(true);

      const onDisconnect = jest.fn();
      conn.on('disconnect', onDisconnect);

      // Invoke the handler directly
      (conn as any).handleDisconnectRequest();

      expect(onDisconnect).toHaveBeenCalled();
      // Reconnect should be disabled for deep sleep
      expect((conn as any).options.reconnect).toBe(false);
      expect(conn.getState().connected).toBe(false);

      conn.destroy();
    });

    it('should send unencrypted when encryption not established', () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey });
      (conn as any).state = { connected: true, authenticated: false };
      // Ensure no encryptor/established
      (conn as any).encryptor = undefined;
      (conn as any).encryptionEstablished = false;

      const writes: Buffer[] = [];
      (conn as any).socket = {
        write: (buf: Buffer) => { writes.push(buf); return true; },
        removeAllListeners: jest.fn(),
        destroy: jest.fn(),
      } as any;

      conn.sendMessage(MessageType.PingRequest, Buffer.alloc(0));
      expect(writes.length).toBe(1);

      conn.destroy();
    });
  });

  describe('disconnect handling nuances', () => {
    it('should not emit disconnect event when never connected', () => {
      const conn = new EncryptedConnection({ host: 'h', encryptionKey: defaultOptions.encryptionKey, reconnect: false });
      const onDisc = jest.fn();
      conn.on('disconnect', onDisc);
      (conn as any).handleDisconnect();
      expect(onDisc).not.toHaveBeenCalled();
      conn.destroy();
    });
  });

  describe('state management', () => {
    it('should set authenticated state', () => {
      const connection = new EncryptedConnection(defaultOptions);

      connection.setAuthenticated(true);

      expect(connection.isAuthenticated()).toBe(true);
      expect(connection.getState().authenticated).toBe(true);

      connection.destroy();
    });

    it('should set API version', () => {
      const connection = new EncryptedConnection(defaultOptions);

      connection.setApiVersion(1, 9);

      const state = connection.getState();
      expect(state.apiVersion).toEqual({ major: 1, minor: 9 });

      connection.destroy();
    });

    it('should set server info', () => {
      const connection = new EncryptedConnection(defaultOptions);

      connection.setServerInfo('ESPHome v2023.10.0');

      const state = connection.getState();
      expect(state.serverInfo).toBe('ESPHome v2023.10.0');

      connection.destroy();
    });
  });

  describe('disconnect', () => {
    it('should handle disconnect when not connected', () => {
      const connection = new EncryptedConnection(defaultOptions);

      expect(() => connection.disconnect()).not.toThrow();

      connection.destroy();
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      const connection = new EncryptedConnection(defaultOptions);

      expect(() => connection.destroy()).not.toThrow();
      expect(connection.isConnected()).toBe(false);
    });

    it('should throw if trying to connect after destroy', async () => {
      const connection = new EncryptedConnection(defaultOptions);
      connection.destroy();

      await expect(connection.connect()).rejects.toThrow('Connection has been destroyed');
    });
  });
});

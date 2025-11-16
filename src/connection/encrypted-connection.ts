/**
 * Encrypted Connection Handler for ESPHome Native API
 * Based on the official Python aioesphomeapi implementation
 * Uses Noise Protocol Framework (Noise_NNpsk0_25519_ChaChaPoly_SHA256)
 */

import { Socket } from 'net';
import { EventEmitter } from 'eventemitter3';
import pRetry from 'p-retry';
import createDebug from 'debug';
import { ProtocolHandler, DecodedMessage } from '../utils/protocol';
import { NoiseEncryption } from './noise-encryption';
import { ConnectionError, ProtocolError, MessageType, ConnectionOptions } from '../types';

const debug = createDebug('esphome:encrypted-connection');

// Frame types for encrypted communication
// ESPHome uses frame type 0x01 for ALL encrypted frames (both handshake and data)
const FRAME_TYPE = 0x01;

export interface ConnectionState {
  connected: boolean;
  authenticated: boolean;
  apiVersion?: { major: number; minor: number };
  serverInfo?: string;
}

export interface EncryptedConnectionEvents {
  connect: () => void;
  disconnect: (error?: Error) => void;
  message: (message: DecodedMessage) => void;
  error: (error: Error) => void;
  stateChange: (state: ConnectionState) => void;
  encryptionEstablished: () => void;
}

export class EncryptedConnection extends EventEmitter<EncryptedConnectionEvents> {
  private socket: Socket | null = null;
  private protocol: ProtocolHandler;
  private noise?: NoiseEncryption;
  private encryptor?: any;
  private decryptor?: any;
  private state: ConnectionState = {
    connected: false,
    authenticated: false,
  };
  private options: Required<Omit<ConnectionOptions, 'logger' | 'timerFactory'>> & {
    logger?: ConnectionOptions['logger'];
    timerFactory?: ConnectionOptions['timerFactory'];
  };
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private pingTimeoutTimer?: NodeJS.Timeout;
  private isReconnecting = false;
  private isDestroyed = false;
  private encryptionBuffer = Buffer.alloc(0);
  private encryptionEstablished = false;
  private expectedDisconnect = false;
  private hasDeepSleep = false;

  constructor(options: ConnectionOptions) {
    super();
    this.options = {
      host: options.host,
      port: options.port || 6053,
      password: options.password || '',
      clientInfo: options.clientInfo || 'ESPHome TypeScript Client',
      reconnect: options.reconnect !== false,
      reconnectInterval: options.reconnectInterval || 5000,
      pingInterval: options.pingInterval || 20000,
      pingTimeout: options.pingTimeout || 90000,  // Match Python's 4.5x ratio (90s) - CRITICAL FIX
      connectTimeout: options.connectTimeout || 10000,
      encryptionKey: options.encryptionKey || '',
      expectedServerName: options.expectedServerName || '',
      respondToTimeRequests: options.respondToTimeRequests !== false, // Default to true
      logger: options.logger,
      timerFactory: options.timerFactory,
    };

    this.protocol = new ProtocolHandler();

    // Initialize noise encryption if key is provided
    if (this.options.encryptionKey) {
      this.noise = new NoiseEncryption(this.options.encryptionKey);
      debug(
        'Encryption will be initialized for connection to %s:%d',
        this.options.host,
        this.options.port,
      );
    }

    debug('Encrypted connection initialized for %s:%d', this.options.host, this.options.port);
  }

  /**
   * Connect to the ESPHome device
   */
  async connect(): Promise<void> {
    if (this.isDestroyed) {
      throw new ConnectionError('Connection has been destroyed');
    }

    if (this.state.connected) {
      debug('Already connected');
      return;
    }

    // Initialize noise encryption if needed (WebAssembly loading)
    if (this.noise && !this.noise.isInitialized) {
      debug('Initializing noise encryption WebAssembly');
      await this.noise.initialize();
      debug('Noise encryption initialized');
    }

    debug('Connecting to %s:%d', this.options.host, this.options.port);

    try {
      await pRetry(
        async () => {
          await this.establishConnection();
        },
        {
          retries: this.options.reconnect ? 3 : 0,
          minTimeout: 1000,
          maxTimeout: 5000,
          onFailedAttempt: (context) => {
            debug('Connection attempt %d failed: %s', context.attemptNumber, context.error.message);
          },
        },
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      debug('Failed to connect: %s', err.message);
      throw new ConnectionError(`Failed to connect: ${err.message}`);
    }
  }

  /**
   * Establish the actual TCP connection
   */
  private async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.cleanup();

      const socket = new Socket();
      const connectTimeout = setTimeout(() => {
        socket.destroy();
        reject(new ConnectionError('Connection timeout'));
      }, this.options.connectTimeout);
      connectTimeout.unref();

      socket.once('connect', async () => {
        clearTimeout(connectTimeout);
        debug('TCP connection established');
        this.socket = socket;
        this.setupSocketHandlers();
        this.updateState({ connected: true, authenticated: false });

        // Perform noise handshake if encryption is enabled
        if (this.noise) {
          try {
            await this.performNoiseHandshake();
            this.encryptionEstablished = true;
            this.emit('encryptionEstablished');
            debug('Encryption established');
          } catch (error) {
            debug('Noise handshake failed: %s', error);
            socket.destroy();
            reject(new ConnectionError(`Encryption handshake failed: ${error}`));
            return;
          }
        }

        this.emit('connect');
        this.startPingTimer();
        resolve();
      });

      socket.once('error', (error) => {
        clearTimeout(connectTimeout);
        debug('Socket error: %s', error.message);
        reject(new ConnectionError(`Socket error: ${error.message}`));
      });

      socket.connect(this.options.port, this.options.host);
    });
  }

  /**
   * Perform the noise protocol handshake based on ESPHome protocol spec
   * Protocol: Noise_NNpsk0_25519_ChaChaPoly_SHA256
   * Reference: https://developers.esphome.io/architecture/api/protocol_details/
   */
  private async performNoiseHandshake(): Promise<void> {
    if (!this.socket) {
      throw new Error('Socket not connected');
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const createNoise = require('@richardhopton/noise-c.wasm');
    const encryptionKey = Buffer.from(this.options.encryptionKey, 'base64');
    const socket = this.socket;

    return new Promise((resolve, reject) => {
      createNoise((noise: any) => {
        debug('Noise library loaded for handshake');

        let client: any;
        let encryptor: any;
        let decryptor: any;

        try {
          client = noise.HandshakeState(
            'Noise_NNpsk0_25519_ChaChaPoly_SHA256',
            noise.constants.NOISE_ROLE_INITIATOR,
          );
          client.Initialize(
            new Uint8Array(Buffer.from('NoiseAPIInit\x00\x00')),
            null,
            null,
            new Uint8Array(encryptionKey),
          );
          debug('Handshake state initialized');
        } catch (error) {
          reject(new Error('Failed to initialize handshake: ' + error));
          return;
        }

        const timeout = setTimeout(() => {
          reject(new Error('Handshake timeout'));
        }, 5000);
        timeout.unref();

        let handshakeStep = 0; // 0 = waiting for server hello, 1 = waiting for handshake response

        const handleHandshakeData = async (data: Buffer) => {
          debug(
            'Handshake data received, length=%d, step=%d',
            data.length,
            handshakeStep,
          );

          try {
            this.encryptionBuffer = Buffer.concat([this.encryptionBuffer, data]);

            while (this.encryptionBuffer.length >= 3) {
              const frameType = this.encryptionBuffer[0] as number;
              const frameLength = this.encryptionBuffer.readUInt16BE(1);

              if (this.encryptionBuffer.length < 3 + frameLength) {
                return; // Not enough data yet
              }

              if (frameType !== FRAME_TYPE) {
                throw new Error(`Expected frame type 0x01, got 0x${frameType.toString(16)}`);
              }

              const frameData = this.encryptionBuffer.slice(3, 3 + frameLength);
              this.encryptionBuffer = this.encryptionBuffer.slice(3 + frameLength);

              // Handle encrypted messages after handshake is complete
              if (this.encryptionEstablished && this.decryptor) {
                debug('Received encrypted frame, length=%d', frameData.length);

                try {
                  const decryptedData = Buffer.from(
                    this.decryptor.DecryptWithAd([], new Uint8Array(frameData)),
                  );
                  debug('Decrypted data, length=%d', decryptedData.length);

                  if (decryptedData.length < 4) {
                    debug('Decrypted data too short');
                    return;
                  }

                  // Message format: [2 bytes type][2 bytes length][protobuf data]
                  const messageType = decryptedData.readUInt16BE(0);
                  const messageLength = decryptedData.readUInt16BE(2);
                  const messageData = decryptedData.slice(4, 4 + messageLength);

                  debug('Received encrypted message type %d, length %d', messageType, messageLength);

                  const message: DecodedMessage = {
                    type: messageType,
                    data: messageData,
                  };

                  this.handleMessage(message);
                } catch (decryptError) {
                  debug('Failed to decrypt message: %s', decryptError);
                  throw decryptError;
                }
              } else if (handshakeStep === 0) {
                // Process server hello
                debug('Received server hello, length=%d', frameData.length);

                const chosenProto = frameData[0];
                if (chosenProto !== 1) {
                  throw new Error(`Unknown protocol selected by server: ${chosenProto}`);
                }

                // Check server name if expected
                if (this.options.expectedServerName) {
                  const nullIndex = frameData.indexOf(0, 1);
                  if (nullIndex > 1) {
                    const serverName = frameData.slice(1, nullIndex).toString();
                    if (serverName !== this.options.expectedServerName) {
                      throw new Error(
                        `Server name mismatch: expected ${this.options.expectedServerName}, got ${serverName}`,
                      );
                    }
                  }
                }

                // Send handshake message
                const handshakeMsg = client.WriteMessage();
                const msgWithHeader = Buffer.concat([Buffer.from([0]), Buffer.from(handshakeMsg)]);
                const frame = this.createHandshakeFrame(msgWithHeader);
                socket.write(frame);
                debug('Sent handshake message, length=%d', msgWithHeader.length);
                handshakeStep = 1;
              } else if (handshakeStep === 1) {
                // Process handshake response
                debug('Received handshake response, length=%d', frameData.length);

                const header = frameData[0];
                const message = frameData.slice(1);

                if (header !== 0) {
                  throw new Error(`Handshake failure: ${message.toString()}`);
                }

                // Complete handshake
                client.ReadMessage(new Uint8Array(message), true);

                // Split into send and receive ciphers
                [encryptor, decryptor] = client.Split();

                this.encryptor = encryptor;
                this.decryptor = decryptor;
                this.encryptionEstablished = true;

                clearTimeout(timeout);

                debug('Encryption established successfully');
                this.emit('encryptionEstablished');
                resolve();
              }
            }
          } catch (error) {
            clearTimeout(timeout);
            if (this.socket) {
              this.socket.off('data', handleHandshakeData);
            }
            reject(error);
          }
        };

        if (socket) {
          socket.on('data', handleHandshakeData);
          debug('Socket data handler attached');

          // Send initial hello (empty frame)
          const helloFrame = this.createHandshakeFrame(Buffer.alloc(0));
          socket.write(helloFrame);
          debug('Sent hello frame');

          socket.on('error', (err) => {
            debug('Socket error during handshake: %s', err.message);
          });
        }
      });
    });
  }

  /**
   * Create a handshake frame
   */
  private createHandshakeFrame(data: Buffer): Buffer {
    const frame = Buffer.alloc(3 + data.length);
    frame[0] = FRAME_TYPE;
    frame.writeUInt16BE(data.length, 1);
    data.copy(frame, 3);
    return frame;
  }

  /**
   * Create an encrypted data frame
   */
  private createDataFrame(data: Buffer): Buffer {
    const frame = Buffer.alloc(3 + data.length);
    frame[0] = FRAME_TYPE;
    frame.writeUInt16BE(data.length, 1);
    data.copy(frame, 3);
    return frame;
  }

  /**
   * Setup socket event handlers
   */
  private setupSocketHandlers(): void {
    if (!this.socket || this.noise) return;

    this.socket.on('data', (data: Buffer) => {
      try {
        const messages = this.protocol.addData(data);
        for (const message of messages) {
          debug('Received message type %d', message.type);
          this.handleMessage(message);
        }
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        debug('Protocol error: %s', err.message);
        this.emit('error', new ProtocolError(err.message));
        this.disconnect();
      }
    });

    this.socket.on('error', (error: Error) => {
      debug('Socket error: %s', error.message);
      this.emit('error', error);
    });

    this.socket.on('close', () => {
      debug('Socket closed');
      this.handleDisconnect();
    });

    this.socket.on('end', () => {
      debug('Socket ended');
      this.handleDisconnect();
    });
  }

  /**
   * Handle incoming messages
   */
  private handleMessage(message: DecodedMessage): void {
    // Handle ping/pong
    if (message.type === MessageType.PingRequest) {
      this.sendMessage(MessageType.PingResponse, Buffer.alloc(0));
      return;
    }

    if (message.type === MessageType.PingResponse) {
      this.handlePongResponse();
      return;
    }

    // Handle disconnect request (device going to sleep)
    if (message.type === MessageType.DisconnectRequest) {
      this.handleDisconnectRequest();
      return;
    }

    // Emit message for higher-level handling
    this.emit('message', message);
  }

  /**
   * Handle disconnect request from device (deep sleep)
   */
  private handleDisconnectRequest(): void {
    debug('Received DisconnectRequest - device going to sleep');

    try {
      this.sendMessage(MessageType.DisconnectResponse, Buffer.alloc(0));
      debug('Sent DisconnectResponse');
    } catch (error) {
      debug('Failed to send DisconnectResponse: %s', error);
    }

    this.expectedDisconnect = true;
    this.stopPingTimer();
    this.stopPingTimeoutTimer();

    if (this.hasDeepSleep) {
      debug('Deep sleep device - disabling auto-reconnect');
      this.options.reconnect = false;
    }

    this.disconnect();
  }

  disconnect(): void {
    debug('Disconnecting');
    this.cleanup();
    this.updateState({ connected: false, authenticated: false });
    this.emit('disconnect');
  }

  /**
   * Send a message to the device
   */
  sendMessage(type: number, data: Buffer): void {
    if (!this.socket || !this.state.connected) {
      throw new ConnectionError('Not connected');
    }

    if (this.encryptor && this.encryptionEstablished) {
      // Encrypted message format: [2 bytes type][2 bytes length][protobuf data]
      const messageType = Buffer.allocUnsafe(2);
      messageType.writeUInt16BE(type, 0);

      const messageLength = Buffer.allocUnsafe(2);
      messageLength.writeUInt16BE(data.length, 0);

      const plaintext = Buffer.concat([messageType, messageLength, data]);

      // Encrypt the plaintext
      const encryptedFrame = Buffer.from(this.encryptor.EncryptWithAd([], new Uint8Array(plaintext)));
      const dataFrame = this.createDataFrame(encryptedFrame);

      this.socket.write(dataFrame);
      debug(
        'Sent encrypted message type %d, plaintext %d bytes, encrypted %d bytes',
        type,
        data.length,
        encryptedFrame.length,
      );
    } else {
      // Send unencrypted using standard protocol format
      const frame = this.protocol.encodeMessage(type, data);
      this.socket.write(frame);
      debug('Sent message type %d, %d bytes', type, data.length);
    }
  }

  getState(): ConnectionState {
    return { ...this.state };
  }

  isConnected(): boolean {
    return this.state.connected;
  }

  isAuthenticated(): boolean {
    return this.state.authenticated;
  }

  isEncrypted(): boolean {
    return !!this.options.encryptionKey;
  }

  setAuthenticated(authenticated: boolean): void {
    this.updateState({ authenticated });
  }

  setApiVersion(major: number, minor: number): void {
    this.updateState({ apiVersion: { major, minor } });
  }

  setServerInfo(info: string): void {
    this.updateState({ serverInfo: info });
  }

  destroy(): void {
    debug('Destroying connection');
    this.isDestroyed = true;
    this.cleanup();
    this.removeAllListeners();
  }

  /**
   * Handle disconnection and potential reconnection
   */
  private handleDisconnect(): void {
    const wasConnected = this.state.connected;

    this.cleanup();
    this.updateState({ connected: false, authenticated: false });
    this.encryptionEstablished = false;

    if (wasConnected) {
      this.emit('disconnect');
    }

    if (this.options.reconnect && !this.isDestroyed && !this.isReconnecting) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.isReconnecting || this.isDestroyed) return;

    debug('Scheduling reconnect in %dms', this.options.reconnectInterval);
    this.isReconnecting = true;

    this.reconnectTimer = setTimeout(async () => {
      if (this.isDestroyed) return;

      debug('Attempting to reconnect');
      try {
        await this.connect();
        this.isReconnecting = false;
      } catch (error) {
        debug('Reconnection failed: %s', error);
        this.isReconnecting = false;
        this.scheduleReconnect();
      }
    }, this.options.reconnectInterval);
  }

  /**
   * Enable deep sleep mode for this connection
   */
  setDeepSleepMode(enabled: boolean): void {
    this.hasDeepSleep = enabled;
    debug('Deep sleep mode %s', enabled ? 'enabled' : 'disabled');

    if (enabled && this.state.connected) {
      this.stopPingTimer();
      debug('Stopped ping timer for deep sleep device');
    }
  }

  /**
   * Check if this is an expected disconnect
   */
  isExpectedDisconnect(): boolean {
    return this.expectedDisconnect;
  }

  /**
   * Start the ping timer
   */
  private startPingTimer(): void {
    if (this.hasDeepSleep) {
      debug('Deep sleep device - ping disabled');
      return;
    }

    this.stopPingTimer();

    this.pingTimer = setInterval(() => {
      if (!this.state.connected) {
        this.stopPingTimer();
        return;
      }

      debug('Sending ping');
      try {
        this.sendMessage(MessageType.PingRequest, Buffer.alloc(0));
        this.startPingTimeoutTimer();
      } catch (error) {
        debug('Failed to send ping: %s', error);
        this.handleDisconnect();
      }
    }, this.options.pingInterval);
  }

  /**
   * Start the ping timeout timer
   */
  private startPingTimeoutTimer(): void {
    this.stopPingTimeoutTimer();

    this.pingTimeoutTimer = setTimeout(() => {
      debug('Ping timeout');
      this.handleDisconnect();
    }, this.options.pingTimeout);

    this.pingTimeoutTimer.unref();
  }

  /**
   * Handle pong response
   */
  private handlePongResponse(): void {
    debug('Received pong');
    this.stopPingTimeoutTimer();
  }

  /**
   * Stop the ping timer
   */
  private stopPingTimer(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    this.stopPingTimeoutTimer();
  }

  /**
   * Stop the ping timeout timer
   */
  private stopPingTimeoutTimer(): void {
    if (this.pingTimeoutTimer) {
      clearTimeout(this.pingTimeoutTimer);
      this.pingTimeoutTimer = undefined;
    }
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.stopPingTimer();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }

    this.protocol.clearBuffer();
    this.encryptionBuffer = Buffer.alloc(0);

    if (this.noise) {
      this.noise.reset();
    }
  }

  private updateState(newState: Partial<ConnectionState>): void {
    const oldState = { ...this.state };
    this.state = { ...this.state, ...newState };
    if (JSON.stringify(oldState) !== JSON.stringify(this.state)) {
      this.emit('stateChange', this.state);
    }
  }
}

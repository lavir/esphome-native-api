/**
 * Tests for Connection health metrics and status
 */

import { Socket } from 'net';
import { EventEmitter } from 'events';
import { Connection } from '../src/connection/connection';
import { MessageType } from '../src/types';
import { ProtocolHandler } from '../src/utils/protocol';

// Mock Socket
class MockSocket extends EventEmitter {
  public destroyed = false;
  public connected = false;

  connect(_port: number, _host: string): void {
    this.connected = true;
    process.nextTick(() => this.emit('connect'));
  }

  write(_data: Buffer): boolean {
    return true;
  }

  destroy(): void {
    this.destroyed = true;
    this.connected = false;
    process.nextTick(() => this.emit('close'));
  }

  end(): void {
    this.connected = false;
    process.nextTick(() => this.emit('end'));
  }
}

// Mock net module
jest.mock('net', () => ({
  Socket: jest.fn(() => new MockSocket()),
}));

describe('Connection Health', () => {
  let connection: Connection;
  const defaultOptions = {
    host: 'test.local',
    port: 6053,
    password: 'testpass',
    pingInterval: 50,
    pingTimeout: 200,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    connection = new Connection(defaultOptions);
  });

  afterEach(() => {
    connection.destroy();
    jest.clearAllTimers();
  });

  it('should collect metrics and report health status', async () => {
    await connection.connect();

    // Allow a ping cycle to occur
    await new Promise((r) => setTimeout(r, 60));

    // Simulate receiving a PingResponse to record latency
    const mockSocket = (Socket as any).mock.results[0].value as MockSocket;
    const proto = new ProtocolHandler();
    const pong = proto.encodeMessage(MessageType.PingResponse, Buffer.alloc(0));
    mockSocket.emit('data', pong);

    const metrics = connection.getHealthMetrics();
    expect(metrics.isConnected).toBe(true);
    expect(metrics.messagesSent).toBeGreaterThanOrEqual(1); // ping sent
    expect(metrics.averagePingLatency === undefined || metrics.averagePingLatency >= 0).toBe(true);

    const health = connection.getConnectionHealth();
    expect(['healthy', 'degraded', 'unhealthy', 'disconnected']).toContain(health.status);
    expect(Array.isArray(health.issues)).toBe(true);
  });

  it('should reset health metrics', async () => {
    await connection.connect();

    // Trigger some activity
    await new Promise((r) => setTimeout(r, 60));

    let metrics = connection.getHealthMetrics();
    expect(metrics.messagesSent).toBeGreaterThanOrEqual(0);

    connection.resetHealthMetrics();
    metrics = connection.getHealthMetrics();
    expect(metrics.messagesSent).toBe(0);
    expect(metrics.bytesSent).toBe(0);
    expect(metrics.bytesReceived).toBe(0);
  });
});

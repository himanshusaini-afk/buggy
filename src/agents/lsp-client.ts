/**
 * LSP Client - Manages LSP server lifecycle and communication.
 *
 * Spawns an LSP server as a child process and communicates via JSON-RPC
 * over stdio. Implements the LSP initialization handshake and provides
 * methods for resolving symbol definitions and type information.
 *
 * All requests enforce a 5-second timeout using Promise.race.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

/**
 * Configuration for spawning an LSP server process.
 */
export interface LspClientConfig {
  command: string;
  args?: string[];
  initializationOptions?: Record<string, unknown>;
}

/**
 * Result of a textDocument/definition request.
 */
export interface DefinitionResult {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Default timeout for LSP requests in milliseconds (5 seconds). */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * LspClient manages the lifecycle of an LSP server subprocess and
 * sends JSON-RPC requests with a 5-second timeout.
 */
export class LspClient {
  private config: LspClientConfig;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private responseEmitter = new EventEmitter();
  // Raw byte buffer. LSP Content-Length is a UTF-8 byte count, so framing must be
  // done on bytes, not on a UTF-16 JS string (which desynchronizes for any
  // non-ASCII payload).
  private buffer: Buffer = Buffer.alloc(0);
  private contentLength: number | null = null;
  private initialized = false;

  constructor(config: LspClientConfig) {
    this.config = config;
    // Allow many concurrent listeners for pending requests
    this.responseEmitter.setMaxListeners(200);
  }

  /**
   * Start the LSP server subprocess and perform the initialization handshake.
   * Sends `initialize` followed by `initialized` notification.
   */
  async start(): Promise<void> {
    const args = this.config.args ?? [];
    this.process = spawn(this.config.command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.handleData(chunk);
    });

    this.process.on('error', (err) => {
      // Emit error to all pending requests
      this.responseEmitter.emit('error', err);
    });

    this.process.on('exit', () => {
      this.initialized = false;
      this.process = null;
    });

    // LSP Initialize handshake
    await this.sendRequest('initialize', {
      processId: process.pid,
      capabilities: {},
      rootUri: null,
      initializationOptions: this.config.initializationOptions ?? {},
    });

    // Send initialized notification (no response expected)
    this.sendNotification('initialized', {});
    this.initialized = true;
  }

  /**
   * Send a textDocument/definition request to resolve a symbol's definition location.
   * Enforces a 5-second timeout. Returns null on timeout or error.
   *
   * @param filePath - Absolute file path containing the symbol
   * @param position - Zero-based line and character position of the symbol
   * @returns The definition location or null if unresolved/timeout
   */
  async resolveDefinition(
    filePath: string,
    position: { line: number; character: number }
  ): Promise<DefinitionResult | null> {
    if (!this.initialized || !this.process) {
      return null;
    }

    try {
      const result = await this.sendRequest('textDocument/definition', {
        textDocument: { uri: pathToFileURL(filePath).toString() },
        position,
      });

      if (!result) {
        return null;
      }

      // LSP may return a single Location, an array of Locations, or a LocationLink array
      const location = Array.isArray(result) ? result[0] : result;
      if (!location || !location.uri || !location.range) {
        return null;
      }

      return {
        uri: location.uri,
        range: location.range,
      };
    } catch {
      return null;
    }
  }

  /**
   * Send a textDocument/hover request to get type information for a symbol.
   * Enforces a 5-second timeout. Returns null on timeout or error.
   *
   * @param filePath - Absolute file path containing the symbol
   * @param position - Zero-based line and character position of the symbol
   * @returns Type info string or null if unavailable/timeout
   */
  async getTypeInfo(
    filePath: string,
    position: { line: number; character: number }
  ): Promise<string | null> {
    if (!this.initialized || !this.process) {
      return null;
    }

    try {
      const result = await this.sendRequest('textDocument/hover', {
        textDocument: { uri: pathToFileURL(filePath).toString() },
        position,
      }) as { contents?: unknown } | null;

      if (!result || !result.contents) {
        return null;
      }

      const contents = result.contents;

      // Hover contents can be a string, MarkedString, or MarkupContent
      if (typeof contents === 'string') {
        return contents;
      }
      if (typeof contents === 'object' && contents !== null && 'value' in contents) {
        const value = (contents as { value: unknown }).value;
        if (typeof value === 'string') {
          return value;
        }
      }
      if (Array.isArray(contents)) {
        const first = contents[0] as string | { value?: string } | undefined;
        if (typeof first === 'string') {
          return first;
        }
        if (first && typeof first === 'object' && 'value' in first) {
          return first.value ?? null;
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Gracefully shutdown the LSP server by sending shutdown and exit requests.
   */
  async shutdown(): Promise<void> {
    if (!this.process) {
      return;
    }

    try {
      await this.sendRequest('shutdown', null);
      this.sendNotification('exit', null);
    } catch {
      // Force kill if shutdown fails
    } finally {
      if (this.process) {
        this.process.kill();
        this.process = null;
      }
      this.initialized = false;
    }
  }

  /**
   * Send a JSON-RPC request with a 5-second timeout.
   * Uses Promise.race between the actual response and a timeout.
   */
  private sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;

    // Bail out before attaching any listeners/timers so the not-writable path
    // can't leak them.
    if (!this.process?.stdin?.writable) {
      return Promise.resolve(null);
    }
    const stdin = this.process.stdin;

    return new Promise<unknown>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      // Single teardown for every exit path (response, error, timeout, write
      // failure). The previous implementation only removed listeners inside
      // onResponse/onError and never cleared the timeout timer, so a timed-out
      // or non-writable request leaked both the emitter listeners and a live
      // 5s timer on every call.
      const finish = () => {
        if (settled) return;
        settled = true;
        this.responseEmitter.off('response', onResponse);
        this.responseEmitter.off('error', onError);
        if (timer !== undefined) clearTimeout(timer);
      };

      const onResponse = (response: { id: number; result?: unknown; error?: unknown }) => {
        if (response.id !== id) return;
        finish();
        if (response.error) {
          reject(new Error(String((response.error as { message?: string }).message ?? response.error)));
        } else {
          resolve(response.result);
        }
      };

      const onError = (err: Error) => {
        finish();
        reject(err);
      };

      this.responseEmitter.on('response', onResponse);
      this.responseEmitter.on('error', onError);

      timer = setTimeout(() => {
        finish();
        reject(new Error(`LSP request '${method}' timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      try {
        stdin.write(content);
      } catch (err) {
        finish();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(method: string, params: unknown): void {
    if (!this.process?.stdin?.writable) {
      return;
    }

    const message = JSON.stringify({ jsonrpc: '2.0', method, params });
    const content = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`;
    this.process.stdin.write(content);
  }

  /**
   * Handle incoming data from the LSP server's stdout.
   * Parses the LSP base protocol (Content-Length header + JSON body).
   */
  private handleData(chunk: Buffer): void {
    // Accumulate raw bytes. All framing below is byte-based because Content-Length
    // counts UTF-8 bytes; slicing a UTF-16 string by that count would consume the
    // wrong number of characters for non-ASCII bodies and permanently desync the
    // stream.
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);

    while (true) {
      if (this.contentLength === null) {
        // Look for header separator (ASCII, so a byte search is exact)
        const headerEnd = this.buffer.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
          return; // Need more data
        }

        const header = this.buffer.subarray(0, headerEnd).toString('utf-8');
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          // Skip malformed header
          this.buffer = this.buffer.subarray(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.subarray(headerEnd + 4);
      }

      // Check if we have enough bytes for the body
      if (this.buffer.length < this.contentLength) {
        return; // Need more data
      }

      const body = this.buffer.subarray(0, this.contentLength).toString('utf-8');
      this.buffer = this.buffer.subarray(this.contentLength);
      this.contentLength = null;

      try {
        const message = JSON.parse(body) as { id?: number; method?: string; result?: unknown; error?: unknown };

        // Only emit responses (messages with an id and no method)
        if (message.id !== undefined && !message.method) {
          this.responseEmitter.emit('response', message);
        }
      } catch {
        // Skip malformed JSON
      }
    }
  }
}

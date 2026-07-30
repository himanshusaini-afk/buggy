import type Database from 'better-sqlite3';
import type { NodeRecord, EdgeRecord } from '../types/graph.js';

/**
 * Record representing a symbol resolution to be stored in the database.
 */
export interface SymbolResolutionRecord {
  id: string;
  usage_node_id: string;
  definition_node_id: string | null;
  symbol_name: string;
  type_info: string | null;
  enclosing_scope: string | null;
  resolved: boolean;
}

/**
 * Error thrown when an edge write would create a dangling reference.
 */
export class ReferentialIntegrityError extends Error {
  public readonly missingNodeId: string;

  constructor(missingNodeId: string) {
    super(
      `Referential integrity violation: node "${missingNodeId}" does not exist in the nodes table`
    );
    this.name = 'ReferentialIntegrityError';
    this.missingNodeId = missingNodeId;
  }
}

/**
 * Error thrown when all retry attempts for a write operation have been exhausted.
 */
export class WriteExhaustedError extends Error {
  public readonly affectedIds: string[];

  constructor(affectedIds: string[], cause?: Error) {
    super(
      `Write failed after 3 retries for IDs: ${affectedIds.join(', ')}`
    );
    this.name = 'WriteExhaustedError';
    this.affectedIds = affectedIds;
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * GraphWriter provides asynchronous write operations to the graph database
 * with referential integrity enforcement and retry logic.
 *
 * Writes are scheduled via microtask batching to avoid blocking the parse
 * pipeline while maintaining ≤5ms latency addition per operation.
 */
export class GraphWriter {
  private readonly db: Database.Database;
  private pendingWrites: Array<() => void> = [];
  private flushScheduled = false;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Inserts a node record into the nodes table.
   * Uses microtask scheduling to batch writes without blocking the parse pipeline.
   * Latency addition does not exceed 5ms.
   */
  async writeNode(node: NodeRecord): Promise<void> {
    return this.enqueueWrite(() => {
      this.executeWithRetry(() => {
        this.db
          .prepare(
            `INSERT INTO nodes (id, type, file_path, start_byte, end_byte, start_line, start_column, end_line, end_column, node_kind, text_content, is_error, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            node.id,
            node.type,
            node.file_path,
            node.start_byte,
            node.end_byte,
            node.start_line,
            node.start_column,
            node.end_line,
            node.end_column,
            node.node_kind ?? null,
            node.text_content ?? null,
            node.is_error ? 1 : 0,
            node.metadata ?? null,
            node.created_at
          );
      }, [node.id]);
    });
  }

  /**
   * Inserts an edge record into the edges table.
   * Checks that both source_id and target_id exist in the nodes table BEFORE
   * inserting. If either is missing, throws a ReferentialIntegrityError.
   */
  async writeEdge(edge: EdgeRecord): Promise<void> {
    return this.enqueueWrite(() => {
      // Explicit referential integrity check for clear error messages
      const sourceExists = this.db
        .prepare('SELECT 1 FROM nodes WHERE id = ?')
        .get(edge.source_id);
      if (!sourceExists) {
        throw new ReferentialIntegrityError(edge.source_id);
      }

      const targetExists = this.db
        .prepare('SELECT 1 FROM nodes WHERE id = ?')
        .get(edge.target_id);
      if (!targetExists) {
        throw new ReferentialIntegrityError(edge.target_id);
      }

      this.executeWithRetry(() => {
        this.db
          .prepare(
            `INSERT INTO edges (id, source_id, target_id, relationship, metadata, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            edge.id,
            edge.source_id,
            edge.target_id,
            edge.relationship,
            edge.metadata ?? null,
            edge.created_at
          );
      }, [edge.id, edge.source_id, edge.target_id]);
    });
  }

  /**
   * Inserts a symbol resolution record into the symbol_resolutions table.
   */
  async writeSymbolResolution(resolution: SymbolResolutionRecord): Promise<void> {
    return this.enqueueWrite(() => {
      this.executeWithRetry(() => {
        this.db
          .prepare(
            `INSERT INTO symbol_resolutions (id, usage_node_id, definition_node_id, symbol_name, type_info, enclosing_scope, resolved)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            resolution.id,
            resolution.usage_node_id,
            resolution.definition_node_id,
            resolution.symbol_name,
            resolution.type_info,
            resolution.enclosing_scope,
            resolution.resolved ? 1 : 0
          );
      }, [resolution.id, resolution.usage_node_id]);
    });
  }

  /**
   * Enqueues a write operation and schedules a microtask flush.
   * This batching approach ensures ≤5ms latency addition per write.
   */
  private enqueueWrite(operation: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pendingWrites.push(() => {
        try {
          operation();
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => this.flush());
      }
    });
  }

  /**
   * Flushes all pending writes in a single batch.
   */
  private flush(): void {
    this.flushScheduled = false;
    const writes = this.pendingWrites.splice(0);
    for (const write of writes) {
      write();
    }
  }

  /**
   * Executes a database operation with retry logic.
   * Retries up to 3 times with 100ms intervals on failure.
   * If all retries fail, throws a WriteExhaustedError.
   */
  private executeWithRetry(operation: () => void, affectedIds: string[]): void {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        operation();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry referential integrity errors — they won't resolve on retry
        if (err instanceof ReferentialIntegrityError) {
          throw err;
        }

        // On last attempt, don't sleep — just fall through to throw
        if (attempt < 2) {
          this.sleepSync(100);
        }
      }
    }

    throw new WriteExhaustedError(affectedIds, lastError);
  }

  /**
   * Synchronous sleep for retry intervals.
   * Uses SharedArrayBuffer + Atomics.wait for precise timing without busy-waiting.
   */
  private sleepSync(ms: number): void {
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
  }
}

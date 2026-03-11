/**
 * File Locking Utility
 * 
 * Provides atomic file locking to prevent concurrent writes
 * Uses fs.openSync with 'wx' flag (atomic create-if-not-exists)
 */

import { openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { createDebugLogger } from './debug-logger.js';

const debugLogger = createDebugLogger('FILE_LOCK');

export class FileLock {
  private lockPath: string;
  private fd: number | null = null;

  constructor(filePath: string) {
    this.lockPath = filePath + '.lock';
  }

  /**
   * Acquire the lock with timeout
   * 
   * @param timeoutMs - Maximum time to wait for lock (default: 5000ms)
   * @param retryIntervalMs - Time between retry attempts (default: 100ms)
   * @returns true if lock acquired, false if timeout
   */
  async acquire(timeoutMs = 5000, retryIntervalMs = 100): Promise<boolean> {
    const start = Date.now();
    let attempts = 0;

    while (Date.now() - start < timeoutMs) {
      attempts++;
      try {
        // 'wx' = create file, fail if exists (atomic operation!)
        this.fd = openSync(this.lockPath, 'wx');
        debugLogger.info(`Lock acquired after ${attempts} attempts (${Date.now() - start}ms)`);
        return true;
      } catch (e: any) {
        if (e.code !== 'EEXIST') {
          // Unexpected error, not just "file exists"
          debugLogger.error('Unexpected error acquiring lock:', e);
          throw e;
        }
        // Lock file exists, another process has it
        await this.delay(retryIntervalMs);
      }
    }

    debugLogger.warn(`Lock acquisition timeout after ${timeoutMs}ms (${attempts} attempts)`);
    return false;
  }

  /**
   * Release the lock
   * Must be called in finally block to ensure cleanup
   */
  release(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
        if (existsSync(this.lockPath)) {
          unlinkSync(this.lockPath);
        }
        this.fd = null;
        debugLogger.info('Lock released');
      } catch (e) {
        debugLogger.error('Error releasing lock:', e);
        // Don't throw, cleanup is best-effort
      }
    }
  }

  /**
   * Check if lock file exists (without acquiring)
   */
  static isLocked(filePath: string): boolean {
    const lockPath = filePath + '.lock';
    return existsSync(lockPath);
  }

  /**
   * Clean up stale lock file (if process crashed without releasing)
   */
  static cleanup(filePath: string): void {
    const lockPath = filePath + '.lock';
    try {
      if (existsSync(lockPath)) {
        unlinkSync(lockPath);
        debugLogger.info('Cleaned up stale lock file');
      }
    } catch (e) {
      debugLogger.error('Error cleaning up lock file:', e);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

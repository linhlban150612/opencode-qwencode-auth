/**
 * Lightweight Token Manager
 * 
 * Simplified version of qwen-code's SharedTokenManager
 * Handles:
 * - In-memory caching to avoid repeated file reads
 * - Preventive refresh (before expiration)
 * - Reactive recovery (on 401 errors)
 * - Promise tracking to avoid concurrent refreshes
 */

import { loadCredentials, saveCredentials, getCredentialsPath } from './auth.js';
import { refreshAccessToken } from '../qwen/oauth.js';
import type { QwenCredentials } from '../types.js';
import { createDebugLogger } from '../utils/debug-logger.js';
import { FileLock } from '../utils/file-lock.js';

const debugLogger = createDebugLogger('TOKEN_MANAGER');
const TOKEN_REFRESH_BUFFER_MS = 30 * 1000; // 30 seconds

class TokenManager {
  private memoryCache: QwenCredentials | null = null;
  private refreshPromise: Promise<QwenCredentials | null> | null = null;

  /**
   * Get valid credentials, refreshing if necessary
   * 
   * @param forceRefresh - If true, refresh even if current token is valid
   * @returns Valid credentials or null if unavailable
   */
  async getValidCredentials(forceRefresh = false): Promise<QwenCredentials | null> {
    try {
      // 1. Check in-memory cache first (unless force refresh)
      if (!forceRefresh && this.memoryCache && this.isTokenValid(this.memoryCache)) {
        return this.memoryCache;
      }

      // 2. If concurrent refresh is already happening, wait for it
      if (this.refreshPromise) {
        debugLogger.info('Waiting for ongoing refresh...');
        return await this.refreshPromise;
      }

      // 3. Need to perform refresh or reload from file
      this.refreshPromise = (async () => {
        // Check if file has valid credentials (maybe updated by another session)
        const fromFile = loadCredentials();
        
        if (!forceRefresh && fromFile && this.isTokenValid(fromFile)) {
          debugLogger.info('Using valid credentials from file');
          this.memoryCache = fromFile;
          return fromFile;
        }

        // Need to perform actual refresh via API (with file locking for multi-process safety)
        return await this.performTokenRefreshWithLock(fromFile);
      })();
      
      try {
        const result = await this.refreshPromise;
        return result;
      } finally {
        this.refreshPromise = null;
      }
    } catch (error) {
      debugLogger.error('Failed to get valid credentials:', error);
      return null;
    }
  }

  /**
   * Check if token is valid (not expired with buffer)
   */
  private isTokenValid(credentials: QwenCredentials): boolean {
    if (!credentials.expiryDate || !credentials.accessToken) {
      return false;
    }
    const isExpired = Date.now() > credentials.expiryDate - TOKEN_REFRESH_BUFFER_MS;
    return !isExpired;
  }

  /**
   * Perform the actual token refresh
   */
  private async performTokenRefresh(current: QwenCredentials | null): Promise<QwenCredentials | null> {
    if (!current?.refreshToken) {
      debugLogger.warn('Cannot refresh: No refresh token available');
      return null;
    }

    try {
      debugLogger.info('Refreshing access token...');
      const refreshed = await refreshAccessToken(current.refreshToken);
      
      // Save refreshed credentials
      saveCredentials(refreshed);
      
      // Update cache
      this.memoryCache = refreshed;
      
      debugLogger.info('Token refreshed successfully');
      return refreshed;
    } catch (error) {
      debugLogger.error('Token refresh failed:', error);
      return null;
    }
  }

  /**
   * Perform token refresh with file locking (multi-process safe)
   */
  private async performTokenRefreshWithLock(current: QwenCredentials | null): Promise<QwenCredentials | null> {
    const credPath = getCredentialsPath();
    const lock = new FileLock(credPath);

    // Try to acquire lock (wait up to 5 seconds)
    const lockAcquired = await lock.acquire(5000, 100);

    if (!lockAcquired) {
      // Another process is doing refresh, wait and reload from file
      debugLogger.info('Another process is refreshing, waiting...');
      await this.delay(600); // Wait for other process to finish
      
      // Reload credentials from file (should have new token now)
      const reloaded = loadCredentials();
      if (reloaded && this.isTokenValid(reloaded)) {
        this.memoryCache = reloaded;
        debugLogger.info('Loaded refreshed credentials from file');
        return reloaded;
      }
      
      // Still invalid, try again without lock (edge case)
      return await this.performTokenRefresh(current);
    }

    try {
      // Critical section: only one process executes here
      // Double-check if another process already refreshed while we were waiting for lock
      const fromFile = loadCredentials();
      if (fromFile && this.isTokenValid(fromFile)) {
        debugLogger.info('Credentials already refreshed by another process');
        this.memoryCache = fromFile;
        return fromFile;
      }

      // Perform the actual refresh
      return await this.performTokenRefresh(current);
    } finally {
      // Always release lock, even if error occurs
      lock.release();
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Clear cached credentials
   */
  clearCache(): void {
    this.memoryCache = null;
  }

  /**
   * Manually set credentials
   */
  setCredentials(credentials: QwenCredentials): void {
    this.memoryCache = credentials;
    saveCredentials(credentials);
  }
}

// Singleton instance
export const tokenManager = new TokenManager();

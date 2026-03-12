/**
 * Qwen Credentials Management
 *
 * Handles saving credentials to ~/.qwen/oauth_creds.json
 */

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync, writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { QwenCredentials } from '../types.js';
import { QWEN_API_CONFIG } from '../constants.js';

/**
 * Get the path to the credentials file
 */
export function getCredentialsPath(): string {
  const homeDir = homedir();
  return join(homeDir, '.qwen', 'oauth_creds.json');
}

/**
 * Load credentials from file and map to camelCase QwenCredentials
 */
export function loadCredentials(): QwenCredentials | null {
  const credPath = getCredentialsPath();
  if (!existsSync(credPath)) {
    return null;
  }

  try {
    const content = readFileSync(credPath, 'utf8');
    const data = JSON.parse(content);
    
    if (!data.access_token) {
      console.warn('[QwenAuth] No access_token found in credentials file');
      return null;
    }

    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      refreshToken: data.refresh_token,
      resourceUrl: data.resource_url,
      expiryDate: data.expiry_date,
      scope: data.scope,
    };
  } catch (error) {
    console.error('[QwenAuth] Failed to load credentials:', error);
    return null;
  }
}

/**
 * Resolve the API base URL based on the token region
 */
export function resolveBaseUrl(resourceUrl?: string): string {
  if (!resourceUrl) return QWEN_API_CONFIG.portalBaseUrl;

  if (resourceUrl.includes('portal.qwen.ai')) {
    return QWEN_API_CONFIG.portalBaseUrl;
  }

  if (resourceUrl.includes('dashscope')) {
    // Both dashscope and dashscope-intl use similar URL patterns
    if (resourceUrl.includes('dashscope-intl')) {
      return 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    }
    return QWEN_API_CONFIG.defaultBaseUrl;
  }

  return QWEN_API_CONFIG.portalBaseUrl;
}

/**
 * Save credentials to file in qwen-code compatible format
 * Uses atomic write (temp file + rename) to prevent corruption
 */
export function saveCredentials(credentials: QwenCredentials): void {
  const credPath = getCredentialsPath();
  const dir = dirname(credPath);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  // Save in qwen-code format for compatibility
  const data = {
    access_token: credentials.accessToken,
    token_type: credentials.tokenType || 'Bearer',
    refresh_token: credentials.refreshToken,
    resource_url: credentials.resourceUrl,
    expiry_date: credentials.expiryDate,
    scope: credentials.scope,
  };

  // ATOMIC WRITE: temp file + rename to prevent corruption
  const tempPath = `${credPath}.tmp.${randomUUID()}`;
  
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    renameSync(tempPath, credPath); // Atomic on POSIX systems
  } catch (error) {
    // Cleanup temp file if rename fails
    try {
      if (existsSync(tempPath)) {
        unlinkSync(tempPath);
      }
    } catch {}
    throw error;
  }
}

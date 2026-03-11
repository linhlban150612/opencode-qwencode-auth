/**
 * Debug & Test File - NÃO modifica comportamento do plugin
 * 
 * Uso:
 *   bun run tests/debug.ts           # Teste completo
 *   bun run tests/debug.ts status    # Ver estado atual
 *   bun run tests/debug.ts validate  # Validar token
 *   bun run tests/debug.ts refresh   # Testar refresh
 *   bun run tests/debug.ts oauth     # Full OAuth flow
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

// Importa funções do código existente (sem modificar)
import {
  generatePKCE,
  requestDeviceAuthorization,
  pollDeviceToken,
  tokenResponseToCredentials,
  refreshAccessToken,
  isCredentialsExpired,
  SlowDownError,
} from '../src/qwen/oauth.js';
import {
  loadCredentials,
  saveCredentials,
  resolveBaseUrl,
  getCredentialsPath,
} from '../src/plugin/auth.js';
import { QWEN_API_CONFIG, QWEN_OAUTH_CONFIG, QWEN_OFFICIAL_HEADERS } from '../src/constants.js';
import { retryWithBackoff } from '../src/utils/retry.js';
import { RequestQueue } from '../src/plugin/request-queue.js';
import type { QwenCredentials } from '../src/types.js';

// ============================================
// Logging Utilities
// ============================================

const LOG_PREFIX = {
  TEST: '[TEST]',
  INFO: '[INFO]',
  OK: '[✓]',
  FAIL: '[✗]',
  WARN: '[!]',
  DEBUG: '[→]',
};

function log(prefix: keyof typeof LOG_PREFIX, message: string, data?: unknown) {
  const timestamp = new Date().toISOString().split('T')[1].replace('Z', '');
  const prefixStr = LOG_PREFIX[prefix];
  
  if (data !== undefined) {
    console.log(`${timestamp} ${prefixStr} ${message}`, data);
  } else {
    console.log(`${timestamp} ${prefixStr} ${message}`);
  }
}

function logTest(name: string, message: string) {
  log('TEST', `${name}: ${message}`);
}

function logOk(name: string, message: string) {
  log('OK', `${name}: ${message}`);
}

function logFail(name: string, message: string, error?: unknown) {
  log('FAIL', `${name}: ${message}`);
  if (error) {
    console.error('  Error:', error instanceof Error ? error.message : error);
  }
}

function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.substring(0, length) + '...';
}

// ============================================
// Test Functions
// ============================================

async function testPKCE(): Promise<boolean> {
  logTest('PKCE', 'Iniciando teste de geração PKCE...');
  
  try {
    const { verifier, challenge } = generatePKCE();
    
    logOk('PKCE', `Verifier gerado: ${truncate(verifier, 20)} (${verifier.length} chars)`);
    logOk('PKCE', `Challenge gerado: ${truncate(challenge, 20)} (${challenge.length} chars)`);
    
    // Validate base64url encoding
    const base64urlRegex = /^[A-Za-z0-9_-]+$/;
    if (!base64urlRegex.test(verifier)) {
      logFail('PKCE', 'Verifier não é base64url válido');
      return false;
    }
    logOk('PKCE', 'Verifier: formato base64url válido ✓');
    
    if (!base64urlRegex.test(challenge)) {
      logFail('PKCE', 'Challenge não é base64url válido');
      return false;
    }
    logOk('PKCE', 'Challenge: formato base64url válido ✓');
    
    // Validate lengths (should be ~43 chars for 32 bytes)
    if (verifier.length < 40) {
      logFail('PKCE', `Verifier muito curto: ${verifier.length} chars (esperado ~43)`);
      return false;
    }
    logOk('PKCE', `Verifier length: ${verifier.length} chars ✓`);
    
    logOk('PKCE', 'Teste concluído com sucesso');
    return true;
  } catch (error) {
    logFail('PKCE', 'Falha na geração', error);
    return false;
  }
}

async function testDeviceAuthorization(): Promise<boolean> {
  logTest('DeviceAuth', 'Iniciando teste de device authorization...');
  
  try {
    const { challenge } = generatePKCE();
    
    log('DEBUG', 'DeviceAuth', `POST ${QWEN_OAUTH_CONFIG.deviceCodeEndpoint}`);
    log('DEBUG', 'DeviceAuth', `client_id: ${truncate(QWEN_OAUTH_CONFIG.clientId, 16)}`);
    log('DEBUG', 'DeviceAuth', `scope: ${QWEN_OAUTH_CONFIG.scope}`);
    
    const startTime = Date.now();
    const deviceAuth = await requestDeviceAuthorization(challenge);
    const elapsed = Date.now() - startTime;
    
    logOk('DeviceAuth', `HTTP ${elapsed}ms - device_code: ${truncate(deviceAuth.device_code, 16)}`);
    logOk('DeviceAuth', `user_code: ${deviceAuth.user_code}`);
    logOk('DeviceAuth', `verification_uri: ${deviceAuth.verification_uri}`);
    logOk('DeviceAuth', `expires_in: ${deviceAuth.expires_in}s`);
    
    // Validate response
    if (!deviceAuth.device_code || !deviceAuth.user_code) {
      logFail('DeviceAuth', 'Resposta inválida: missing device_code ou user_code');
      return false;
    }
    logOk('DeviceAuth', 'Resposta válida ✓');
    
    if (deviceAuth.expires_in < 300) {
      log('WARN', 'DeviceAuth', `expires_in curto: ${deviceAuth.expires_in}s (recomendado >= 300s)`);
    } else {
      logOk('DeviceAuth', `expires_in adequado: ${deviceAuth.expires_in}s ✓`);
    }
    
    logOk('DeviceAuth', 'Teste concluído com sucesso');
    return true;
  } catch (error) {
    logFail('DeviceAuth', 'Falha na autorização', error);
    return false;
  }
}

async function testCredentialsPersistence(): Promise<boolean> {
  logTest('Credentials', 'Iniciando teste de persistência...');
  
  const credsPath = getCredentialsPath();
  log('DEBUG', 'Credentials', `Caminho: ${credsPath}`);
  
  try {
    // Test save
    const testCreds: QwenCredentials = {
      accessToken: 'test_access_token_' + Date.now(),
      tokenType: 'Bearer',
      refreshToken: 'test_refresh_token_' + Date.now(),
      resourceUrl: 'portal.qwen.ai',
      expiryDate: Date.now() + 3600000,
      scope: 'openid profile email model.completion',
    };
    
    log('DEBUG', 'Credentials', 'Salvando credentials de teste...');
    saveCredentials(testCreds);
    logOk('Credentials', 'Save: concluído');
    
    // Verify file exists
    if (!existsSync(credsPath)) {
      logFail('Credentials', 'Arquivo não foi criado');
      return false;
    }
    logOk('Credentials', `Arquivo criado: ${credsPath} ✓`);
    
    // Test load
    log('DEBUG', 'Credentials', 'Carregando credentials...');
    const loaded = loadCredentials();
    
    if (!loaded) {
      logFail('Credentials', 'Load: retornou null');
      return false;
    }
    logOk('Credentials', 'Load: concluído');
    
    // Validate loaded data
    if (loaded.access_token !== testCreds.accessToken) {
      logFail('Credentials', 'Access token não confere');
      return false;
    }
    logOk('Credentials', `Access token: ${truncate(loaded.access_token, 20)} ✓`);
    
    if (loaded.refresh_token !== testCreds.refreshToken) {
      logFail('Credentials', 'Refresh token não confere');
      return false;
    }
    logOk('Credentials', `Refresh token: ${truncate(loaded.refresh_token, 20)} ✓`);
    
    if (loaded.expiry_date !== testCreds.expiryDate) {
      logFail('Credentials', 'Expiry date não confere');
      return false;
    }
    logOk('Credentials', `Expiry date: ${new Date(loaded.expiry_date).toISOString()} ✓`);
    
    logOk('Credentials', 'Teste de persistência concluído com sucesso');
    return true;
  } catch (error) {
    logFail('Credentials', 'Falha na persistência', error);
    return false;
  }
}

async function testBaseUrlResolution(): Promise<boolean> {
  logTest('BaseUrl', 'Iniciando teste de resolução de baseURL...');
  
  const testCases = [
    { input: undefined, expected: QWEN_API_CONFIG.portalBaseUrl, desc: 'undefined' },
    { input: 'portal.qwen.ai', expected: QWEN_API_CONFIG.portalBaseUrl, desc: 'portal.qwen.ai' },
    { input: 'dashscope', expected: QWEN_API_CONFIG.defaultBaseUrl, desc: 'dashscope' },
    { input: 'dashscope-intl', expected: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', desc: 'dashscope-intl' },
  ];
  
  let allPassed = true;
  
  for (const testCase of testCases) {
    const result = resolveBaseUrl(testCase.input);
    const passed = result === testCase.expected;
    
    if (passed) {
      logOk('BaseUrl', `${testCase.desc}: ${result} ✓`);
    } else {
      logFail('BaseUrl', `${testCase.desc}: esperado ${testCase.expected}, got ${result}`);
      allPassed = false;
    }
  }
  
  if (allPassed) {
    logOk('BaseUrl', 'Teste de resolução concluído com sucesso');
  }
  
  return allPassed;
}

async function testTokenRefresh(): Promise<boolean> {
  logTest('Refresh', 'Iniciando teste de refresh de token...');
  
  const creds = loadCredentials();
  
  if (!creds || !creds.access_token) {
    log('WARN', 'Refresh', 'Nenhuma credential encontrada, pulando teste de refresh');
    return true;
  }
  
  if (creds.access_token.startsWith('test_')) {
    log('WARN', 'Refresh', 'Tokens de teste detectados - refresh EXPECTADO para falhar');
    log('INFO', 'Refresh', 'Este teste usou tokens fictícios do teste de persistência');
    log('INFO', 'Refresh', 'Para testar refresh real, rode: bun run tests/debug.ts oauth');
    return true;
  }
  
  log('DEBUG', 'Refresh', `Access token: ${truncate(creds.access_token, 20)}`);
  log('DEBUG', 'Refresh', `Refresh token: ${creds.refresh_token ? truncate(creds.refresh_token, 20) : 'N/A'}`);
  log('DEBUG', 'Refresh', `Expiry: ${creds.expiry_date ? new Date(creds.expiry_date).toISOString() : 'N/A'}`);
  
  if (!creds.refresh_token) {
    log('WARN', 'Refresh', 'Refresh token não disponível, pulando teste');
    return true;
  }
  
  try {
    log('DEBUG', 'Refresh', `POST ${QWEN_OAUTH_CONFIG.tokenEndpoint}`);
    const startTime = Date.now();
    
    const refreshed = await refreshAccessToken(creds.refresh_token);
    const elapsed = Date.now() - startTime;
    
    logOk('Refresh', `HTTP ${elapsed}ms - novo access token: ${truncate(refreshed.accessToken, 20)}`);
    logOk('Refresh', `Novo refresh token: ${refreshed.refreshToken ? truncate(refreshed.refreshToken, 20) : 'N/A'}`);
    logOk('Refresh', `Novo expiry: ${new Date(refreshed.expiryDate).toISOString()}`);
    
    if (!refreshed.accessToken) {
      logFail('Refresh', 'Novo access token é vazio');
      return false;
    }
    logOk('Refresh', 'Novo token válido ✓');
    
    logOk('Refresh', 'Teste de refresh concluído com sucesso');
    return true;
  } catch (error) {
    logFail('Refresh', 'Falha no refresh', error);
    return false;
  }
}

async function testIsCredentialsExpired(): Promise<boolean> {
  logTest('Expiry', 'Iniciando teste de verificação de expiração...');
  
  const creds = loadCredentials();
  
  if (!creds || !creds.access_token) {
    log('WARN', 'Expiry', 'Nenhuma credential encontrada');
    return true;
  }
  
  const qwenCreds: QwenCredentials = {
    accessToken: creds.access_token,
    tokenType: creds.token_type || 'Bearer',
    refreshToken: creds.refresh_token,
    resourceUrl: creds.resource_url,
    expiryDate: creds.expiry_date,
    scope: creds.scope,
  };
  
  const isExpired = isCredentialsExpired(qwenCreds);
  const expiryDate = qwenCreds.expiryDate ? new Date(qwenCreds.expiryDate) : null;
  
  log('INFO', 'Expiry', `Expiry date: ${expiryDate ? expiryDate.toISOString() : 'N/A'}`);
  log('INFO', 'Expiry', `Current time: ${new Date().toISOString()}`);
  log('INFO', 'Expiry', `Is expired: ${isExpired}`);
  
  if (isExpired) {
    log('WARN', 'Expiry', 'Credentials expiradas - necessário refresh ou re-auth');
  } else {
    logOk('Expiry', 'Credentials válidas');
  }
  
  return true;
}

async function testRetryMechanism(): Promise<boolean> {
  logTest('Retry', 'Iniciando teste de retry com backoff...');
  
  let attempts = 0;
  const maxFailures = 2;
  
  try {
    log('DEBUG', 'Retry', 'Testando retry com falhas temporárias...');
    
    await retryWithBackoff(
      async () => {
        attempts++;
        log('DEBUG', 'Retry', `Tentativa #${attempts}`);
        
        if (attempts <= maxFailures) {
          // Simular erro 429
          const error = new Error('Rate limit exceeded') as Error & { status?: number };
          (error as any).status = 429;
          (error as any).response = {
            headers: { 'retry-after': '1' }
          };
          throw error;
        }
        
        return 'success';
      },
      {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 1000,
      }
    );
    
    logOk('Retry', `Sucesso após ${attempts} tentativas`);
    
    if (attempts === maxFailures + 1) {
      logOk('Retry', 'Retry funcionou corretamente ✓');
      return true;
    } else {
      logFail('Retry', `Número incorreto de tentativas: ${attempts} (esperado ${maxFailures + 1})`);
      return false;
    }
  } catch (error) {
    logFail('Retry', 'Falha no teste de retry', error);
    return false;
  }
}

async function testThrottling(): Promise<boolean> {
  logTest('Throttling', 'Iniciando teste de throttling...');
  
  const queue = new RequestQueue();
  const timestamps: number[] = [];
  const requestCount = 3;
  
  log('DEBUG', 'Throttling', `Fazendo ${requestCount} requisições sequenciais...`);
  
  // Fazer 3 requisições sequencialmente (não em paralelo)
  for (let i = 0; i < requestCount; i++) {
    await queue.enqueue(async () => {
      timestamps.push(Date.now());
      log('DEBUG', 'Throttling', `Requisição #${i + 1} executada`);
      return i;
    });
  }
  
  // Verificar intervalos
  log('DEBUG', 'Throttling', 'Analisando intervalos...');
  let allIntervalsValid = true;
  
  for (let i = 1; i < timestamps.length; i++) {
    const interval = timestamps[i] - timestamps[i - 1];
    const minExpected = 1000; // 1 second minimum
    const maxExpected = 3000; // 1s + 1.5s max jitter
    
    log('INFO', 'Throttling', `Intervalo #${i}: ${interval}ms`);
    
    if (interval < minExpected) {
      logFail('Throttling', `Intervalo #${i} muito curto: ${interval}ms (mínimo ${minExpected}ms)`);
      allIntervalsValid = false;
    } else if (interval > maxExpected) {
      log('WARN', 'Throttling', `Intervalo #${i} longo: ${interval}ms (máximo esperado ${maxExpected}ms)`);
    } else {
      logOk('Throttling', `Intervalo #${i}: ${interval}ms ✓`);
    }
  }
  
  if (allIntervalsValid) {
    logOk('Throttling', 'Throttling funcionou corretamente ✓');
    return true;
  } else {
    logFail('Throttling', 'Alguns intervalos estão abaixo do mínimo esperado');
    return false;
  }
}

// ============================================
// Debug Functions (estado atual)
// ============================================

function debugCurrentStatus(): void {
  log('INFO', 'Status', '=== Debug Current Status ===');
  
  const credsPath = getCredentialsPath();
  log('INFO', 'Status', `Credentials path: ${credsPath}`);
  log('INFO', 'Status', `File exists: ${existsSync(credsPath)}`);
  
  const creds = loadCredentials();
  
  if (!creds) {
    log('WARN', 'Status', 'Nenhuma credential encontrada');
    return;
  }
  
  log('INFO', 'Status', '=== Credentials ===');
  log('INFO', 'Status', `Access token: ${creds.access_token ? truncate(creds.access_token, 30) : 'N/A'}`);
  log('INFO', 'Status', `Token type: ${creds.token_type || 'N/A'}`);
  log('INFO', 'Status', `Refresh token: ${creds.refresh_token ? truncate(creds.refresh_token, 30) : 'N/A'}`);
  log('INFO', 'Status', `Resource URL: ${creds.resource_url || 'N/A'}`);
  log('INFO', 'Status', `Expiry date: ${creds.expiry_date ? new Date(creds.expiry_date).toISOString() : 'N/A'}`);
  log('INFO', 'Status', `Scope: ${creds.scope || 'N/A'}`);
  
  // Check expiry
  if (creds.expiry_date) {
    const isExpired = Date.now() > creds.expiry_date - 30000;
    log('INFO', 'Status', `Expired: ${isExpired}`);
  }
  
  // Resolved base URL
  const baseUrl = resolveBaseUrl(creds.resource_url);
  log('INFO', 'Status', `Resolved baseURL: ${baseUrl}`);
}

async function debugTokenValidity(): Promise<void> {
  log('INFO', 'Validate', '=== Validating Token (Endpoint Test) ===');
  
  const creds = loadCredentials();
  
  if (!creds || !creds.access_token) {
    log('FAIL', 'Validate', 'Nenhuma credential encontrada');
    return;
  }
  
  log('DEBUG', 'Validate', `Testing token against: /chat/completions`);
  
  try {
    const baseUrl = resolveBaseUrl(creds.resource_url);
    const url = `${baseUrl}/chat/completions`;
    
    log('DEBUG', 'Validate', `POST ${url}`);
    log('DEBUG', 'Validate', `Model: coder-model`);
    
    const startTime = Date.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${creds.access_token}`,
        ...QWEN_OFFICIAL_HEADERS,
        'X-Metadata': JSON.stringify({
          sessionId: 'debug-validate-' + Date.now(),
          promptId: 'debug-validate-' + Date.now(),
          source: 'opencode-qwencode-auth-debug'
        })
      },
      body: JSON.stringify({
        model: 'coder-model',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      }),
    });
    const elapsed = Date.now() - startTime;
    
    log('INFO', 'Validate', `HTTP ${response.status} - ${elapsed}ms`);
    
    if (response.ok) {
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const reply = data.choices?.[0]?.message?.content ?? 'No content';
      logOk('Validate', `Token VÁLIDO! Resposta: "${reply}"`);
    } else {
      const errorText = await response.text();
      logFail('Validate', `Token inválido ou erro na API: ${response.status}`, errorText);
    }
  } catch (error) {
    logFail('Validate', 'Erro ao validar token', error);
  }
}

async function debugChatValidation(): Promise<void> {
  log('INFO', 'Chat', '=== Testing Real Chat Request ===');
  
  const creds = loadCredentials();
  if (!creds || !creds.access_token) {
    log('FAIL', 'Chat', 'No credentials found');
    return;
  }
  
  const baseUrl = resolveBaseUrl(creds.resource_url);
  const url = `${baseUrl}/chat/completions`;
  
  log('DEBUG', 'Chat', `POST ${url}`);
  log('DEBUG', 'Chat', `Model: coder-model`);
  
  const startTime = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${creds.access_token}`,
      ...QWEN_OFFICIAL_HEADERS,
      'X-Metadata': JSON.stringify({
        sessionId: 'debug-chat-' + Date.now(),
        promptId: 'debug-chat-' + Date.now(),
        source: 'opencode-qwencode-auth-debug'
      })
    },
    body: JSON.stringify({
      model: 'coder-model',
      messages: [{ role: 'user', content: 'Say hi' }],
      max_tokens: 5,
    }),
  });
  const elapsed = Date.now() - startTime;
  
  log('INFO', 'Chat', `HTTP ${response.status} - ${elapsed}ms`);
  
  if (response.ok) {
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const reply = data.choices?.[0]?.message?.content ?? 'No content';
    logOk('Chat', `Token VÁLIDO! Resposta: "${reply}"`);
  } else {
    const error = await response.text();
    logFail('Chat', 'Token inválido ou erro', error);
  }
}

async function debugAuthFlow(): Promise<void> {
  log('INFO', 'OAuth', '=== Full OAuth Flow Test ===');
  log('WARN', 'OAuth', 'ATENÇÃO: Este teste abrirá o navegador e solicitará autenticação!');
  log('INFO', 'OAuth', 'Pressione Ctrl+C para cancelar...');
  
  // Wait 3 seconds before starting
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  try {
    // Generate PKCE
    const { verifier, challenge } = generatePKCE();
    logOk('OAuth', `PKCE gerado: verifier=${truncate(verifier, 16)}`);
    
    // Request device authorization
    log('DEBUG', 'OAuth', 'Solicitando device authorization...');
    const deviceAuth = await requestDeviceAuthorization(challenge);
    logOk('OAuth', `Device code: ${truncate(deviceAuth.device_code, 16)}`);
    logOk('OAuth', `User code: ${deviceAuth.user_code}`);
    logOk('OAuth', `URL: ${deviceAuth.verification_uri_complete}`);
    
    // Open browser
    log('INFO', 'OAuth', 'Abrindo navegador para autenticação...');
    log('INFO', 'OAuth', `Complete a autenticação e aguarde...`);
    
    // Import openBrowser from index.ts logic
    const { spawn } = await import('node:child_process');
    const platform = process.platform;
    const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32' : 'xdg-open';
    const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', deviceAuth.verification_uri_complete] : [deviceAuth.verification_uri_complete];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref?.();
    
    // Poll for token
    const POLLING_MARGIN_MS = 3000;
    const startTime = Date.now();
    const timeoutMs = deviceAuth.expires_in * 1000;
    let interval = 5000;
    let attempts = 0;
    
    log('DEBUG', 'OAuth', 'Iniciando polling...');
    
    while (Date.now() - startTime < timeoutMs) {
      attempts++;
      await new Promise(resolve => setTimeout(resolve, interval + POLLING_MARGIN_MS));
      
      try {
        log('DEBUG', 'OAuth', `Poll attempt #${attempts}...`);
        const tokenResponse = await pollDeviceToken(deviceAuth.device_code, verifier);
        
        if (tokenResponse) {
          logOk('OAuth', 'Token recebido!');
          const credentials = tokenResponseToCredentials(tokenResponse);
          
          logOk('OAuth', `Access token: ${truncate(credentials.accessToken, 20)}`);
          logOk('OAuth', `Refresh token: ${credentials.refreshToken ? truncate(credentials.refreshToken, 20) : 'N/A'}`);
          logOk('OAuth', `Expiry: ${new Date(credentials.expiryDate).toISOString()}`);
          logOk('OAuth', `Resource URL: ${credentials.resourceUrl || 'N/A'}`);
          
          // Save credentials
          log('DEBUG', 'OAuth', 'Salvando credentials...');
          saveCredentials(credentials);
          logOk('OAuth', 'Credentials salvas com sucesso!');
          
          logOk('OAuth', '=== OAuth Flow Test COMPLETO ===');
          return;
        }
      } catch (e) {
        if (e instanceof SlowDownError) {
          interval = Math.min(interval + 5000, 15000);
          log('WARN', 'OAuth', `Slow down - novo interval: ${interval}ms`);
        } else if (!(e instanceof Error) || !e.message.includes('authorization_pending')) {
          logFail('OAuth', 'Erro no polling', e);
          return;
        }
      }
    }
    
    logFail('OAuth', 'Timeout - usuário não completou autenticação');
  } catch (error) {
    logFail('OAuth', 'Erro no fluxo OAuth', error);
  }
}

// ============================================
// Main Entry Point
// ============================================

async function runTest(name: string, testFn: () => Promise<boolean>): Promise<boolean> {
  console.log('');
  console.log('='.repeat(60));
  console.log(`TEST: ${name}`);
  console.log('='.repeat(60));
  
  const result = await testFn();
  console.log('');
  
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'full';
  
  console.log('');
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║         Qwen Auth Plugin - Debug & Test Suite          ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log('');
  
  const results: Record<string, boolean> = {};
  
  switch (command) {
    case 'status':
      debugCurrentStatus();
      break;
      
    case 'validate':
      await debugTokenValidity();
      await debugChatValidation();
      break;
      
    case 'refresh':
      await runTest('Token Refresh', testTokenRefresh);
      break;
      
    case 'oauth':
      await debugAuthFlow();
      break;
      
    case 'pkce':
      results.pkce = await runTest('PKCE Generation', testPKCE);
      break;
      
    case 'device':
      results.device = await runTest('Device Authorization', testDeviceAuthorization);
      break;
      
    case 'credentials':
      results.credentials = await runTest('Credentials Persistence', testCredentialsPersistence);
      break;
      
    case 'baseurl':
      results.baseurl = await runTest('Base URL Resolution', testBaseUrlResolution);
      break;
      
    case 'expiry':
      await runTest('Credentials Expiry', testIsCredentialsExpired);
      break;
      
    case 'retry':
      results.retry = await runTest('Retry Mechanism', testRetryMechanism);
      break;
      
    case 'throttling':
      results.throttling = await runTest('Throttling', testThrottling);
      break;
      
    case 'full':
    default:
      // Run all tests
      results.pkce = await runTest('PKCE Generation', testPKCE);
      results.baseurl = await runTest('Base URL Resolution', testBaseUrlResolution);
      results.credentials = await runTest('Credentials Persistence', testCredentialsPersistence);
      results.expiry = await runTest('Credentials Expiry', testIsCredentialsExpired);
      results.refresh = await runTest('Token Refresh', testTokenRefresh);
      results.retry = await runTest('Retry Mechanism', testRetryMechanism);
      results.throttling = await runTest('Throttling', testThrottling);
      
      log('WARN', 'TestSuite', 'NOTA: Teste de persistência criou tokens FICTÍCIOS');
      log('WARN', 'TestSuite', 'Refresh EXPECTADO para falhar - use "bun run tests/debug.ts oauth" para tokens reais');
      
      console.log('');
      console.log('='.repeat(60));
      console.log('TEST SUMMARY');
      console.log('='.repeat(60));
      console.log(`PKCE Generation: ${results.pkce ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Base URL Resolution: ${results.baseurl ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Credentials Persistence: ${results.credentials ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Credentials Expiry: ${results.expiry ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Token Refresh: ${results.refresh ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Retry Mechanism: ${results.retry ? '✓ PASS' : '✗ FAIL'}`);
      console.log(`Throttling: ${results.throttling ? '✓ PASS' : '✗ FAIL'}`);
      
      const allPassed = Object.values(results).every(r => r);
      console.log('');
      if (allPassed) {
        console.log('✓ ALL TESTS PASSED');
      } else {
        console.log('✗ SOME TESTS FAILED');
      }
      break;
  }
  
  console.log('');
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

/**
 * OAuth 认证提供者
 * 实现基础的 OAuth 2.0 授权码流程 + PKCE
 */

import { spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { URL } from 'node:url';
import type { OAuthTokenStorage } from './OAuthTokenStorage.js';
import type {
  AuthorizationOAuthConfig,
  OAuthConfig,
  OAuthToken,
  OAuthTokenResponse,
  RefreshableOAuthConfig,
} from './types.js';

const REDIRECT_PORT = 7777;
const REDIRECT_PATH = '/oauth/callback';
const DEFAULT_REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}${REDIRECT_PATH}`;
const OAUTH_STATE_TTL_MS = 5 * 60 * 1000;
const HTTP_OK = 200;

export function resolveOAuthRedirectUri(redirectUri?: string): string {
  const url = new URL(redirectUri ?? DEFAULT_REDIRECT_URI);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    url.protocol !== 'http:' ||
    (hostname !== 'localhost' && hostname !== '127.0.0.1' && hostname !== '::1') ||
    url.port !== String(REDIRECT_PORT) ||
    url.pathname !== REDIRECT_PATH ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `OAuth redirectUri must be a loopback URL on port ${REDIRECT_PORT} with path ${REDIRECT_PATH}`,
    );
  }
  return url.toString();
}

/**
 * PKCE 参数
 */
interface PKCEParams {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
}

/**
 * OAuth 认证提供者
 */
export class OAuthProvider {
  private readonly tokenStorage: OAuthTokenStorage;
  private readonly pendingStates = new Map<string, number>();

  constructor(tokenStorage: OAuthTokenStorage) {
    this.tokenStorage = tokenStorage;
  }

  /**
   * 生成 PKCE 参数
   */
  private generatePKCEParams(): PKCEParams {
    // 生成 code verifier (43-128 字符)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');

    // 生成 code challenge (SHA256)
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    // 生成 state (CSRF 保护)
    const state = crypto.randomBytes(16).toString('base64url');

    return { codeVerifier, codeChallenge, state };
  }

  /**
   * 构建授权 URL
   */
  private buildAuthorizationUrl(config: AuthorizationOAuthConfig, pkceParams: PKCEParams): string {
    const redirectUri = resolveOAuthRedirectUri(config.redirectUri);

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      state: pkceParams.state,
      code_challenge: pkceParams.codeChallenge,
      code_challenge_method: 'S256',
    });

    if (config.scopes && config.scopes.length > 0) {
      params.append('scope', config.scopes.join(' '));
    }

    const url = new URL(config.authorizationUrl);
    params.forEach((value, key) => {
      url.searchParams.append(key, value);
    });

    return url.toString();
  }

  /**
   * 启动本地回调服务器
   */
  private async startCallbackServer(expectedState: string, redirectUri: string): Promise<string> {
    const callbackUrl = new URL(redirectUri);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (outcome: { code: string } | { error: unknown }): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        server.close();
        if ('code' in outcome) {
          resolve(outcome.code);
        } else {
          this.pendingStates.delete(expectedState);
          reject(outcome.error);
        }
      };
      const server = http.createServer((req, res) => {
        try {
          if (!req.url) {
            res.writeHead(400);
            res.end('Bad request');
            return;
          }
          const url = new URL(req.url, callbackUrl);

          if (url.pathname !== REDIRECT_PATH) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }

          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            res.writeHead(HTTP_OK, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Authentication failed. You can close this window.');
            finish({ error: new Error(`OAuth error: ${error}`) });
            return;
          }

          if (!code || !state) {
            res.writeHead(400);
            res.end('Missing code or state parameter');
            return;
          }

          if (!this.consumeState(state, expectedState)) {
            res.writeHead(400);
            res.end('Invalid state parameter');
            return;
          }

          // 成功响应
          res.writeHead(HTTP_OK, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body>
                <h1>Authentication Successful!</h1>
                <p>You can close this window and return to Blade.</p>
                <script>window.close();</script>
              </body>
            </html>
          `);

          finish({ code });
        } catch (error) {
          finish({ error });
        }
      });

      server.on('error', (error) => finish({ error }));
      const callbackHostname = callbackUrl.hostname.replace(/^\[|\]$/g, '');
      server.listen(Number(callbackUrl.port), callbackHostname, () => {
        console.log(`[OAuth] Callback server listening on ${callbackHostname}:${callbackUrl.port}`);
      });

      timeout = setTimeout(() => {
        finish({ error: new Error('OAuth callback timeout') });
      }, OAUTH_STATE_TTL_MS);
      timeout.unref?.();
    });
  }

  /**
   * 用授权码换取令牌
   */
  private async exchangeCodeForToken(
    config: AuthorizationOAuthConfig,
    code: string,
    codeVerifier: string,
  ): Promise<OAuthTokenResponse> {
    const redirectUri = resolveOAuthRedirectUri(config.redirectUri);

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
      client_id: config.clientId,
    });

    if (config.clientSecret) {
      params.append('client_secret', config.clientSecret);
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  /**
   * 刷新访问令牌
   */
  async refreshAccessToken(
    config: RefreshableOAuthConfig,
    refreshToken: string,
  ): Promise<OAuthTokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
    });

    if (config.clientSecret) {
      params.append('client_secret', config.clientSecret);
    }

    if (config.scopes && config.scopes.length > 0) {
      params.append('scope', config.scopes.join(' '));
    }

    const response = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Token refresh failed: ${response.status} - ${errorText}`);
    }

    return (await response.json()) as OAuthTokenResponse;
  }

  /**
   * 执行完整的 OAuth 授权流程
   */
  async authenticate(serverName: string, config: OAuthConfig): Promise<OAuthToken> {
    // 验证配置
    if (!config.clientId || !config.authorizationUrl || !config.tokenUrl) {
      throw new Error('Missing required OAuth configuration');
    }
    const authConfig: AuthorizationOAuthConfig = config as AuthorizationOAuthConfig;

    // 生成 PKCE 参数
    const pkceParams = this.generatePKCEParams();
    const redirectUri = resolveOAuthRedirectUri(authConfig.redirectUri);

    // 构建授权 URL
    const authUrl = this.buildAuthorizationUrl(authConfig, pkceParams);
    this.pendingStates.set(pkceParams.state, Date.now() + OAUTH_STATE_TTL_MS);

    console.log('\n[OAuth] Opening browser for authentication...');
    console.log('\nIf the browser does not open automatically, copy and paste this URL:');
    console.log(authUrl);
    console.log('');

    // 启动回调服务器
    const callbackPromise = this.startCallbackServer(pkceParams.state, redirectUri);

    // 尝试打开浏览器
    try {
      await this.openAuthorizationUrl(authUrl);
    } catch (error) {
      console.warn('[OAuth] Failed to open browser automatically:', error);
    }

    // 等待回调
    const code = await callbackPromise;

    console.log('[OAuth] Authorization code received, exchanging for tokens...');

    // 用授权码换取令牌
    const tokenResponse = await this.exchangeCodeForToken(
      authConfig,
      code,
      pkceParams.codeVerifier,
    );

    // 转换为内部令牌格式
    const token: OAuthToken = {
      accessToken: tokenResponse.access_token,
      tokenType: tokenResponse.token_type || 'Bearer',
      refreshToken: tokenResponse.refresh_token,
      scope: tokenResponse.scope,
    };

    if (tokenResponse.expires_in) {
      token.expiresAt = Date.now() + tokenResponse.expires_in * 1000;
    }

    // 保存令牌
    await this.tokenStorage.saveToken(serverName, token, config.clientId, config.tokenUrl);

    console.log('[OAuth] Authentication successful! Token saved.');

    return token;
  }

  /**
   * 打开系统浏览器
   */
  private async openAuthorizationUrl(authUrl: string): Promise<void> {
    const { command, args } = this.getBrowserCommand(authUrl);

    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { stdio: 'ignore' });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          reject(new Error(`Failed to open browser (exit code ${code})`));
        }
      });
    });
  }

  private getBrowserCommand(url: string): { command: string; args: string[] } {
    if (process.platform === 'darwin') {
      return { command: 'open', args: [url] };
    }

    if (process.platform === 'win32') {
      return { command: 'cmd', args: ['/c', 'start', '', url] };
    }

    return { command: 'xdg-open', args: [url] };
  }

  private consumeState(receivedState: string, expectedState: string): boolean {
    const expiresAt = this.pendingStates.get(receivedState);
    if (receivedState !== expectedState || expiresAt === undefined || expiresAt <= Date.now()) {
      if (expiresAt !== undefined && expiresAt <= Date.now()) {
        this.pendingStates.delete(receivedState);
      }
      return false;
    }
    this.pendingStates.delete(receivedState);
    return true;
  }

  /**
   * 获取有效令牌（自动刷新）
   */
  async getValidToken(serverName: string, config: OAuthConfig): Promise<string | null> {
    const credentials = await this.tokenStorage.getCredentials(serverName);

    if (!credentials) {
      return null;
    }

    const { token } = credentials;

    // 检查令牌是否过期
    if (!this.tokenStorage.isTokenExpired(token)) {
      return token.accessToken;
    }

    // 尝试刷新令牌
    if (token.refreshToken && config.clientId && credentials.tokenUrl) {
      try {
        console.log(`[OAuth] Refreshing expired token for server: ${serverName}`);

        const refreshConfig: RefreshableOAuthConfig = {
          ...config,
          clientId: config.clientId,
          tokenUrl: credentials.tokenUrl,
        };

        const newTokenResponse = await this.refreshAccessToken(refreshConfig, token.refreshToken);

        // 更新存储的令牌
        const newToken: OAuthToken = {
          accessToken: newTokenResponse.access_token,
          tokenType: newTokenResponse.token_type,
          refreshToken: newTokenResponse.refresh_token || token.refreshToken,
          scope: newTokenResponse.scope || token.scope,
        };

        if (newTokenResponse.expires_in) {
          newToken.expiresAt = Date.now() + newTokenResponse.expires_in * 1000;
        }

        await this.tokenStorage.saveToken(
          serverName,
          newToken,
          config.clientId,
          credentials.tokenUrl,
        );

        return newToken.accessToken;
      } catch (error) {
        console.error('[OAuth] Failed to refresh token:', error);
        // 删除无效令牌
        await this.tokenStorage.deleteCredentials(serverName);
      }
    }

    return null;
  }
}

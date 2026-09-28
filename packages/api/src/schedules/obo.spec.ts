import { Keyv } from 'keyv';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ParsedServerConfig } from '../mcp/types';
import type { ServerRequest } from '../types/http';
import { createScheduledOboGrantService, createLazyScheduledOboGrantService } from './obo';
import { InMemoryTokenStore, MockKeyv } from '../mcp/__tests__/helpers/oauthTestServer';
import { OboTokenResolutionError, resolveOboToken } from '../mcp/oauth/obo';
import { FlowStateManager } from '../flow/manager';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  encryptV2: jest.fn(async (value: string) => `enc:${value}`),
  decryptV2: jest.fn(async (value: string) => value.replace(/^enc:/, '')),
  getTenantId: jest.fn(() => 'tenant'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const user = {
  id: 'owner',
  tenantId: 'tenant',
  role: 'USER',
  provider: 'openid',
  openidId: 'subject',
  openidIssuer: 'https://login.test/tenant',
} as IUser;
const config: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.test/tools',
  obo: { scopes: 'api://resource/Read' },
  source: 'yaml',
};
const context = {
  scheduleId: 'sched-1',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root',
  invocationMode: 'delegated' as const,
};
const target = { mcpServer: 'Files', scopes: config.obo!.scopes };

function harness() {
  const tokenStore = new InMemoryTokenStore();
  const flow = new FlowStateManager(new MockKeyv() as unknown as Keyv, { ttl: 30000, ci: true });
  const row = {
    id: 'sched-1',
    user: 'owner',
    tenantId: 'tenant',
    agent_id: 'root',
    enabled: false,
    configRevision: 1,
  };
  const requestGrant = jest.fn(
    async (
      _config: unknown,
      grantType: string,
      _params: Record<string, string>,
    ): Promise<{
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    }> =>
      grantType === 'refresh_token'
        ? { access_token: 'fresh-after-12h', refresh_token: 'rotated-refresh', expires_in: 3600 }
        : { access_token: 'first', refresh_token: 'server-scoped-refresh', expires_in: 3600 },
  );
  let allowed = ['Files'];
  let agentAllowed = true;
  let baseAvailable = true;
  let server = config;
  const inspect = jest.fn(async (_agent, _user, _id, _server, onSelected) => onSelected(server));
  const service = createScheduledOboGrantService({
    tokens: tokenStore,
    flowManager: flow,
    getUser: async () => user,
    getSchedule: async () => row,
    getAppConfig: async (options) =>
      options?.baseOnly && !baseAvailable
        ? undefined
        : ({
            mcpConfig: { Files: server },
            interfaceConfig: { schedules: { use: true, oboServers: allowed } },
          } as Partial<AppConfig> as AppConfig),
    ensureConfigServers: async () => ({ Files: server }),
    getServerConfigs: async () => ({ Files: server }),
    agentAccess: async () => (agentAllowed ? 'ok' : 'forbidden'),
    getRoleByName: async () =>
      ({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
          [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true },
          [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        },
      }) as never,
    getOpenIdConfig: () => ({
      clientMetadata: () => ({ client_id: 'client' }),
      serverMetadata: () => ({
        issuer: user.openidIssuer,
        authorization_endpoint: 'https://login.test/authorize',
        token_endpoint: 'https://login.test/token',
      }),
    }),
    requestGrant,
    inspect,
    isOwnerActive: async () => true,
    isOboConfigTrusted: async () => true,
    pauseSchedule: async () => {
      row.enabled = false;
      return row;
    },
  });
  return {
    service,
    tokenStore,
    row,
    requestGrant,
    inspect,
    setAllowed: (names: string[]) => {
      allowed = names;
    },
    setAgentAllowed: (allowed: boolean) => {
      agentAllowed = allowed;
    },
    setBaseAvailable: (available: boolean) => {
      baseAvailable = available;
    },
    setServer: (replacement: ParsedServerConfig) => {
      server = replacement;
    },
  };
}

describe('separately authorized scheduled OBO grants', () => {
  it('does not construct credential storage merely because routes load', async () => {
    const factory = jest.fn(() => harness().service);
    const deferred = createLazyScheduledOboGrantService(factory);
    deferred.setInspector(jest.fn(async () => []));
    expect(factory).not.toHaveBeenCalled();
    await deferred.resolve(user, { context, target });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('never enrolls or returns a token without the explicit live-session step', async () => {
    const { service, requestGrant, tokenStore } = harness();
    const provider = await service.resolve(user, { context, target });
    await expect(provider!()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('stores only the downstream grant and refreshes it after a twelve-hour gap without a browser', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'one-time-upstream-user-assertion');
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: 'api://resource/Read offline_access',
        assertion: 'one-time-upstream-user-assertion',
        requested_token_use: 'on_behalf_of',
      },
    );
    expect(tokenStore.getAll()).toHaveLength(3);
    expect(
      tokenStore.getAll().some((token) => token.token.includes('one-time-upstream-user-assertion')),
    ).toBe(false);
    row.enabled = true;
    const provider = await service.resolve(user, { context, target });
    const exchange = jest.fn();
    const initial = await resolveOboToken(user, config.obo!, exchange, provider!);
    expect(initial.access_token).toBe('first');
    expect(exchange).not.toHaveBeenCalled();
    const access = tokenStore.getAll().find((t) => t.type === 'mcp_oauth')!;
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth', identifier: access.identifier },
      { expiresAt: new Date(Date.now() - 12 * 60 * 60_000) },
    );
    const after = await resolveOboToken(user, config.obo!, exchange, provider!);
    expect(after.access_token).toBe('fresh-after-12h');
    expect(requestGrant).toHaveBeenCalledWith(expect.anything(), 'refresh_token', {
      refresh_token: 'server-scoped-refresh',
      scope: config.obo!.scopes,
    });
    expect(exchange).not.toHaveBeenCalled();
    expect(tokenStore.getAll().find((t) => t.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:rotated-refresh',
    );
  });

  it('rechecks schedule, agent, scope and allowlist at every use; revoke makes future use impossible', async () => {
    const { service, row, setAllowed, setServer, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'user-assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).resolves.toMatchObject({ scheduledObo: true, access_token: 'first' });
    setAllowed([]);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAllowed(['Files']);
    setServer({ ...config, obo: { scopes: 'api://resource/Write' } });
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setServer(config);
    row.agent_id = 'different';
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    row.agent_id = 'root';
    await service.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('fails closed on revoked root-agent access and the missing base schedule policy', async () => {
    const { service, row, setAgentAllowed, setBaseAvailable } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    setAgentAllowed(false);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAgentAllowed(true);
    setBaseAvailable(false);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('keeps a transient credential-store read retryable instead of revoking the schedule', async () => {
    const { service, row, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    const lookup = jest
      .spyOn(tokenStore, 'findToken')
      .mockRejectedValueOnce(new Error('store down'));
    await expect(provider()).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
    });
    lookup.mockRestore();
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
  });

  it('refuses enrollment if the live OpenID session does not match the persisted owner', async () => {
    const { service, requestGrant } = harness();
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    const request = {
      user,
      params: { id: 'sched-1', server: 'Files' },
      session: {
        openidTokens: {
          appUserId: 'other',
          openidSubject: 'subject',
          openidIssuer: user.openidIssuer,
          tenantId: 'tenant',
          accessToken: 'bearer',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    } as unknown as ServerRequest;
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('rejects an enrollment finishing after the owner deletes the schedule', async () => {
    const { service, tokenStore, requestGrant } = harness();
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    requestGrant.mockImplementationOnce(async () => {
      started();
      await blocked;
      return { access_token: 'late', refresh_token: 'late-secret', expires_in: 3600 };
    });
    const enrolling = service.enroll(user.id, context.scheduleId, 'Files', 'assertion');
    await entered;
    await service.purge(user.id, context.scheduleId);
    unblock();
    await expect(enrolling).rejects.toThrow();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('coalesces simultaneous expired-grant reads instead of replaying a rotating refresh token', async () => {
    const { service, row, tokenStore, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const old = tokenStore.getAll().find((record) => record.type === 'mcp_oauth')!;
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth', identifier: old.identifier },
      { expiresAt: new Date(Date.now() - 12 * 60 * 60_000) },
    );
    const [first, second] = await Promise.all([
      service.resolve(user, { context, target }),
      service.resolve(user, { context, target }),
    ]);
    await expect(Promise.all([first!(), second!()])).resolves.toEqual([
      expect.objectContaining({ access_token: 'fresh-after-12h' }),
      expect.objectContaining({ access_token: 'fresh-after-12h' }),
    ]);
    expect(requestGrant.mock.calls.filter(([, type]) => type === 'refresh_token')).toHaveLength(1);
  });

  it('retains a non-rotating provider refresh token after a subsequent access renewal', async () => {
    const { service, row, tokenStore, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    requestGrant.mockResolvedValueOnce({ access_token: 'fresh', expires_in: 3600 });
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
      access_token: 'fresh',
      scheduledObo: true,
    });
    expect(tokenStore.getAll().find((token) => token.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:server-scoped-refresh',
    );
    await expect(provider()).resolves.toMatchObject({ access_token: 'fresh' });
  });

  it('enrolls only when the signed-in session proves the owner and sends just its access token', async () => {
    const { service, requestGrant } = harness();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
    } as unknown as Response;
    const request = {
      user,
      params: { id: 'sched-1', server: 'Files' },
      body: { expectedScopes: 'api://resource/Read' },
      session: {
        openidTokens: {
          appUserId: 'owner',
          openidSubject: 'subject',
          openidIssuer: user.openidIssuer,
          tenantId: 'tenant',
          accessToken: 'one-time-access',
          refreshToken: 'browser-login-secret',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    } as unknown as ServerRequest;
    await service.describeFromRequest(request, response);
    expect(response.json).toHaveBeenCalledWith({
      server: 'Files',
      scopes: 'api://resource/Read',
      url: config.url,
    });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(204);
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ assertion: 'one-time-access' }),
    );
    expect(JSON.stringify(requestGrant.mock.calls)).not.toContain('browser-login-secret');
    Object.assign(request.body, { expectedScopes: 'api://resource/Write' });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenLastCalledWith(400);
    expect(requestGrant).toHaveBeenCalledTimes(1);
  });

  it('rejects an OBO server that did not issue an offline refresh token', async () => {
    const { service, requestGrant, tokenStore } = harness();
    requestGrant.mockResolvedValueOnce({ access_token: 'first', expires_in: 3600 });
    await expect(
      service.enroll(user.id, context.scheduleId, 'Files', 'assertion'),
    ).rejects.toBeInstanceOf(OboTokenResolutionError);
    expect(tokenStore.getAll()).toHaveLength(0);
  });
});

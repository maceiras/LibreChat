import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { logger, getTenantId, isRuntimeDisabled } from '@librechat/data-schemas';
import type { IUser, TokenMethods, AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { HostUpstreamTokenProviderResolver } from './mcp';
import type { UpstreamTokenTarget } from '../mcp/oauth/obo';
import type { GetAppConfigOptions } from '../app/service';
import type { MCPOAuthTokens } from '../mcp/oauth/types';
import type { FlowStateManager } from '../flow/manager';
import type { ParsedServerConfig } from '../mcp/types';
import type { ScheduledTokenContext } from './context';
import type { ScheduleMCPPreflight } from './types';
import type { ServerRequest } from '../types/http';
import {
  MCPTokenStorage,
  getMCPOAuthLeaseId,
  MCPTokenRefreshUnavailableError,
  ReauthenticationRequiredError,
} from '../mcp/oauth/tokens';
import { OboTokenResolutionError, isRetryableOboExchangeError } from '../mcp/oauth/obo';
import { getAppConfigOptionsFromUser } from '../app/service';
import { checkAccess } from '../middleware/access';
import { isEnabled } from '../utils/common';
import { ScheduleMCPError } from './mcp';

interface ScheduleGrantRow {
  id: string;
  user: string | { toString(): string };
  tenantId?: string;
  agent_id: string;
  enabled: boolean;
  configRevision?: number;
}
interface OpenIdConfig {
  clientMetadata: () => { client_id?: string };
  serverMetadata: () => {
    issuer?: string;
    token_endpoint?: string;
    authorization_endpoint?: string;
  };
}
interface GrantProvider {
  clientId: string;
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  exchange: (assertion: string, scopes: string) => Promise<GrantResponse>;
  refresh: (refreshToken: string, scopes: string) => Promise<GrantResponse>;
}
interface GrantResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}
interface GrantDeps {
  tokens: Pick<TokenMethods, 'findToken' | 'createToken' | 'updateToken' | 'deleteTokens'>;
  flowManager: Pick<FlowStateManager<MCPOAuthTokens | null>, 'getLeaseGeneration' | 'acquireLease'>;
  getUser: (id: string) => Promise<IUser | null>;
  getSchedule: (id: string, userId: string) => Promise<ScheduleGrantRow | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig | undefined>;
  ensureConfigServers: (
    config: NonNullable<AppConfig['mcpConfig']>,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getServerConfigs: (
    userId: string,
    config: Record<string, ParsedServerConfig>,
    role?: string,
  ) => Promise<Record<string, ParsedServerConfig>>;
  getRoleByName: Parameters<typeof checkAccess>[0]['getRoleByName'];
  agentAccess: (agentId: string, user: IUser) => Promise<'ok' | 'missing' | 'forbidden'>;
  getOpenIdConfig: () => OpenIdConfig | null;
  requestGrant: (
    config: OpenIdConfig,
    grantType: string,
    parameters: Record<string, string>,
  ) => Promise<GrantResponse>;
  inspect?: (
    agentId: string,
    user: IUser,
    scheduleId: string,
    serverName: string,
    onSelected: (config: ParsedServerConfig) => Promise<void>,
  ) => Promise<void>;
  isOwnerActive: (id: string) => Promise<boolean>;
  pauseSchedule: (
    scheduleId: string,
    userId: string,
    revision?: number,
  ) => Promise<ScheduleGrantRow | null>;
  isOboConfigTrusted: (config: ParsedServerConfig) => Promise<boolean>;
}

/** Distinct namespace from direct MCP OAuth. Neither a login refresh token nor
 * another schedule's downstream grant can satisfy this credential lookup. */
export const scheduledOboGrantKey = (scheduleId: string, serverName: string): string =>
  `schedule-obo:${scheduleId}:${serverName}`;

const scheduleGrantLeaseId = (userId: string, scheduleId: string): string =>
  JSON.stringify(['scheduled-obo', getTenantId() ?? '', userId, scheduleId]);

function missingGrant(): OboTokenResolutionError {
  return new OboTokenResolutionError(
    'missing_upstream_provider',
    'Authorize this OBO server separately for this schedule before unattended use.',
  );
}

function expiresInSeconds(tokens: GrantResponse): number {
  const value = tokens.expires_in;
  if (!Number.isSafeInteger(value) || value == null || value <= 30) {
    throw new MCPTokenRefreshUnavailableError('schedule-obo', new Error('No usable token expiry'));
  }
  return value;
}

function metadata(record: { metadata?: Map<string, unknown> }): Record<string, unknown> {
  return record.metadata instanceof Map
    ? Object.fromEntries(record.metadata)
    : (record.metadata ?? {});
}

export interface ScheduledOboGrantService {
  resolve: HostUpstreamTokenProviderResolver;
  enroll: (
    userId: string,
    scheduleId: string,
    serverName: string,
    accessToken: string,
  ) => Promise<void>;
  revoke: (userId: string, scheduleId: string, serverName: string) => Promise<void>;
  enrollFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  describeFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  revokeFromRequest: (req: ServerRequest, res: Response) => Promise<void>;
  purge: (userId: string, scheduleId: string) => Promise<void>;
  setInspector: (preflight: ScheduleMCPPreflight) => void;
}

export function createScheduledOboGrantService(deps: GrantDeps): ScheduledOboGrantService {
  const { tokens } = deps;
  let inspect = deps.inspect;
  const setInspector = (preflight: ScheduleMCPPreflight): void => {
    inspect = async (agentId, user, scheduleId, serverName, onSelected) => {
      await preflight(agentId, user, {
        scheduleId,
        concurrency: 3,
        inspectOboTarget: { serverName, onSelected },
      });
    };
  };
  const inspectTarget: NonNullable<GrantDeps['inspect']> = async (...args) => {
    if (!inspect) throw new Error('Scheduled OBO inspector is not installed');
    return inspect(...args);
  };

  const getPolicy = async (user: IUser) => {
    const [app, base] = await Promise.all([
      deps.getAppConfig({ ...getAppConfigOptionsFromUser(user), failClosed: true }),
      deps.getAppConfig({ baseOnly: true, failClosed: true }),
    ]);
    const policy = app?.interfaceConfig?.schedules;
    const active =
      base != null &&
      !isRuntimeDisabled(base.interfaceConfig?.schedules) &&
      !isEnabled(process.env.SCHEDULES_DISABLED) &&
      policy != null &&
      policy !== false &&
      (policy === true || policy.use !== false);
    return {
      enabled: active,
      oboServers: policy && typeof policy === 'object' ? policy.oboServers : undefined,
    };
  };
  const getProvider = (): GrantProvider | null => {
    const config = deps.getOpenIdConfig();
    if (!config) return null;
    const issuer = config.serverMetadata();
    const clientId = config.clientMetadata().client_id;
    if (!clientId || !issuer.issuer || !issuer.token_endpoint || !issuer.authorization_endpoint)
      return null;
    return {
      clientId,
      issuer: issuer.issuer,
      tokenEndpoint: issuer.token_endpoint,
      authorizationEndpoint: issuer.authorization_endpoint,
      exchange: (assertion, scopes) =>
        deps.requestGrant(config, 'urn:ietf:params:oauth:grant-type:jwt-bearer', {
          scope: scopes,
          assertion,
          requested_token_use: 'on_behalf_of',
        }),
      refresh: (refreshToken, scopes) =>
        deps.requestGrant(config, 'refresh_token', { refresh_token: refreshToken, scope: scopes }),
    };
  };

  const getServer = async (user: IUser, name: string) => {
    const appConfig = await deps.getAppConfig({
      ...getAppConfigOptionsFromUser(user),
      failClosed: true,
    });
    if (!appConfig) throw new Error('Principal MCP configuration is unavailable');
    const raw = appConfig.mcpConfig?.[name];
    const parsed = raw ? await deps.ensureConfigServers({ [name]: raw }) : {};
    return (await deps.getServerConfigs(user.id, parsed, user.role))[name];
  };

  const validate = async (
    userId: string,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
    allowDisabled = false,
  ) => {
    if (context.ownerId !== userId || context.invocationMode !== 'delegated') throw missingGrant();
    const [user, schedule, ownerActive] = await Promise.all([
      deps.getUser(userId),
      deps.getSchedule(context.scheduleId, userId),
      deps.isOwnerActive(userId),
    ]);
    if (
      !ownerActive ||
      !user ||
      !schedule ||
      String(schedule.user) !== userId ||
      user.tenantId !== context.tenantId ||
      schedule.tenantId !== context.tenantId ||
      schedule.agent_id !== context.agentId ||
      (!allowDisabled && !schedule.enabled) ||
      !user.openidId ||
      !user.openidIssuer
    )
      throw missingGrant();
    if (user.id && user.id !== userId) throw missingGrant();
    user.id = userId;
    const roleLookup = user.role ? deps.getRoleByName(user.role) : Promise.resolve(null);
    const getRoleByName: typeof deps.getRoleByName = () => roleLookup;
    const [limits, mcpAccess, scheduleAccess, agentAccess, rootAccess, config] = await Promise.all([
      getPolicy(user),
      checkAccess({
        user,
        permissionType: PermissionTypes.MCP_SERVERS,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      checkAccess({
        user,
        permissionType: PermissionTypes.SCHEDULES,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      checkAccess({
        user,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      }),
      deps.agentAccess(context.agentId, user),
      getServer(user, target.mcpServer),
    ]);
    if (
      !limits.enabled ||
      !limits.oboServers?.includes(target.mcpServer) ||
      !mcpAccess ||
      !scheduleAccess ||
      !agentAccess ||
      rootAccess !== 'ok' ||
      !config?.obo?.scopes ||
      config.obo.scopes !== target.scopes ||
      config.source === 'user' ||
      (config.dbId && config.source !== 'config') ||
      !(await deps.isOboConfigTrusted(config))
    )
      throw missingGrant();
    const provider = getProvider();
    if (
      !provider?.clientId ||
      !provider.issuer ||
      !provider.tokenEndpoint ||
      !provider.authorizationEndpoint
    )
      throw missingGrant();
    return { user, schedule, config, provider };
  };

  const read = async (
    userId: string,
    context: ScheduledTokenContext,
    target: UpstreamTokenTarget,
    forceRefresh = false,
  ): Promise<MCPOAuthTokens> => {
    let authorized: Awaited<ReturnType<typeof validate>>;
    try {
      authorized = await validate(userId, context, target);
    } catch (error) {
      if (error instanceof OboTokenResolutionError) throw error;
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary scheduled OBO authorization failure.',
        true,
      );
    }
    const { user, config, provider } = authorized;
    const key = scheduledOboGrantKey(context.scheduleId, target.mcpServer);
    const identifier = `mcp:${key}`;
    let refreshRecord: Awaited<ReturnType<typeof tokens.findToken>>;
    let client: Awaited<ReturnType<typeof MCPTokenStorage.getClientInfoAndMetadata>>;
    try {
      [refreshRecord, client] = await Promise.all([
        tokens.findToken({
          userId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
        }),
        MCPTokenStorage.getClientInfoAndMetadata({
          userId,
          serverName: key,
          findToken: tokens.findToken,
        }),
      ]);
    } catch {
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary scheduled OBO credential-store failure.',
        true,
      );
    }
    const binding = client?.clientMetadata;
    const generation = refreshRecord && metadata(refreshRecord).credential_set_id;
    if (
      !refreshRecord ||
      !client ||
      !generation ||
      generation !== binding?.credential_set_id ||
      refreshRecord.expiresAt <= new Date() ||
      client.clientInfo.client_id !== provider.clientId ||
      (client.clientInfo as typeof client.clientInfo & { scope?: string }).scope !==
        `${target.scopes} offline_access` ||
      binding?.server_url !== config.url ||
      binding?.issuer !== provider.issuer ||
      binding?.token_endpoint !== provider.tokenEndpoint ||
      binding?.openid_subject !== user.openidId ||
      binding?.openid_issuer !== user.openidIssuer ||
      binding?.tenant_id !== (user.tenantId ?? '')
    )
      throw missingGrant();
    const refreshTokens = async (secret: string): Promise<MCPOAuthTokens> => {
      let next: GrantResponse;
      try {
        next = await provider.refresh(secret, target.scopes);
      } catch (error) {
        if (isRetryableOboExchangeError(error))
          throw new MCPTokenRefreshUnavailableError(key, error);
        throw error;
      }
      if (!next.access_token)
        throw new MCPTokenRefreshUnavailableError(key, new Error('No access token'));
      return {
        access_token: next.access_token,
        ...(next.refresh_token ? { refresh_token: next.refresh_token } : {}),
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + expiresInSeconds(next) * 1000,
      };
    };
    try {
      const params = {
        userId,
        serverName: key,
        findToken: tokens.findToken,
        createToken: tokens.createToken,
        updateToken: tokens.updateToken,
        deleteTokens: tokens.deleteTokens,
        flowManager: deps.flowManager,
        coordinateRefresh: true,
        refreshTokens,
      };
      let result = forceRefresh
        ? await MCPTokenStorage.forceRefreshTokens(params)
        : await MCPTokenStorage.getTokens(params);
      if (result?.expires_at && result.expires_at - Date.now() < 45_000 && !forceRefresh) {
        result = await MCPTokenStorage.forceRefreshTokens(params);
      }
      if (!result?.access_token || !result.expires_at || result.expires_at <= Date.now())
        throw missingGrant();
      return result;
    } catch (error) {
      if (error instanceof ReauthenticationRequiredError) throw missingGrant();
      if (error instanceof MCPTokenRefreshUnavailableError) {
        throw new OboTokenResolutionError(
          'session_refresh_failed',
          'Temporary OBO grant refresh failure.',
          true,
        );
      }
      if (error instanceof OboTokenResolutionError) throw error;
      logger.warn('[schedules] scheduled OBO credential read failed', { error });
      throw new OboTokenResolutionError(
        'session_refresh_failed',
        'Temporary OBO credential failure.',
        true,
      );
    }
  };

  const resolve: HostUpstreamTokenProviderResolver = async (user, { context, target }) => {
    if (!context || !target || user.id !== context.ownerId) return undefined;
    return async ({ forceRefresh } = {}) => {
      const result = await read(user.id, context, target, forceRefresh);
      return {
        scheduledObo: true,
        access_token: result.access_token,
        expires_at: Math.floor(result.expires_at! / 1000),
      };
    };
  };

  const enroll = async (
    userId: string,
    scheduleId: string,
    serverName: string,
    accessToken: string,
    expectedScopes?: string,
  ): Promise<void> => {
    const scheduleLease = scheduleGrantLeaseId(userId, scheduleId);
    const scheduleGeneration = await deps.flowManager.getLeaseGeneration(scheduleLease);
    if (scheduleGeneration == null)
      throw new MCPTokenRefreshUnavailableError(
        scheduledOboGrantKey(scheduleId, serverName),
        new Error('Schedule grant teardown in progress'),
      );
    const [user, schedule] = await Promise.all([
      deps.getUser(userId),
      deps.getSchedule(scheduleId, userId),
    ]);
    if (
      !user ||
      !schedule ||
      String(schedule.user) !== userId ||
      (user.id && user.id !== userId) ||
      !user.openidId ||
      !accessToken
    )
      throw missingGrant();
    user.id = userId;
    const context: ScheduledTokenContext = {
      scheduleId,
      ownerId: userId,
      tenantId: user.tenantId,
      agentId: schedule.agent_id,
      invocationMode: 'delegated',
    };
    await inspectTarget(schedule.agent_id, user, scheduleId, serverName, async (selected) => {
      if (
        !selected.obo?.scopes ||
        (expectedScopes != null && selected.obo.scopes !== expectedScopes)
      )
        throw missingGrant();
      const target = { mcpServer: serverName, scopes: selected.obo.scopes };
      const { config, provider } = await validate(userId, context, target, true);
      const key = scheduledOboGrantKey(scheduleId, serverName);
      const leaseId = getMCPOAuthLeaseId(userId, key);
      const generation = await deps.flowManager.getLeaseGeneration(leaseId);
      if (generation == null)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Grant teardown in progress'));
      if (config.url !== selected.url || config.obo?.scopes !== selected.obo.scopes)
        throw missingGrant();
      let response: GrantResponse;
      try {
        response = await provider.exchange(accessToken, `${target.scopes} offline_access`);
      } catch (error) {
        if (isRetryableOboExchangeError(error))
          throw new MCPTokenRefreshUnavailableError(key, error);
        throw missingGrant();
      }
      if (!response.access_token || !response.refresh_token) throw missingGrant();
      let expiresIn: number;
      try {
        expiresIn = expiresInSeconds(response);
      } catch {
        throw missingGrant();
      }
      // The token was issued for the downstream MCP resource, not for LibreChat's
      // login session. Persist only this separately requested OBO refresh grant.
      const metadata = {
        issuer: provider.issuer,
        authorization_endpoint: provider.authorizationEndpoint,
        token_endpoint: provider.tokenEndpoint,
        server_url: config.url!,
        client_source: 'configured' as const,
        openid_subject: user.openidId,
        openid_issuer: user.openidIssuer,
        tenant_id: user.tenantId ?? '',
      };
      const scheduleLock = await deps.flowManager.acquireLease(scheduleLease, {
        expectedGeneration: scheduleGeneration,
      });
      if (!scheduleLock)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Schedule grant changed'));
      try {
        const lease = await deps.flowManager.acquireLease(leaseId, {
          expectedGeneration: generation,
        });
        if (!lease)
          throw new MCPTokenRefreshUnavailableError(key, new Error('Grant is being changed'));
        try {
          const fresh = await deps.getSchedule(scheduleId, userId);
          if (
            !fresh ||
            fresh.configRevision !== schedule.configRevision ||
            fresh.agent_id !== schedule.agent_id ||
            fresh.tenantId !== user.tenantId
          )
            throw missingGrant();
          const clientInfo = {
            client_id: provider.clientId,
            scope: `${target.scopes} offline_access`,
          };
          await MCPTokenStorage.storeTokens({
            userId,
            serverName: key,
            tokens: {
              access_token: response.access_token,
              refresh_token: response.refresh_token,
              token_type: 'Bearer',
              expires_in: expiresIn,
            },
            clientInfo,
            metadata,
            createToken: tokens.createToken,
            findToken: tokens.findToken,
            updateToken: tokens.updateToken,
            deleteTokens: tokens.deleteTokens,
          });
        } finally {
          await lease.release();
        }
      } finally {
        await scheduleLock.release();
      }
    });
  };

  const revoke = async (userId: string, scheduleId: string, serverName: string) => {
    const schedule = await deps.getSchedule(scheduleId, userId);
    if (!schedule || String(schedule.user) !== userId) throw missingGrant();
    if (
      schedule.enabled &&
      !(await deps.pauseSchedule(scheduleId, userId, schedule.configRevision))
    ) {
      throw new MCPTokenRefreshUnavailableError(
        scheduledOboGrantKey(scheduleId, serverName),
        new Error('Schedule changed during revocation'),
      );
    }
    const key = scheduledOboGrantKey(scheduleId, serverName);
    const release = await MCPTokenStorage.beginRefreshTeardown(userId, key);
    const leaseId = getMCPOAuthLeaseId(userId, key);
    try {
      const generation = await deps.flowManager.getLeaseGeneration(leaseId);
      if (generation == null)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Grant teardown in progress'));
      const lease = await deps.flowManager.acquireLease(leaseId, {
        expectedGeneration: generation,
        advanceGeneration: true,
      });
      if (!lease)
        throw new MCPTokenRefreshUnavailableError(key, new Error('Grant is being changed'));
      try {
        await MCPTokenStorage.deleteUserTokens({
          userId,
          serverName: key,
          deleteToken: async (filter) => {
            await tokens.deleteTokens(filter);
          },
        });
      } finally {
        await lease.release();
      }
    } finally {
      release();
    }
  };

  const enrollFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    const session = (
      req.session as
        | (typeof req.session & {
            openidTokens?: {
              appUserId?: string;
              openidSubject?: string;
              openidIssuer?: string;
              tenantId?: string;
              accessToken?: string;
              accessTokenExpiresAt?: number;
            };
          })
        | undefined
    )?.openidTokens;
    let user: IUser | null = null;
    try {
      user = userId ? await deps.getUser(userId) : null;
    } catch {
      res.status(503).json({ error: 'Scheduled OBO authorization unavailable. Try again later.' });
      return;
    }
    if (
      !user ||
      !user.openidId ||
      !user.openidIssuer ||
      !session ||
      session.appUserId !== userId ||
      session.openidSubject !== user.openidId ||
      session.openidIssuer !== user.openidIssuer ||
      session.tenantId !== user.tenantId ||
      !session.accessToken ||
      !session.accessTokenExpiresAt ||
      session.accessTokenExpiresAt <= Math.floor(Date.now() / 1000) + 30
    ) {
      res
        .status(401)
        .json({ error: 'Sign in with a live OpenID session to authorize scheduled OBO' });
      return;
    }
    try {
      const expectedScopes = (
        req.body as (typeof req.body & { expectedScopes?: string }) | undefined
      )?.expectedScopes;
      if (!expectedScopes || expectedScopes.length > 2048) {
        res.status(400).json({ error: 'Confirm the current OBO scopes before authorizing' });
        return;
      }
      await enroll(userId!, scheduleId, serverName, session.accessToken, expectedScopes);
      res.status(204).end();
    } catch (error) {
      if (
        (error instanceof OboTokenResolutionError && !error.retryable) ||
        (error instanceof ScheduleMCPError && error.code !== 'mcp_unavailable')
      ) {
        res.status(400).json({ error: 'This schedule or OBO server cannot be authorized offline' });
      } else {
        res
          .status(503)
          .json({ error: 'Scheduled OBO authorization unavailable. Try again later.' });
      }
    }
  };
  const describeFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    if (!userId) {
      res.status(401).end();
      return;
    }
    try {
      const [user, schedule] = await Promise.all([
        deps.getUser(userId),
        deps.getSchedule(scheduleId, userId),
      ]);
      if (!user || !schedule || String(schedule.user) !== userId) throw missingGrant();
      user.id = userId;
      await inspectTarget(schedule.agent_id, user, scheduleId, serverName, async (selected) => {
        if (!selected.obo?.scopes) throw missingGrant();
        const context: ScheduledTokenContext = {
          scheduleId,
          ownerId: userId,
          tenantId: user.tenantId,
          agentId: schedule.agent_id,
          invocationMode: 'delegated',
        };
        const target = { mcpServer: serverName, scopes: selected.obo.scopes };
        const { config } = await validate(userId, context, target, true);
        if (config.url !== selected.url) throw missingGrant();
        res.json({ server: serverName, scopes: target.scopes, url: config.url });
      });
    } catch (error) {
      if (error instanceof OboTokenResolutionError || error instanceof ScheduleMCPError) {
        res.status(400).json({ error: 'This agent cannot authorize the requested OBO server' });
      } else {
        res.status(503).json({ error: 'Could not inspect scheduled OBO authorization' });
      }
    }
  };

  const revokeFromRequest = async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { id: scheduleId, server: serverName } = req.params as { id: string; server: string };
    if (!userId) {
      res.status(401).end();
      return;
    }
    try {
      await revoke(userId, scheduleId, serverName);
      res.status(204).end();
    } catch {
      res.status(503).json({ error: 'Scheduled OBO grant could not be revoked. Try again.' });
    }
  };

  const purge = async (userId: string, scheduleId: string): Promise<void> => {
    const leaseId = scheduleGrantLeaseId(userId, scheduleId);
    const generation = await deps.flowManager.getLeaseGeneration(leaseId);
    if (generation == null) throw new Error('Scheduled OBO grant cleanup is in progress');
    const lease = await deps.flowManager.acquireLease(leaseId, {
      expectedGeneration: generation,
      advanceGeneration: true,
    });
    if (!lease) throw new Error('Scheduled OBO grant cleanup is in progress');
    try {
      const escaped = scheduleId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await tokens.deleteTokens({
        userId,
        identifier: new RegExp(`^mcp:schedule-obo:${escaped}:`),
      });
    } finally {
      await lease.release();
    }
  };

  return {
    resolve,
    enroll,
    revoke,
    enrollFromRequest,
    describeFromRequest,
    revokeFromRequest,
    purge,
    setInspector,
  };
}

/** Keep the scheduled credential host out of ordinary API startup paths. Existing
 * Schedules/index uses the same lazily constructed service pattern. */
export function createLazyScheduledOboGrantService(
  factory: () => ScheduledOboGrantService,
): ScheduledOboGrantService {
  let instance: ScheduledOboGrantService | undefined;
  let inspector: ScheduleMCPPreflight | undefined;
  const get = (): ScheduledOboGrantService => {
    if (!instance) {
      instance = factory();
      if (inspector) instance.setInspector(inspector);
    }
    return instance;
  };
  return {
    setInspector: (preflight) => {
      inspector = preflight;
      instance?.setInspector(preflight);
    },
    resolve: (...args) => get().resolve(...args),
    enroll: (...args) => get().enroll(...args),
    revoke: (...args) => get().revoke(...args),
    enrollFromRequest: (...args) => get().enrollFromRequest(...args),
    describeFromRequest: (...args) => get().describeFromRequest(...args),
    revokeFromRequest: (...args) => get().revokeFromRequest(...args),
    purge: (...args) => get().purge(...args),
  };
}

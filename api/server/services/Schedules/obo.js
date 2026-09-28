const client = require('openid-client');
const {
  createLazyScheduledOboGrantService,
  createScheduledOboGrantService,
} = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { getMCPServersRegistry, getFlowStateManager } = require('~/config');
const { getAppConfig } = require('~/server/services/Config/app');
const { getOpenIdConfig } = require('~/strategies/openidStrategy');
const { resolveAgentFireAccess } = require('./access');
const { createOboTrustChecker } = require('~/server/services/OboPolicyService');
const { getLogStores } = require('~/cache');
const methods = require('~/models');

module.exports = createLazyScheduledOboGrantService(() =>
  createScheduledOboGrantService({
    tokens: {
      findToken: methods.findToken,
      createToken: methods.createToken,
      updateToken: methods.updateToken,
      deleteTokens: methods.deleteTokens,
    },
    flowManager: getFlowStateManager(getLogStores(CacheKeys.FLOWS)),
    getUser: (id) => methods.findUser({ _id: id }),
    getSchedule: (id, userId) => methods.getScheduleById(id, userId),
    getAppConfig,
    ensureConfigServers: (config) => getMCPServersRegistry().ensureConfigServers(config),
    getServerConfigs: (userId, config, role) =>
      getMCPServersRegistry().getAllServerConfigs(userId, config, role),
    getRoleByName: methods.getRoleByName,
    agentAccess: resolveAgentFireAccess,
    getOpenIdConfig,
    isLiveAccessTokenValid: require('~/server/services/OpenIDSessionRefresh')
      .isLiveAccessTokenValid,
    requestGrant: (config, type, parameters) =>
      client.genericGrantRequest(config, type, parameters),
    isOwnerActive: methods.isAgentTriggerPrincipalActive,
    pauseSchedule: (id, userId, revision) =>
      methods.updateScheduleById(id, userId, { enabled: false }, undefined, {
        expectedConfigRevision: revision,
      }),
    isOboConfigTrusted: (config) => createOboTrustChecker()(config),
  }),
);

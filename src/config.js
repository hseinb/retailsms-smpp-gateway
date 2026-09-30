// Configuration Loader: Environment Variables + Persistent DB Settings
require('dotenv').config();
const db = require('./db');

const DEFAULTS = {
  HTTP_PORT: 3000,
  DEFAULT_SENDER: 'RetailAlert',
  SMPP_HOST: '127.0.0.1',
  SMPP_PORT: 2775,
  SMPP_SYSTEM_ID: 'test_client',
  SMPP_PASSWORD: 'test_password',
  SMPP_SYSTEM_TYPE: '',
  SMPP_BIND_MODE: 'transceiver', // 'transceiver' | 'transmitter' | 'receiver'
  SMPP_SOURCE_TON: 5,            // 5 = Alphanumeric, 1 = International, 0 = Unknown
  SMPP_SOURCE_NPI: 0,            // 0 = Unknown, 1 = ISDN/telephone
  SMPP_DEST_TON: 1,              // 1 = International
  SMPP_DEST_NPI: 1,              // 1 = ISDN/telephone
  SMPP_TPS_LIMIT: 10,            // Max messages per second
  SMPP_KEEPALIVE_INTERVAL: 30,   // In seconds
  SMPP_AUTO_CONNECT: false,
  SIMULATOR_PORT: 2775,
  SIMULATOR_ENABLED: false
};

function getActiveConfig() {
  const dbSettings = db.getAllSettings();

  return {
    port: parseInt(process.env.PORT || dbSettings.HTTP_PORT || DEFAULTS.HTTP_PORT, 10),
    defaultSender: dbSettings.DEFAULT_SENDER || process.env.DEFAULT_SENDER || DEFAULTS.DEFAULT_SENDER,
    smpp: {
      host: dbSettings.SMPP_HOST || process.env.SMPP_HOST || DEFAULTS.SMPP_HOST,
      port: parseInt(dbSettings.SMPP_PORT || process.env.SMPP_PORT || DEFAULTS.SMPP_PORT, 10),
      systemId: dbSettings.SMPP_SYSTEM_ID || process.env.SMPP_SYSTEM_ID || DEFAULTS.SMPP_SYSTEM_ID,
      password: dbSettings.SMPP_PASSWORD || process.env.SMPP_PASSWORD || DEFAULTS.SMPP_PASSWORD,
      systemType: dbSettings.SMPP_SYSTEM_TYPE !== undefined ? dbSettings.SMPP_SYSTEM_TYPE : (process.env.SMPP_SYSTEM_TYPE || DEFAULTS.SMPP_SYSTEM_TYPE),
      bindMode: dbSettings.SMPP_BIND_MODE || process.env.SMPP_BIND_MODE || DEFAULTS.SMPP_BIND_MODE,
      sourceTon: parseInt(dbSettings.SMPP_SOURCE_TON !== undefined ? dbSettings.SMPP_SOURCE_TON : (process.env.SMPP_SOURCE_TON || DEFAULTS.SMPP_SOURCE_TON), 10),
      sourceNpi: parseInt(dbSettings.SMPP_SOURCE_NPI !== undefined ? dbSettings.SMPP_SOURCE_NPI : (process.env.SMPP_SOURCE_NPI || DEFAULTS.SMPP_SOURCE_NPI), 10),
      destTon: parseInt(dbSettings.SMPP_DEST_TON !== undefined ? dbSettings.SMPP_DEST_TON : (process.env.SMPP_DEST_TON || DEFAULTS.SMPP_DEST_TON), 10),
      destNpi: parseInt(dbSettings.SMPP_DEST_NPI !== undefined ? dbSettings.SMPP_DEST_NPI : (process.env.SMPP_DEST_NPI || DEFAULTS.SMPP_DEST_NPI), 10),
      tps: parseInt(dbSettings.SMPP_TPS_LIMIT || process.env.SMPP_TPS_LIMIT || DEFAULTS.SMPP_TPS_LIMIT, 10),
      keepaliveInterval: parseInt(dbSettings.SMPP_KEEPALIVE_INTERVAL || process.env.SMPP_KEEPALIVE_INTERVAL || DEFAULTS.SMPP_KEEPALIVE_INTERVAL, 10),
      autoConnect: (dbSettings.SMPP_AUTO_CONNECT !== undefined ? dbSettings.SMPP_AUTO_CONNECT === 'true' : (process.env.SMPP_AUTO_CONNECT === 'true' || DEFAULTS.SMPP_AUTO_CONNECT))
    },
    simulator: {
      port: parseInt(dbSettings.SIMULATOR_PORT || process.env.SIMULATOR_PORT || DEFAULTS.SIMULATOR_PORT, 10),
      enabled: (dbSettings.SIMULATOR_ENABLED !== undefined ? dbSettings.SIMULATOR_ENABLED === 'true' : (process.env.SIMULATOR_ENABLED === 'true' || DEFAULTS.SIMULATOR_ENABLED))
    }
  };
}

function updateConfig(newValues) {
  if (newValues.HTTP_PORT) db.setSetting('HTTP_PORT', newValues.HTTP_PORT);
  if (newValues.DEFAULT_SENDER) db.setSetting('DEFAULT_SENDER', newValues.DEFAULT_SENDER);
  if (newValues.SMPP_HOST !== undefined) db.setSetting('SMPP_HOST', newValues.SMPP_HOST);
  if (newValues.SMPP_PORT !== undefined) db.setSetting('SMPP_PORT', newValues.SMPP_PORT);
  if (newValues.SMPP_SYSTEM_ID !== undefined) db.setSetting('SMPP_SYSTEM_ID', newValues.SMPP_SYSTEM_ID);
  if (newValues.SMPP_PASSWORD !== undefined) db.setSetting('SMPP_PASSWORD', newValues.SMPP_PASSWORD);
  if (newValues.SMPP_SYSTEM_TYPE !== undefined) db.setSetting('SMPP_SYSTEM_TYPE', newValues.SMPP_SYSTEM_TYPE);
  if (newValues.SMPP_BIND_MODE !== undefined) db.setSetting('SMPP_BIND_MODE', newValues.SMPP_BIND_MODE);
  if (newValues.SMPP_SOURCE_TON !== undefined) db.setSetting('SMPP_SOURCE_TON', newValues.SMPP_SOURCE_TON);
  if (newValues.SMPP_SOURCE_NPI !== undefined) db.setSetting('SMPP_SOURCE_NPI', newValues.SMPP_SOURCE_NPI);
  if (newValues.SMPP_DEST_TON !== undefined) db.setSetting('SMPP_DEST_TON', newValues.SMPP_DEST_TON);
  if (newValues.SMPP_DEST_NPI !== undefined) db.setSetting('SMPP_DEST_NPI', newValues.SMPP_DEST_NPI);
  if (newValues.SMPP_TPS_LIMIT !== undefined) db.setSetting('SMPP_TPS_LIMIT', newValues.SMPP_TPS_LIMIT);
  if (newValues.SMPP_KEEPALIVE_INTERVAL !== undefined) db.setSetting('SMPP_KEEPALIVE_INTERVAL', newValues.SMPP_KEEPALIVE_INTERVAL);
  if (newValues.SMPP_AUTO_CONNECT !== undefined) db.setSetting('SMPP_AUTO_CONNECT', String(newValues.SMPP_AUTO_CONNECT));
  if (newValues.SIMULATOR_PORT !== undefined) db.setSetting('SIMULATOR_PORT', newValues.SIMULATOR_PORT);
  if (newValues.SIMULATOR_ENABLED !== undefined) db.setSetting('SIMULATOR_ENABLED', String(newValues.SIMULATOR_ENABLED));

  return getActiveConfig();
}

module.exports = {
  getActiveConfig,
  updateConfig,
  DEFAULTS
};

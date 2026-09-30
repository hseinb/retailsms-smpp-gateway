// REST API Routes
const express = require('express');
const router = express.Router();
const db = require('../db');
const { analyzeMessage } = require('../smpp/encoder');
const { updateConfig, getActiveConfig } = require('../config');

module.exports = function createApiRouter({ smppClient, simulator, broadcastWs }) {
  // Middleware: API Key Authentication
  const requireApiKey = (req, res, next) => {
    // Allow local browser portal requests without explicit API key
    const isPortalRequest = req.headers['x-requested-with'] === 'RetailSMS-Portal' ||
                           req.headers['sec-fetch-dest'] === 'empty' && req.headers.referer?.includes(req.headers.host);

    if (isPortalRequest) {
      return next();
    }

    const apiKey = req.headers['x-api-key'] ||
                   (req.headers['authorization'] && req.headers['authorization'].replace(/^Bearer\s+/i, ''));

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Missing API Key. Provide via "X-API-Key" or "Authorization: Bearer <key>" header.'
      });
    }

    if (!db.validateApiKey(apiKey)) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: Invalid or inactive API Key.'
      });
    }

    next();
  };

  /**
   * POST /api/v1/sms/send
   * Send single or bulk SMS messages
   */
  router.post('/sms/send', requireApiKey, (req, res) => {
    try {
      const { to, recipient, text, from, sender, unicode, forceUnicode } = req.body;

      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        return res.status(400).json({ success: false, error: 'Field "text" is required.' });
      }

      const destinations = [];
      const rawDest = to || recipient;

      if (Array.isArray(rawDest)) {
        destinations.push(...rawDest);
      } else if (typeof rawDest === 'string') {
        // Support comma or newline separated recipients
        const split = rawDest.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
        destinations.push(...split);
      }

      if (destinations.length === 0) {
        return res.status(400).json({ success: false, error: 'Field "to" or "recipient" is required.' });
      }

      const senderId = from || sender || smppClient.config.defaultSender || 'RetailSMS';
      const isUnicode = Boolean(unicode || forceUnicode);
      const isPortal = req.headers['x-requested-with'] === 'RetailSMS-Portal';

      const results = [];
      for (const dest of destinations) {
        const queued = smppClient.sendSms({
          to: dest,
          text,
          from: senderId,
          forceUnicode: isUnicode,
          source: isPortal ? 'web' : 'api'
        });
        results.push(queued);
      }

      // Broadcast update to web portal clients
      if (broadcastWs) {
        broadcastWs({ type: 'STATS_UPDATE', stats: db.getStats() });
        broadcastWs({ type: 'NEW_MESSAGES', count: results.length });
      }

      return res.status(202).json({
        success: true,
        totalQueued: results.length,
        messages: results
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * GET /api/v1/sms/preview
   * Calculate character counts, parts count, and encoding
   */
  router.post('/sms/preview', (req, res) => {
    const { text, unicode } = req.body;
    const analysis = analyzeMessage(text || '', unicode);
    res.json({ success: true, ...analysis });
  });

  /**
   * GET /api/v1/sms/:id
   * Get specific message details & delivery status
   */
  router.get('/sms/:id', requireApiKey, (req, res) => {
    const msg = db.getMessage(req.params.id);
    if (!msg) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true, message: msg });
  });

  /**
   * GET /api/v1/sms
   * List messages with filtering and pagination
   */
  router.get('/sms', requireApiKey, (req, res) => {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = parseInt(req.query.offset, 10) || 0;
    const filter = {
      status: req.query.status,
      recipient: req.query.recipient,
      search: req.query.search
    };

    const messages = db.getMessages(limit, offset, filter);
    const stats = db.getStats();

    res.json({
      success: true,
      count: messages.length,
      limit,
      offset,
      stats,
      messages
    });
  });

  /**
   * GET /api/v1/status
   * Gateway health, SMPP connection status, metrics, and queue size
   */
  router.get('/status', (req, res) => {
    const smppState = smppClient.getState();
    const stats = db.getStats();
    res.json({
      success: true,
      serverTime: new Date().toISOString(),
      smpp: smppState,
      simulator: {
        isRunning: simulator.isRunning,
        port: simulator.port
      },
      messageStats: stats
    });
  });

  /**
   * GET /api/v1/config
   * Current SMPP & system settings
   */
  router.get('/config', (req, res) => {
    const cfg = getActiveConfig();
    // Mask password for safety in UI
    const masked = {
      ...cfg,
      smpp: {
        ...cfg.smpp,
        password: cfg.smpp.password ? '********' : ''
      }
    };
    res.json({ success: true, config: masked });
  });

  /**
   * POST /api/v1/config
   * Update configuration and apply to SMPP client
   */
  router.post('/config', requireApiKey, async (req, res) => {
    try {
      const updates = req.body;

      // Don't overwrite password if masked string was submitted
      if (updates.SMPP_PASSWORD === '********') {
        delete updates.SMPP_PASSWORD;
      }

      const updated = updateConfig(updates);

      // Re-configure SMPP client
      smppClient.updateConfig({
        host: updated.smpp.host,
        port: updated.smpp.port,
        tls: updated.smpp.tls,
        systemId: updated.smpp.systemId,
        password: updated.smpp.password,
        systemType: updated.smpp.systemType,
        bindMode: updated.smpp.bindMode,
        sourceTon: updated.smpp.sourceTon,
        sourceNpi: updated.smpp.sourceNpi,
        destTon: updated.smpp.destTon,
        destNpi: updated.smpp.destNpi,
        tps: updated.smpp.tps,
        keepaliveInterval: updated.smpp.keepaliveInterval,
        defaultSender: updated.defaultSender
      });

      if (broadcastWs) {
        broadcastWs({ type: 'CONFIG_UPDATED', config: updated });
      }

      res.json({ success: true, message: 'Configuration saved successfully', config: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * SMPP Connection Actions
   */
  router.post('/smpp/connect', requireApiKey, async (req, res) => {
    try {
      await smppClient.connect();
      res.json({ success: true, message: 'SMPP connection initiated', state: smppClient.state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message, state: smppClient.state });
    }
  });

  router.post('/smpp/disconnect', requireApiKey, async (req, res) => {
    try {
      await smppClient.disconnect();
      res.json({ success: true, message: 'SMPP disconnected', state: smppClient.state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/smpp/reconnect', requireApiKey, async (req, res) => {
    try {
      await smppClient.disconnect();
      await smppClient.connect();
      res.json({ success: true, message: 'SMPP reconnection initiated', state: smppClient.state });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Mock SMPP Simulator Actions
   */
  router.post('/simulator/toggle', requireApiKey, async (req, res) => {
    try {
      if (simulator.isRunning) {
        await simulator.stop();
        res.json({ success: true, isRunning: false, message: 'SMPP Simulator stopped' });
      } else {
        const port = req.body.port || smppClient.config.port || 2775;
        await simulator.start(port);
        res.json({ success: true, isRunning: true, port, message: `SMPP Simulator running on port ${port}` });
      }
      if (broadcastWs) {
        broadcastWs({ type: 'SIMULATOR_STATE', isRunning: simulator.isRunning, port: simulator.port });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Logs
   */
  router.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    const logs = db.getLogs(limit);
    res.json({ success: true, logs });
  });

  router.delete('/logs', requireApiKey, (req, res) => {
    db.clearLogs();
    res.json({ success: true, message: 'Logs cleared' });
  });

  /**
   * API Key Management
   */
  router.get('/keys', requireApiKey, (req, res) => {
    const keys = db.listApiKeys();
    res.json({ success: true, keys });
  });

  router.post('/keys', requireApiKey, (req, res) => {
    const { name } = req.body;
    const newKey = db.createApiKey(name || 'API Client');
    res.json({ success: true, key: newKey });
  });

  router.delete('/keys/:key', requireApiKey, (req, res) => {
    db.deleteApiKey(req.params.key);
    res.json({ success: true, message: 'API key deleted' });
  });

  return router;
};

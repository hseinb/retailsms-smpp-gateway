// SQLite Database Layer with better-sqlite3
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'retailsms.db');

// Ensure directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);

// Enable WAL mode for high performance concurrent reading and writing
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Initialize schema
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    aggregator_msg_id TEXT,
    source TEXT DEFAULT 'web',
    sender TEXT NOT NULL,
    recipient TEXT NOT NULL,
    text TEXT NOT NULL,
    encoding TEXT NOT NULL,
    parts_count INTEGER DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    error_code TEXT,
    dlr_status TEXT,
    dlr_raw TEXT,
    dlr_received_at TEXT,
    submitted_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
  CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);
  CREATE INDEX IF NOT EXISTS idx_messages_agg_id ON messages(aggregator_msg_id);
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at);

  CREATE TABLE IF NOT EXISTS api_keys (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_active INTEGER DEFAULT 1
  );
`);

// Prepared statements for maximum performance
const stmts = {
  insertMessage: db.prepare(`
    INSERT INTO messages (
      id, aggregator_msg_id, source, sender, recipient, text,
      encoding, parts_count, status, error_code, created_at
    ) VALUES (
      @id, @aggregator_msg_id, @source, @sender, @recipient, @text,
      @encoding, @parts_count, @status, @error_code, @created_at
    )
  `),

  updateMessageStatus: db.prepare(`
    UPDATE messages
    SET status = @status,
        error_code = COALESCE(@error_code, error_code),
        submitted_at = COALESCE(@submitted_at, submitted_at)
    WHERE id = @id
  `),

  updateMessageAggregatorId: db.prepare(`
    UPDATE messages
    SET aggregator_msg_id = @aggregator_msg_id,
        status = @status,
        submitted_at = @submitted_at
    WHERE id = @id
  `),

  updateDlrByAggregatorId: db.prepare(`
    UPDATE messages
    SET status = @status,
        dlr_status = @dlr_status,
        dlr_raw = @dlr_raw,
        dlr_received_at = @dlr_received_at
    WHERE aggregator_msg_id = @aggregator_msg_id
  `),

  getMessageById: db.prepare(`
    SELECT * FROM messages WHERE id = ?
  `),

  getMessageByAggregatorId: db.prepare(`
    SELECT * FROM messages WHERE aggregator_msg_id = ? ORDER BY created_at DESC LIMIT 1
  `),

  listMessages: db.prepare(`
    SELECT * FROM messages
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),

  countMessages: db.prepare(`
    SELECT COUNT(*) as count FROM messages
  `),

  getStats: db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'SUBMITTED' THEN 1 ELSE 0 END) AS submitted,
      SUM(CASE WHEN status = 'DELIVERED' OR dlr_status = 'DELIVRD' THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN status IN ('FAILED', 'UNDELIV', 'REJECTED') OR dlr_status IN ('UNDELIV', 'REJECTD', 'EXPIRED') THEN 1 ELSE 0 END) AS failed
    FROM messages
  `),

  insertLog: db.prepare(`
    INSERT INTO logs (level, category, message, details, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  getRecentLogs: db.prepare(`
    SELECT * FROM logs ORDER BY id DESC LIMIT ?
  `),

  clearLogs: db.prepare(`
    DELETE FROM logs
  `),

  getSetting: db.prepare(`
    SELECT value FROM settings WHERE key = ?
  `),

  setSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),

  getAllSettings: db.prepare(`
    SELECT key, value FROM settings
  `),

  getApiKey: db.prepare(`
    SELECT * FROM api_keys WHERE key = ? AND is_active = 1
  `),

  listApiKeys: db.prepare(`
    SELECT key, name, created_at, is_active FROM api_keys ORDER BY created_at DESC
  `),

  insertApiKey: db.prepare(`
    INSERT INTO api_keys (key, name, created_at, is_active)
    VALUES (?, ?, ?, 1)
  `),

  deleteApiKey: db.prepare(`
    DELETE FROM api_keys WHERE key = ?
  `)
};

// Exported Helper Methods

function createMessage(data) {
  const id = data.id || crypto.randomUUID();
  const now = new Date().toISOString();

  const msg = {
    id,
    aggregator_msg_id: data.aggregator_msg_id || null,
    source: data.source || 'web',
    sender: data.sender || 'RetailSMS',
    recipient: data.recipient,
    text: data.text,
    encoding: data.encoding || 'GSM7',
    parts_count: data.parts_count || 1,
    status: data.status || 'QUEUED',
    error_code: data.error_code || null,
    created_at: now
  };

  stmts.insertMessage.run(msg);
  return msg;
}

function updateMessage(id, updates) {
  const current = stmts.getMessageById.get(id);
  if (!current) return null;

  stmts.updateMessageStatus.run({
    id,
    status: updates.status || current.status,
    error_code: updates.error_code || current.error_code,
    submitted_at: updates.submitted_at || current.submitted_at
  });

  return stmts.getMessageById.get(id);
}

function updateAggregatorMessageId(id, aggregatorMsgId, status = 'SUBMITTED') {
  const now = new Date().toISOString();
  stmts.updateMessageAggregatorId.run({
    id,
    aggregator_msg_id: aggregatorMsgId,
    status,
    submitted_at: now
  });
  return stmts.getMessageById.get(id);
}

function handleDlr(aggregatorMsgId, dlrStatus, rawDlr) {
  const now = new Date().toISOString();
  let status = 'DELIVERED';
  if (dlrStatus === 'UNDELIV' || dlrStatus === 'REJECTD') {
    status = 'FAILED';
  } else if (dlrStatus === 'EXPIRED') {
    status = 'FAILED';
  } else if (dlrStatus === 'DELIVRD') {
    status = 'DELIVERED';
  } else {
    status = dlrStatus;
  }

  stmts.updateDlrByAggregatorId.run({
    aggregator_msg_id: aggregatorMsgId,
    status,
    dlr_status: dlrStatus,
    dlr_raw: rawDlr,
    dlr_received_at: now
  });

  return stmts.getMessageByAggregatorId.get(aggregatorMsgId);
}

function getMessage(id) {
  return stmts.getMessageById.get(id);
}

function getMessages(limit = 50, offset = 0, filter = {}) {
  let query = 'SELECT * FROM messages';
  const params = [];
  const conditions = [];

  if (filter.status) {
    conditions.push('status = ?');
    params.push(filter.status);
  }
  if (filter.recipient) {
    conditions.push('recipient LIKE ?');
    params.push(`%${filter.recipient}%`);
  }
  if (filter.search) {
    conditions.push('(text LIKE ? OR recipient LIKE ? OR sender LIKE ? OR id LIKE ? OR aggregator_msg_id LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`, `%${filter.search}%`);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

function getStats() {
  const res = stmts.getStats.get();
  return {
    total: res.total || 0,
    queued: res.queued || 0,
    submitted: res.submitted || 0,
    delivered: res.delivered || 0,
    failed: res.failed || 0
  };
}

function log(level, category, message, details = null) {
  try {
    const detailsStr = details ? (typeof details === 'string' ? details : JSON.stringify(details)) : null;
    stmts.insertLog.run(level, category, message, detailsStr, new Date().toISOString());
  } catch (err) {
    console.error('Failed to write log to DB:', err.message);
  }
}

function getLogs(limit = 100) {
  return stmts.getRecentLogs.all(limit);
}

function clearLogs() {
  return stmts.clearLogs.run();
}

function getSetting(key, defaultValue = null) {
  const row = stmts.getSetting.get(key);
  return row ? row.value : defaultValue;
}

function setSetting(key, value) {
  const now = new Date().toISOString();
  stmts.setSetting.run(key, String(value), now);
}

function getAllSettings() {
  const rows = stmts.getAllSettings.all();
  const map = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

function validateApiKey(key) {
  if (!key) return false;
  const row = stmts.getApiKey.get(key);
  return !!row;
}

function listApiKeys() {
  return stmts.listApiKeys.all();
}

function createApiKey(name) {
  const key = 'rsk_' + crypto.randomBytes(24).toString('hex');
  const now = new Date().toISOString();
  stmts.insertApiKey.run(key, name || 'Default API Key', now);
  return { key, name, created_at: now };
}

function deleteApiKey(key) {
  return stmts.deleteApiKey.run(key);
}

// Ensure at least one default API key exists on startup
(function initDefaultApiKey() {
  const keys = stmts.listApiKeys.all();
  if (keys.length === 0) {
    createApiKey('Default Admin Key');
  }
})();

module.exports = {
  db,
  createMessage,
  updateMessage,
  updateAggregatorMessageId,
  handleDlr,
  getMessage,
  getMessages,
  getStats,
  log,
  getLogs,
  clearLogs,
  getSetting,
  setSetting,
  getAllSettings,
  validateApiKey,
  listApiKeys,
  createApiKey,
  deleteApiKey
};

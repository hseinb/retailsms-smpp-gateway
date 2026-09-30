// RetailSMS Web Portal Single Page Application Logic
(function () {
  'use strict';

  // State
  let currentApiKey = '';
  let activeTab = 'tab-send';
  let ws = null;
  let wsReconnectTimer = null;
  let messagesCache = [];

  // DOM Elements
  const smppStatusPill = document.getElementById('smpp-status-pill');
  const smppStatusLabel = document.getElementById('smpp-status-label');
  const simBtn = document.getElementById('btn-toggle-sim');
  const simLabel = document.getElementById('sim-label');

  // KPI elements
  const kpiTotal = document.getElementById('kpi-total');
  const kpiDelivered = document.getElementById('kpi-delivered');
  const kpiQueued = document.getElementById('kpi-queued');
  const kpiFailed = document.getElementById('kpi-failed');

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initComposer();
    initWebSocket();
    loadStats();
    loadConfig();
    loadApiKeys();
    loadMessages();
    loadLogs();
    setupSimulatorToggle();
    setupModal();
    setupCodeSnippets();
    setupApiSandbox();
  });

  // --- Toast Notifications ---
  function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> <span>${message}</span>`;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 4000);
  }

  // --- Tab Navigation ---
  function initNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        navButtons.forEach(b => b.classList.remove('active'));
        tabPanes.forEach(p => p.style.display = 'none');

        btn.classList.add('active');
        const activePane = document.getElementById(targetTab);
        if (activePane) activePane.style.display = 'block';
        activeTab = targetTab;

        if (targetTab === 'tab-messages') loadMessages();
        if (targetTab === 'tab-logs') loadLogs();
        if (targetTab === 'tab-settings') loadConfig();
        if (targetTab === 'tab-api') updateCodeSnippets();
      });
    });
  }

  // --- WebSocket Live Connection ---
  function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    try {
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('WebSocket connected');
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          handleWsEvent(data);
        } catch (_) {}
      };

      ws.onclose = () => {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = setTimeout(initWebSocket, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    } catch (_) {
      setTimeout(initWebSocket, 3000);
    }
  }

  function handleWsEvent(msg) {
    switch (msg.type) {
      case 'INIT_STATE':
        updateSmppStatus(msg.smppState);
        updateStats(msg.stats);
        updateSimulatorState(msg.simulator?.isRunning, msg.simulator?.port);
        break;

      case 'SMPP_STATE_CHANGE':
        updateSmppStatus(msg.state);
        if (msg.state === 'BOUND') {
          showToast('SMPP connection bound & ready to send!', 'success');
        } else if (msg.state === 'ERROR') {
          showToast(`SMPP Error: ${msg.error || 'Connection failed'}`, 'error');
        }
        break;

      case 'STATS_UPDATE':
        updateStats(msg.stats);
        break;

      case 'NEW_MESSAGES':
        if (activeTab === 'tab-messages') loadMessages();
        loadStats();
        break;

      case 'MESSAGE_STATUS':
      case 'DLR_RECEIVED':
        if (msg.stats) updateStats(msg.stats);
        if (activeTab === 'tab-messages') loadMessages();
        addLiveLog('SMPP', 'INFO', `Message update: ${JSON.stringify(msg.data)}`);
        break;

      case 'SIMULATOR_STATE':
        updateSimulatorState(msg.isRunning, msg.port);
        break;
    }
  }

  function updateSmppStatus(state) {
    smppStatusPill.className = `status-pill status-${state}`;
    smppStatusLabel.textContent = state;
  }

  function updateSimulatorState(isRunning, port) {
    if (isRunning) {
      simBtn.classList.add('active');
      simLabel.textContent = `Simulator: ON (:${port || 2775})`;
    } else {
      simBtn.classList.remove('active');
      simLabel.textContent = 'Simulator: OFF';
    }
  }

  function updateStats(stats) {
    if (!stats) return;
    kpiTotal.textContent = stats.total || 0;
    kpiDelivered.textContent = stats.delivered || 0;
    kpiQueued.textContent = stats.queued || 0;
    kpiFailed.textContent = stats.failed || 0;
  }

  async function loadStats() {
    try {
      const res = await fetch('/api/v1/status');
      const data = await res.json();
      if (data.success) {
        updateStats(data.messageStats);
        updateSmppStatus(data.smpp?.state || 'DISCONNECTED');
        updateSimulatorState(data.simulator?.isRunning, data.simulator?.port);
      }
    } catch (_) {}
  }

  // --- SMS Composer & Encoding Analyzer ---
  function initComposer() {
    const textInput = document.getElementById('send-text');
    const forceUnicodeCheckbox = document.getElementById('force-unicode');
    const sendForm = document.getElementById('form-send-sms');
    const templateButtons = document.querySelectorAll('.tpl-btn');

    const updateComposerMeta = () => {
      const text = textInput.value;
      const forceUnicode = forceUnicodeCheckbox.checked;

      // Analyze character count & parts
      const analysis = analyzeClientText(text, forceUnicode);

      const badgeEncoding = document.getElementById('badge-encoding');
      const badgeParts = document.getElementById('badge-parts');
      const charCount = document.getElementById('char-count');
      const charMax = document.getElementById('char-max');
      const charsRemaining = document.getElementById('chars-remaining');

      badgeEncoding.className = `meta-pill ${analysis.encoding.toLowerCase()}`;
      badgeEncoding.textContent = analysis.encoding === 'UCS2' ? 'UCS-2 (Unicode)' : 'GSM 7-bit';

      badgeParts.textContent = `${analysis.partsCount} SMS Part${analysis.partsCount > 1 ? 's' : ''}`;
      charCount.textContent = analysis.characterCount;
      charMax.textContent = analysis.maxPerPart;
      charsRemaining.textContent = analysis.charsRemainingInCurrentPart;
    };

    textInput.addEventListener('input', updateComposerMeta);
    forceUnicodeCheckbox.addEventListener('change', updateComposerMeta);

    templateButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        textInput.value = btn.getAttribute('data-tpl');
        updateComposerMeta();
      });
    });

    sendForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const from = document.getElementById('send-from').value.trim();
      const to = document.getElementById('send-to').value.trim();
      const text = textInput.value.trim();
      const forceUnicode = forceUnicodeCheckbox.checked;

      if (!to || !text) {
        showToast('Please enter recipient and message text', 'error');
        return;
      }

      const submitBtn = document.getElementById('btn-submit-send');
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span>⏳ Sending...</span>';

      try {
        const res = await fetch('/api/v1/sms/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Requested-With': 'RetailSMS-Portal'
          },
          body: JSON.stringify({
            from,
            to,
            text,
            forceUnicode
          })
        });

        const data = await res.json();
        if (data.success) {
          showToast(`Successfully queued ${data.totalQueued} message(s)!`, 'success');
          textInput.value = '';
          updateComposerMeta();
          loadStats();
          loadMessages();
        } else {
          showToast(`Failed: ${data.error || 'Error sending SMS'}`, 'error');
        }
      } catch (err) {
        showToast(`Network error: ${err.message}`, 'error');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<span>🚀 Send Message Now</span>';
      }
    });
  }

  // Client-side quick analyzer
  function analyzeClientText(text, forceUnicode) {
    if (!text) return { encoding: forceUnicode ? 'UCS2' : 'GSM7', characterCount: 0, partsCount: 1, maxPerPart: forceUnicode ? 70 : 160, charsRemainingInCurrentPart: forceUnicode ? 70 : 160 };

    // Standard GSM characters
    const isGsm = !forceUnicode && /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑÜ§¿a-zäöñüà|^€{}[~]\\*]*$/.test(text);

    if (isGsm) {
      let count = 0;
      for (const ch of text) {
        count += '|^€{}[~]\\'.includes(ch) ? 2 : 1;
      }
      if (count <= 160) {
        return { encoding: 'GSM7', characterCount: count, partsCount: 1, maxPerPart: 160, charsRemainingInCurrentPart: 160 - count };
      }
      const parts = Math.ceil(count / 153);
      return { encoding: 'GSM7', characterCount: count, partsCount: parts, maxPerPart: 153, charsRemainingInCurrentPart: (parts * 153) - count };
    } else {
      const chars = Array.from(text);
      const count = chars.length;
      if (count <= 70) {
        return { encoding: 'UCS2', characterCount: count, partsCount: 1, maxPerPart: 70, charsRemainingInCurrentPart: 70 - count };
      }
      const parts = Math.ceil(count / 67);
      return { encoding: 'UCS2', characterCount: count, partsCount: parts, maxPerPart: 67, charsRemainingInCurrentPart: (parts * 67) - count };
    }
  }

  // --- Message Log & DLR Management ---
  async function loadMessages() {
    const tableBody = document.getElementById('messages-table-body');
    const search = document.getElementById('filter-search').value.trim();
    const status = document.getElementById('filter-status').value;

    const params = new URLSearchParams();
    if (search) params.append('search', search);
    if (status) params.append('status', status);
    params.append('limit', '50');

    try {
      const res = await fetch(`/api/v1/sms?${params.toString()}`, {
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      const data = await res.json();
      if (!data.success) return;

      messagesCache = data.messages || [];

      if (messagesCache.length === 0) {
        tableBody.innerHTML = `
          <tr>
            <td colspan="9" style="text-align: center; color: var(--text-muted); padding: 2rem;">No messages found.</td>
          </tr>
        `;
        return;
      }

      tableBody.innerHTML = messagesCache.map(msg => {
        const preview = escapeHtml(msg.text.length > 35 ? msg.text.slice(0, 35) + '...' : msg.text);
        const createdDate = new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

        return `
          <tr>
            <td><span class="badge-status badge-${msg.status}">${msg.status}</span></td>
            <td><strong>${escapeHtml(msg.recipient)}</strong></td>
            <td>${escapeHtml(msg.sender)}</td>
            <td title="${escapeHtml(msg.text)}">${preview}</td>
            <td>${msg.parts_count || 1}</td>
            <td><span class="meta-pill ${msg.encoding.toLowerCase()}">${msg.encoding}</span></td>
            <td style="font-family: var(--font-mono); font-size: 0.8rem;">${msg.aggregator_msg_id ? escapeHtml(msg.aggregator_msg_id) : '-'}</td>
            <td style="color: var(--text-dim); font-size: 0.82rem;">${createdDate}</td>
            <td>
              <button class="btn btn-secondary btn-sm" onclick="window.viewMsgDetail('${msg.id}')">View</button>
            </td>
          </tr>
        `;
      }).join('');
    } catch (_) {}
  }

  // Search & Filter controls
  document.getElementById('btn-apply-filter').addEventListener('click', loadMessages);
  document.getElementById('btn-refresh-messages').addEventListener('click', loadMessages);

  // Export CSV
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    if (messagesCache.length === 0) {
      showToast('No messages to export', 'error');
      return;
    }

    const headers = ['ID', 'Status', 'Recipient', 'Sender', 'Encoding', 'Parts', 'AggregatorMsgId', 'DlrStatus', 'CreatedAt', 'Text'];
    const rows = messagesCache.map(m => [
      `"${m.id}"`,
      `"${m.status}"`,
      `"${m.recipient}"`,
      `"${m.sender}"`,
      `"${m.encoding}"`,
      m.parts_count || 1,
      `"${m.aggregator_msg_id || ''}"`,
      `"${m.dlr_status || ''}"`,
      `"${m.created_at}"`,
      `"${(m.text || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(e => e.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `RetailSMS_Messages_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
  });

  // Message Detail Modal
  window.viewMsgDetail = function (id) {
    const msg = messagesCache.find(m => m.id === id);
    if (!msg) return;

    const modalBody = document.getElementById('modal-body');
    modalBody.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.85rem; font-size: 0.92rem;">
        <div>
          <strong style="color: var(--text-muted);">Message ID:</strong>
          <code style="background: var(--bg-primary); padding: 0.2rem 0.4rem; border-radius: 4px; margin-left: 0.5rem;">${msg.id}</code>
        </div>
        <div>
          <strong style="color: var(--text-muted);">Status:</strong>
          <span class="badge-status badge-${msg.status}" style="margin-left: 0.5rem;">${msg.status}</span>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
          <div><strong style="color: var(--text-muted);">Sender:</strong> ${escapeHtml(msg.sender)}</div>
          <div><strong style="color: var(--text-muted);">Recipient:</strong> ${escapeHtml(msg.recipient)}</div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;">
          <div><strong style="color: var(--text-muted);">Encoding:</strong> ${msg.encoding}</div>
          <div><strong style="color: var(--text-muted);">Parts Count:</strong> ${msg.parts_count} SMS segment(s)</div>
        </div>
        <div>
          <strong style="color: var(--text-muted);">Full Message Content:</strong>
          <div style="background: var(--bg-primary); padding: 0.75rem; border-radius: 6px; margin-top: 0.3rem; border: 1px solid var(--border-color); white-space: pre-wrap;">${escapeHtml(msg.text)}</div>
        </div>
        <div style="border-top: 1px solid var(--border-color); padding-top: 0.75rem;">
          <h4 style="margin-bottom: 0.4rem; color: var(--accent-primary);">Aggregator SMPP & DLR Details</h4>
          <div><strong style="color: var(--text-muted);">Aggregator Message ID:</strong> ${msg.aggregator_msg_id ? `<code>${escapeHtml(msg.aggregator_msg_id)}</code>` : '<span style="color: var(--text-dim);">Pending / None</span>'}</div>
          <div><strong style="color: var(--text-muted);">Delivery Receipt (DLR):</strong> ${msg.dlr_status ? `<span class="badge-status badge-${msg.dlr_status}">${msg.dlr_status}</span>` : '<span style="color: var(--text-dim);">Awaiting DLR</span>'}</div>
          ${msg.dlr_raw ? `<div style="margin-top: 0.3rem;"><strong style="color: var(--text-muted);">Raw DLR PDU:</strong> <pre class="code-block" style="margin-top: 0.2rem; font-size: 0.78rem;">${escapeHtml(msg.dlr_raw)}</pre></div>` : ''}
          ${msg.error_code ? `<div style="margin-top: 0.3rem; color: var(--danger);"><strong>Error / Reason:</strong> ${escapeHtml(msg.error_code)}</div>` : ''}
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem;">
          <button class="btn btn-primary btn-sm" onclick="window.resendMsg('${msg.id}')">🔄 Resend Message</button>
        </div>
      </div>
    `;
    document.getElementById('msg-detail-modal').style.display = 'flex';
  };

  window.resendMsg = async function (id) {
    const msg = messagesCache.find(m => m.id === id);
    if (!msg) return;

    try {
      const res = await fetch('/api/v1/sms/send', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'RetailSMS-Portal'
        },
        body: JSON.stringify({
          from: msg.sender,
          to: msg.recipient,
          text: msg.text,
          forceUnicode: msg.encoding === 'UCS2'
        })
      });
      const data = await res.json();
      if (data.success) {
        showToast('Message re-queued successfully!', 'success');
        document.getElementById('msg-detail-modal').style.display = 'none';
        loadMessages();
      } else {
        showToast(`Failed to resend: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  };

  function setupModal() {
    const modal = document.getElementById('msg-detail-modal');
    document.getElementById('btn-close-modal').addEventListener('click', () => {
      modal.style.display = 'none';
    });
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  // --- SMPP Settings Management ---
  async function loadConfig() {
    try {
      const res = await fetch('/api/v1/config', {
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      const data = await res.json();
      if (!data.success) return;

      const cfg = data.config;
      document.getElementById('cfg-host').value = cfg.smpp.host || '';
      document.getElementById('cfg-port').value = cfg.smpp.port || 2775;
      document.getElementById('cfg-system-id').value = cfg.smpp.systemId || '';
      document.getElementById('cfg-password').value = cfg.smpp.password || '';
      document.getElementById('cfg-system-type').value = cfg.smpp.systemType || '';
      document.getElementById('cfg-bind-mode').value = cfg.smpp.bindMode || 'transceiver';
      document.getElementById('cfg-tps').value = cfg.smpp.tps || 10;
      document.getElementById('cfg-keepalive').value = cfg.smpp.keepaliveInterval || 30;
      document.getElementById('cfg-source-ton').value = cfg.smpp.sourceTon !== undefined ? cfg.smpp.sourceTon : 5;
      document.getElementById('cfg-source-npi').value = cfg.smpp.sourceNpi !== undefined ? cfg.smpp.sourceNpi : 0;
      document.getElementById('cfg-dest-ton').value = cfg.smpp.destTon !== undefined ? cfg.smpp.destTon : 1;
      document.getElementById('cfg-dest-npi').value = cfg.smpp.destNpi !== undefined ? cfg.smpp.destNpi : 1;
      document.getElementById('cfg-default-sender').value = cfg.defaultSender || 'RetailAlert';
      document.getElementById('cfg-tls').checked = Boolean(cfg.smpp.tls);

      // Pre-fill composer default sender
      const sendFrom = document.getElementById('send-from');
      if (!sendFrom.value) sendFrom.value = cfg.defaultSender || 'RetailAlert';
    } catch (_) {}
  }

  document.getElementById('form-smpp-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      SMPP_HOST: document.getElementById('cfg-host').value.trim(),
      SMPP_PORT: parseInt(document.getElementById('cfg-port').value, 10),
      SMPP_SYSTEM_ID: document.getElementById('cfg-system-id').value.trim(),
      SMPP_PASSWORD: document.getElementById('cfg-password').value,
      SMPP_SYSTEM_TYPE: document.getElementById('cfg-system-type').value.trim(),
      SMPP_BIND_MODE: document.getElementById('cfg-bind-mode').value,
      SMPP_TPS_LIMIT: parseInt(document.getElementById('cfg-tps').value, 10),
      SMPP_KEEPALIVE_INTERVAL: parseInt(document.getElementById('cfg-keepalive').value, 10),
      SMPP_SOURCE_TON: parseInt(document.getElementById('cfg-source-ton').value, 10),
      SMPP_SOURCE_NPI: parseInt(document.getElementById('cfg-source-npi').value, 10),
      SMPP_DEST_TON: parseInt(document.getElementById('cfg-dest-ton').value, 10),
      SMPP_DEST_NPI: parseInt(document.getElementById('cfg-dest-npi').value, 10),
      DEFAULT_SENDER: document.getElementById('cfg-default-sender').value.trim(),
      SMPP_TLS: document.getElementById('cfg-tls').checked
    };

    try {
      const res = await fetch('/api/v1/config', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'RetailSMS-Portal'
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        showToast('Settings saved successfully!', 'success');
      } else {
        showToast(`Failed to save: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    }
  });

  // Fill in Local Simulator settings helper
  document.getElementById('btn-use-simulator-creds').addEventListener('click', () => {
    document.getElementById('cfg-host').value = '127.0.0.1';
    document.getElementById('cfg-port').value = 2775;
    document.getElementById('cfg-system-id').value = 'mock_client';
    document.getElementById('cfg-password').value = 'mock_password';
    document.getElementById('cfg-system-type').value = '';
    document.getElementById('cfg-bind-mode').value = 'transceiver';
    showToast('Loaded local simulator connection parameters. Click "Save Settings" and "Connect"!', 'info');
  });

  // SMPP Connect / Disconnect Buttons
  document.getElementById('btn-smpp-connect').addEventListener('click', async () => {
    showToast('Initiating SMPP connection...', 'info');
    try {
      const res = await fetch('/api/v1/smpp/connect', {
        method: 'POST',
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      const data = await res.json();
      if (data.success) {
        showToast('SMPP connected successfully!', 'success');
      } else {
        showToast(`SMPP Connect failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });

  document.getElementById('btn-smpp-disconnect').addEventListener('click', async () => {
    try {
      await fetch('/api/v1/smpp/disconnect', {
        method: 'POST',
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      showToast('SMPP disconnected.', 'info');
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });

  // --- Mock SMPP Simulator Quick Switch ---
  function setupSimulatorToggle() {
    simBtn.addEventListener('click', async () => {
      try {
        const res = await fetch('/api/v1/simulator/toggle', {
          method: 'POST',
          headers: { 'X-Requested-With': 'RetailSMS-Portal' }
        });
        const data = await res.json();
        if (data.success) {
          updateSimulatorState(data.isRunning, data.port);
          showToast(data.message, data.isRunning ? 'success' : 'info');
        } else {
          showToast(`Error: ${data.error}`, 'error');
        }
      } catch (err) {
        showToast(`Network error: ${err.message}`, 'error');
      }
    });
  }

  // --- API Key & Sandbox ---
  async function loadApiKeys() {
    try {
      const res = await fetch('/api/v1/keys', {
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      const data = await res.json();
      if (data.success && data.keys && data.keys.length > 0) {
        currentApiKey = data.keys[0].key;
        document.getElementById('display-api-key').value = currentApiKey;
        updateCodeSnippets();
      }
    } catch (_) {}
  }

  document.getElementById('btn-copy-api-key').addEventListener('click', () => {
    const key = document.getElementById('display-api-key').value;
    if (key) {
      navigator.clipboard.writeText(key);
      showToast('API Key copied to clipboard!', 'success');
    }
  });

  document.getElementById('btn-create-api-key').addEventListener('click', async () => {
    const name = prompt('Enter a label for the new API Key:', 'Production API Client');
    if (!name) return;

    try {
      const res = await fetch('/api/v1/keys', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'RetailSMS-Portal'
        },
        body: JSON.stringify({ name })
      });
      const data = await res.json();
      if (data.success) {
        currentApiKey = data.key.key;
        document.getElementById('display-api-key').value = currentApiKey;
        showToast('New API Key created!', 'success');
        updateCodeSnippets();
      }
    } catch (err) {
      showToast(`Error: ${err.message}`, 'error');
    }
  });

  // Interactive Sandbox
  function setupApiSandbox() {
    const btn = document.getElementById('btn-run-api-test');
    const payloadTextarea = document.getElementById('api-sandbox-payload');
    const responseBox = document.getElementById('api-sandbox-response');

    btn.addEventListener('click', async () => {
      let payload;
      try {
        payload = JSON.parse(payloadTextarea.value);
      } catch (e) {
        showToast('Invalid JSON in payload: ' + e.message, 'error');
        return;
      }

      responseBox.textContent = 'Sending request...';

      try {
        const res = await fetch('/api/v1/sms/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': currentApiKey
          },
          body: JSON.stringify(payload)
        });

        const statusText = `HTTP ${res.status} ${res.statusText}\n`;
        const data = await res.json();
        responseBox.textContent = statusText + JSON.stringify(data, null, 2);
        loadStats();
      } catch (err) {
        responseBox.textContent = `Error: ${err.message}`;
      }
    });
  }

  // Code Integration Snippets
  let activeSnippetLang = 'curl';
  function setupCodeSnippets() {
    const snippetTabs = document.querySelectorAll('.snippet-tab');
    snippetTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        snippetTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeSnippetLang = tab.getAttribute('data-lang');
        updateCodeSnippets();
      });
    });

    document.getElementById('btn-copy-code').addEventListener('click', () => {
      const code = document.getElementById('snippet-code-display').textContent;
      navigator.clipboard.writeText(code);
      showToast('Code snippet copied to clipboard!', 'success');
    });
  }

  function updateCodeSnippets() {
    const codeDisplay = document.getElementById('snippet-code-display');
    const host = window.location.origin;
    const key = currentApiKey || 'YOUR_API_KEY';

    let snippet = '';

    if (activeSnippetLang === 'curl') {
      snippet = `curl -X POST "${host}/api/v1/sms/send" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{
    "to": "+12025550143",
    "from": "RetailSMS",
    "text": "Hello from RetailSMS SMPP Gateway!"
  }'`;
    } else if (activeSnippetLang === 'node') {
      snippet = `// Node.js (Node 18+ native fetch)
async function sendSms() {
  const response = await fetch('${host}/api/v1/sms/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': '${key}'
    },
    body: JSON.stringify({
      to: '+12025550143',
      from: 'RetailSMS',
      text: 'Hello from RetailSMS Gateway!'
    })
  });

  const data = await response.json();
  console.log('Result:', data);
}

sendSms();`;
    } else if (activeSnippetLang === 'python') {
      snippet = `import requests

url = "${host}/api/v1/sms/send"
headers = {
    "Content-Type": "application/json",
    "X-API-Key": "${key}"
}
payload = {
    "to": "+12025550143",
    "from": "RetailSMS",
    "text": "Hello from Python RetailSMS!"
}

response = requests.post(url, json=payload, headers=headers)
print("Status:", response.status_code)
print("Response:", response.json())`;
    } else if (activeSnippetLang === 'php') {
      snippet = `<?php
$curl = curl_init();

$payload = json_encode([
    "to" => "+12025550143",
    "from" => "RetailSMS",
    "text" => "Hello from PHP RetailSMS!"
]);

curl_setopt_array($curl, [
    CURLOPT_URL => "${host}/api/v1/sms/send",
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $payload,
    CURLOPT_HTTPHEADER => [
        "Content-Type: application/json",
        "X-API-Key: ${key}"
    ],
]);

$response = curl_exec($curl);
curl_close($curl);
echo $response;
?>`;
    }

    codeDisplay.textContent = snippet;
  }

  // --- Live Logs ---
  async function loadLogs() {
    try {
      const res = await fetch('/api/v1/logs?limit=100');
      const data = await res.json();
      if (!data.success) return;

      const container = document.getElementById('terminal-container');
      container.innerHTML = '';
      (data.logs || []).reverse().forEach(entry => {
        addLiveLog(entry.category, entry.level, entry.message, entry.created_at);
      });
    } catch (_) {}
  }

  function addLiveLog(cat, level, message, timestamp) {
    const container = document.getElementById('terminal-container');
    const timeStr = timestamp ? new Date(timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();

    const row = document.createElement('div');
    row.className = 'log-entry';
    row.innerHTML = `
      <span class="log-time">[${timeStr}]</span>
      <span class="log-cat">[${cat}]</span>
      <span class="log-level ${level}">${level}</span>
      <span class="log-msg">${escapeHtml(message)}</span>
    `;

    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  document.getElementById('btn-clear-logs').addEventListener('click', async () => {
    try {
      await fetch('/api/v1/logs', {
        method: 'DELETE',
        headers: { 'X-Requested-With': 'RetailSMS-Portal' }
      });
      document.getElementById('terminal-container').innerHTML = '';
      showToast('Logs cleared', 'info');
    } catch (_) {}
  });

  // Helper: Escape HTML
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

})();

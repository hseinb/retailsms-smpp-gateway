// End-to-End Integration Test for RetailSMS Gateway
const http = require('http');
const assert = require('assert');

// Force test environment config
process.env.PORT = '3099';
process.env.SIMULATOR_PORT = '2779';
process.env.SMPP_PORT = '2779';
process.env.SIMULATOR_ENABLED = 'true';
process.env.SMPP_AUTO_CONNECT = 'false';

const { app, server, smppClient, simulator } = require('../server');
const db = require('../src/db');

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const defaultHeaders = {
      'Content-Type': 'application/json',
      ...headers
    };

    const payload = body ? JSON.stringify(body) : null;
    if (payload) {
      defaultHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: 3099,
      path,
      method,
      headers: defaultHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json });
        } catch (_) {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('🧪 Starting RetailSMS Integration Tests...\n');

  try {
    // Wait for HTTP server to be listening
    await sleep(500);

    // 1. Verify Mock SMPP Simulator
    console.log('1. Starting Mock SMPP Simulator on port 2779...');
    await simulator.start(2779);
    assert.strictEqual(simulator.isRunning, true, 'Simulator should be running');
    console.log('   ✅ Simulator started successfully');

    // 2. Connect SMPP Client to Simulator
    console.log('2. Connecting SMPP Client to simulator...');
    smppClient.updateConfig({ host: '127.0.0.1', port: 2779, systemId: 'test_user', password: 'test_password' });
    await smppClient.connect();
    await sleep(300);
    assert.strictEqual(smppClient.state, 'BOUND', 'SMPP client should be in BOUND state');
    console.log('   ✅ SMPP Client bound successfully as Transceiver');

    // 3. Test API Key Auth Protection
    console.log('3. Testing API Key authentication enforcement...');
    const unauthRes = await request('POST', '/api/v1/sms/send', {
      to: '+12025550143',
      text: 'Test message'
    });
    assert.strictEqual(unauthRes.status, 401, 'Request without API key should be rejected with 401');
    console.log('   ✅ Unauthorized request correctly rejected with 401');

    // Retrieve active API key
    const apiKeys = db.listApiKeys();
    assert.ok(apiKeys.length > 0, 'Should have at least one API key');
    const validKey = apiKeys[0].key;
    console.log(`   🔑 Using API Key: ${validKey.slice(0, 10)}...`);

    // 4. Send Standard GSM-7 Single SMS
    console.log('4. Testing Single GSM-7 SMS transmission...');
    const sendRes = await request('POST', '/api/v1/sms/send', {
      to: '+12025550143',
      from: 'RetailShop',
      text: 'Hello from automated integration test!'
    }, { 'X-API-Key': validKey });

    assert.strictEqual(sendRes.status, 202, 'Send SMS should return 202 Accepted');
    assert.strictEqual(sendRes.data.success, true);
    assert.strictEqual(sendRes.data.totalQueued, 1);
    const msgId = sendRes.data.messages[0].id;
    console.log(`   ✅ Queued SMS ID: ${msgId}`);

    // Wait for submission and DLR receipt (simulator triggers DELIVRD after 1.5s)
    console.log('   ⏳ Waiting for SMPP delivery and DLR receipt (approx 2s)...');
    await sleep(2500);

    const getRes = await request('GET', `/api/v1/sms/${msgId}`, null, { 'X-API-Key': validKey });
    assert.strictEqual(getRes.status, 200);
    const message = getRes.data.message;
    console.log(`   📊 Message Status: ${message.status}, Aggregator ID: ${message.aggregator_msg_id}, DLR: ${message.dlr_status}`);
    assert.strictEqual(message.status, 'DELIVERED', 'Message should be marked DELIVERED after DLR');
    assert.strictEqual(message.dlr_status, 'DELIVRD');
    assert.ok(message.aggregator_msg_id, 'Should have received aggregator message ID');
    console.log('   ✅ Single SMS submitted and delivery receipt processed');

    // 5. Send Arabic / Unicode UCS-2 Message
    console.log('5. Testing Arabic (UCS-2 Unicode) SMS...');
    const arabicRes = await request('POST', '/api/v1/sms/send', {
      to: '+966500000000',
      from: 'StoreAlert',
      text: 'مرحبا! هذا اختبار للرسائل النصية باللغة العربية'
    }, { 'X-API-Key': validKey });

    assert.strictEqual(arabicRes.status, 202);
    const arabicMsg = arabicRes.data.messages[0];
    assert.strictEqual(arabicMsg.encoding, 'UCS2', 'Arabic text should be detected as UCS-2');
    console.log(`   ✅ Arabic message correctly detected as UCS-2 with ${arabicMsg.parts} part(s)`);

    // 6. Send Multipart / Concatenated SMS (> 160 GSM characters)
    console.log('6. Testing Multipart / Concatenated SMS (200 chars)...');
    const longText = 'RetailSMS Notification: Thank you for your recent purchase at our store! ' +
                     'Your tracking order reference is RT-891024. Your delivery will arrive within 2 business days. ' +
                     'Questions? Reply HELP.';
    const longRes = await request('POST', '/api/v1/sms/send', {
      to: '+12025550199',
      text: longText
    }, { 'X-API-Key': validKey });

    assert.strictEqual(longRes.status, 202);
    const longMsg = longRes.data.messages[0];
    assert.ok(longMsg.parts >= 2, `Long message should be split into multiple parts, got ${longMsg.parts}`);
    console.log(`   ✅ Long message correctly segmented into ${longMsg.parts} parts with UDH`);

    // 7. Check System Status endpoint
    console.log('7. Testing GET /api/v1/status...');
    const statusRes = await request('GET', '/api/v1/status');
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.data.smpp.state, 'BOUND');
    console.log(`   ✅ Gateway status verified. Current Bound State: ${statusRes.data.smpp.state}`);

    console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! 🚀\n');
  } catch (err) {
    console.error('\n❌ Test failed:', err);
    process.exitCode = 1;
  } finally {
    // Cleanup
    try {
      await smppClient.disconnect();
      await simulator.stop();
      server.close();
    } catch (_) {}
    process.exit(process.exitCode || 0);
  }
}

runTests();

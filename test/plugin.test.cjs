const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

let mockBehavior = {};

function makeResponse(body, statusCode = 200, delayMs = 0) {
  const res = new EventEmitter();
  res.statusCode = statusCode;
  res.setEncoding = () => {};

  setTimeout(() => {
    if (body) {
      res.emit('data', body);
    }
    res.emit('end');
  }, delayMs);

  return res;
}

function commandKey(args) {
  return `/usr/bin/mmcli ${args.join(' ')}`;
}

function makeTransport() {
  return {
    request(_options, cb) {
      const req = new EventEmitter();
      let body = '';

      req.write = (chunk) => {
        body += chunk;
      };

      req.end = () => {
        let payload;
        try {
          payload = JSON.parse(body);
        } catch (err) {
          req.emit('error', err);
          return;
        }

        const [, object, method, params] = payload.params;

        if (object === 'session' && method === 'login') {
          cb(makeResponse(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            result: [0, { ubus_rpc_session: 'test-session' }]
          })));
          return;
        }

        if (object !== 'file' || method !== 'exec') {
          cb(makeResponse(JSON.stringify({
            jsonrpc: '2.0',
            id: payload.id,
            error: { code: -32002, message: 'Access denied' }
          })));
          return;
        }

        const key = commandKey(params.params || []);
        const behavior = mockBehavior[key];
        if (behavior) {
          behavior.calls = (behavior.calls || 0) + 1;
        }

        cb(makeResponse(JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: [0, {
            code: behavior?.code ?? 0,
            stdout: behavior?.stdout ?? '',
            stderr: behavior?.stderr ?? ''
          }]
        }), 200, behavior?.delayMs ?? 0));
      };

      req.destroy = (err) => {
        req.emit('error', err);
      };

      req.setTimeout = () => {};

      return req;
    }
  };
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'http' || request === 'https') {
    return makeTransport();
  }
  return originalLoad.call(this, request, parent, isMain);
};

delete require.cache[require.resolve('../index.js')];
const pluginFactory = require('../index.js');
Module._load = originalLoad;

function makeApp() {
  return {
    debugCalls: [],
    errorCalls: [],
    messages: [],
    debug(message) {
      this.debugCalls.push(message);
    },
    error(message) {
      this.errorCalls.push(message);
    },
    handleMessage(pluginId, delta) {
      this.messages.push({ pluginId, delta });
    }
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

async function settlePoll() {
  await flush();
  await flush();
  await flush();
}

test.beforeEach(() => {
  mockBehavior = {};
});

test('marks password configuration as a masked field', () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  assert.equal(plugin.schema.properties.password.format, 'password');
  assert.equal(plugin.uiSchema.password['ui:widget'], 'password');
});

test('publishes LTE signal metrics for a discovered modem', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({
      modem: {
        signal: {
          lte: {
            rssi: '-51',
            rsrp: '-82',
            rsrq: '-10',
            's/n': '18.2'
          }
        }
      }
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({
      modem: {
        generic: {
          state: 'connected',
          'signal-quality': {
            value: '54'
          }
        },
        '3gpp': {
          'operator-name': 'Orange'
        }
      }
    })
  };

  plugin.start({
    host: '192.168.1.1',
    username: 'root',
    password: 'secret',
    pollInterval: 30
  });

  await settlePoll();
  plugin.stop();

  assert.equal(app.errorCalls.length, 0);
  assert.equal(app.messages.length, 1);

  const [{ pluginId, delta }] = app.messages;
  const values = delta.updates[0].values;
  const meta = delta.updates[0].meta;

  assert.equal(pluginId, 'signalk-openwrt');
  assert.deepEqual(values, [
    { path: 'environment.outside.cellular.0.type', value: 'lte' },
    { path: 'environment.outside.cellular.0.rssi', value: -51 },
    { path: 'environment.outside.cellular.0.rsrp', value: -82 },
    { path: 'environment.outside.cellular.0.rsrq', value: -10 },
    { path: 'environment.outside.cellular.0.snr', value: 18.2 },
    { path: 'environment.outside.cellular.0.signalQuality', value: 0.54 },
    { path: 'environment.outside.cellular.0.operator', value: 'Orange' },
    { path: 'environment.outside.cellular.0.connected', value: true }
  ]);
  assert.deepEqual(meta, [
    {
      path: 'environment.outside.cellular.0.type',
      value: { description: 'Mobile network technology reported by ModemManager' }
    },
    {
      path: 'environment.outside.cellular.0.rssi',
      value: { description: 'Received Signal Strength Indicator reported by ModemManager (dBm)' }
    },
    {
      path: 'environment.outside.cellular.0.rsrp',
      value: { description: 'Reference Signal Received Power reported by ModemManager (dBm)' }
    },
    {
      path: 'environment.outside.cellular.0.rsrq',
      value: { description: 'Reference Signal Received Quality reported by ModemManager (dB)' }
    },
    {
      path: 'environment.outside.cellular.0.snr',
      value: { description: 'Signal-to-noise ratio reported by ModemManager (dB)' }
    },
    {
      path: 'environment.outside.cellular.0.signalQuality',
      value: {
        units: 'ratio',
        description: 'ModemManager signal quality, normalized from percent to ratio'
      }
    },
    {
      path: 'environment.outside.cellular.0.operator',
      value: { description: 'Mobile network operator name reported by ModemManager' }
    },
    {
      path: 'environment.outside.cellular.0.connected',
      value: { description: 'Whether ModemManager reports the modem state as connected' }
    }
  ]);
});

test('clamps signal quality and publishes it as a ratio', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({ modem: { signal: { lte: { rsrp: '-82' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({
      modem: {
        generic: {
          'signal-quality': {
            value: '101'
          }
        }
      }
    })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  const values = app.messages[0].delta.updates[0].values;
  assert.ok(values.some((entry) =>
    entry.path === 'environment.outside.cellular.0.signalQuality' && entry.value === 1
  ));
});

test('preserves zero-valued signal metrics', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({
      modem: {
        signal: {
          lte: {
            rssi: '-51',
            rsrp: '-82',
            rsrq: '-10',
            's/n': '0'
          }
        }
      }
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({ modem: {} })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  const values = app.messages[0].delta.updates[0].values;
  assert.ok(values.some((entry) =>
    entry.path === 'environment.outside.cellular.0.snr' && entry.value === 0
  ));
});

test('detects technology from any available numeric signal field', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({
      modem: {
        signal: {
          lte: {
            rssi: '--',
            rsrp: '--',
            rsrq: '--',
            's/n': '0'
          }
        }
      }
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({ modem: {} })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.deepEqual(app.messages[0].delta.updates[0].values, [
    { path: 'environment.outside.cellular.0.type', value: 'lte' },
    { path: 'environment.outside.cellular.0.snr', value: 0 }
  ]);
});

test('handles multiple discovered modems independently', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({
      'modem-list': [
        '/org/freedesktop/ModemManager1/Modem/0',
        '/org/freedesktop/ModemManager1/Modem/1'
      ]
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({ modem: { signal: { gsm: { rssi: '-70' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({ modem: { '3gpp': { 'operator-name': 'OpA' } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --signal-get -J'] = {
    stdout: JSON.stringify({ modem: { signal: { umts: { rssi: '-65' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 -J'] = {
    stdout: JSON.stringify({ modem: { '3gpp': { 'operator-name': 'OpB' } } })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.equal(app.messages.length, 2);

  const publishedPaths = app.messages.flatMap(({ delta }) =>
    delta.updates[0].values.map((entry) => entry.path)
  );

  assert.ok(publishedPaths.includes('environment.outside.cellular.0.operator'));
  assert.ok(publishedPaths.includes('environment.outside.cellular.1.operator'));
});

test('publishes connected=false when ModemManager state is not connected', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    stdout: JSON.stringify({
      modem: {
        signal: {
          lte: {
            rssi: '--',
            rsrp: '--',
            rsrq: '--',
            's/n': '--'
          }
        }
      }
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({ modem: { generic: { state: 'registered' } } })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.equal(app.messages.length, 1);
  assert.deepEqual(app.messages[0].delta.updates[0].values, [
    { path: 'environment.outside.cellular.0.connected', value: false }
  ]);
});

test('logs discovery failures without publishing data', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    code: 1,
    stderr: 'mmcli not found'
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.equal(app.messages.length, 0);
  assert.equal(app.errorCalls.length, 1);
  assert.match(app.errorCalls[0], /modem discovery failed/i);
});

test('continues polling other modems when one modem fails', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L -J'] = {
    stdout: JSON.stringify({
      'modem-list': [
        '/org/freedesktop/ModemManager1/Modem/0',
        '/org/freedesktop/ModemManager1/Modem/1'
      ]
    })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
    code: 1,
    stderr: 'broken modem'
  };
  mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
    stdout: JSON.stringify({ modem: {} })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --signal-get -J'] = {
    stdout: JSON.stringify({ modem: { signal: { lte: { rsrp: '-90' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 -J'] = {
    stdout: JSON.stringify({ modem: { '3gpp': { 'operator-name': 'OpB' } } })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.equal(app.errorCalls.length, 1);
  assert.equal(app.messages.length, 1);
  assert.match(app.errorCalls[0], /modem 0/i);
});

test('stop clears the polling timer', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const tokens = [];
  const cleared = [];

  global.setInterval = (fn, interval) => {
    const token = { fn, interval };
    tokens.push(token);
    return token;
  };
  global.clearInterval = (token) => {
    cleared.push(token);
  };

  try {
    const app = makeApp();
    const plugin = pluginFactory(app);

    mockBehavior['/usr/bin/mmcli -L -J'] = { stdout: JSON.stringify({ 'modem-list': [] }) };

    plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });
    plugin.stop();

    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].interval, 30000);
    assert.deepEqual(cleared, [tokens[0]]);
    await settlePoll();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

test('skips interval polls while a previous poll is still running', async () => {
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;
  const tokens = [];

  global.setInterval = (fn, interval) => {
    const token = { fn, interval };
    tokens.push(token);
    return token;
  };
  global.clearInterval = () => {};

  try {
    const app = makeApp();
    const plugin = pluginFactory(app);

    mockBehavior['/usr/bin/mmcli -L -J'] = {
      stdout: JSON.stringify({ 'modem-list': ['/org/freedesktop/ModemManager1/Modem/0'] }),
      delayMs: 50
    };
    mockBehavior['/usr/bin/mmcli -m 0 --signal-get -J'] = {
      stdout: JSON.stringify({ modem: { signal: { lte: { rsrp: '-90' } } } })
    };
    mockBehavior['/usr/bin/mmcli -m 0 -J'] = {
      stdout: JSON.stringify({ modem: {} })
    };

    plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });
    tokens[0].fn();

    await new Promise((resolve) => setTimeout(resolve, 100));
    plugin.stop();

    assert.equal(mockBehavior['/usr/bin/mmcli -L -J'].calls, 1);
    assert.ok(app.debugCalls.some((message) => /previous poll still running/i.test(message)));
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

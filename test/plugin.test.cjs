const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let mockBehavior = {};

function makeStream({ code = 0, stdout = '', stderr = '' }) {
  const handlers = {};
  const stderrHandlers = {};

  setImmediate(() => {
    if (stdout) {
      handlers.data?.(stdout);
    }
    if (stderr) {
      stderrHandlers.data?.(stderr);
    }
    handlers.close?.(code);
  });

  return {
    on(event, cb) {
      handlers[event] = cb;
      return this;
    },
    stderr: {
      on(event, cb) {
        stderrHandlers[event] = cb;
        return this;
      }
    }
  };
}

class FakeClient {
  constructor() {
    this.handlers = {};
  }

  on(event, cb) {
    this.handlers[event] = cb;
    return this;
  }

  connect() {
    setImmediate(() => {
      this.handlers.ready?.();
    });
  }

  exec(command, cb) {
    const behavior = mockBehavior[command];

    if (behavior?.execError) {
      cb(behavior.execError);
      return;
    }

    cb(
      null,
      makeStream({
        code: behavior?.code ?? 0,
        stdout: behavior?.stdout ?? '',
        stderr: behavior?.stderr ?? ''
      })
    );
  }

  end() {}
}

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'ssh2') {
    return { Client: FakeClient };
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

test('publishes LTE signal metrics for a discovered modem', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L'] = {
    stdout: '/org/freedesktop/ModemManager1/Modem/0 [Quectel] RM520N\n'
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get --output-json'] = {
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
  mockBehavior['/usr/bin/mmcli -m 0 --output-json'] = {
    stdout: JSON.stringify({
      modem: {
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

  assert.equal(pluginId, 'signalk-openwrt');
  assert.deepEqual(values, [
    { path: 'environment.outside.cellular.0.type', value: 'lte' },
    { path: 'environment.outside.cellular.0.rssi', value: -51 },
    { path: 'environment.outside.cellular.0.rsrp', value: -82 },
    { path: 'environment.outside.cellular.0.rsrq', value: -10 },
    { path: 'environment.outside.cellular.0.snr', value: 18.2 },
    { path: 'environment.outside.cellular.0.operator', value: 'Orange' },
    { path: 'environment.outside.cellular.0.connected', value: true }
  ]);
});

test('handles multiple discovered modems independently', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L'] = {
    stdout: [
      '/org/freedesktop/ModemManager1/Modem/0 [A] A',
      '/org/freedesktop/ModemManager1/Modem/1 [B] B'
    ].join('\n')
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get --output-json'] = {
    stdout: JSON.stringify({ modem: { signal: { gsm: { rssi: '-70' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 0 --output-json'] = {
    stdout: JSON.stringify({ modem: { '3gpp': { 'operator-name': 'OpA' } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --signal-get --output-json'] = {
    stdout: JSON.stringify({ modem: { signal: { umts: { rssi: '-65' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --output-json'] = {
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

test('publishes connected=false when signal fields are unavailable', async () => {
  const app = makeApp();
  const plugin = pluginFactory(app);

  mockBehavior['/usr/bin/mmcli -L'] = {
    stdout: '/org/freedesktop/ModemManager1/Modem/0 [Quectel] RM520N\n'
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get --output-json'] = {
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
  mockBehavior['/usr/bin/mmcli -m 0 --output-json'] = {
    stdout: JSON.stringify({ modem: {} })
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

  mockBehavior['/usr/bin/mmcli -L'] = {
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

  mockBehavior['/usr/bin/mmcli -L'] = {
    stdout: [
      '/org/freedesktop/ModemManager1/Modem/0 [A] A',
      '/org/freedesktop/ModemManager1/Modem/1 [B] B'
    ].join('\n')
  };
  mockBehavior['/usr/bin/mmcli -m 0 --signal-get --output-json'] = {
    code: 1,
    stderr: 'broken modem'
  };
  mockBehavior['/usr/bin/mmcli -m 0 --output-json'] = {
    stdout: JSON.stringify({ modem: {} })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --signal-get --output-json'] = {
    stdout: JSON.stringify({ modem: { signal: { lte: { rsrp: '-90' } } } })
  };
  mockBehavior['/usr/bin/mmcli -m 1 --output-json'] = {
    stdout: JSON.stringify({ modem: { '3gpp': { 'operator-name': 'OpB' } } })
  };

  plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });

  await settlePoll();
  plugin.stop();

  assert.equal(app.errorCalls.length, 1);
  assert.equal(app.messages.length, 1);
  assert.match(app.errorCalls[0], /modem 0/i);
});

test('stop clears the polling timer', () => {
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

    mockBehavior['/usr/bin/mmcli -L'] = { stdout: '' };

    plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });
    plugin.stop();

    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].interval, 30000);
    assert.deepEqual(cleared, [tokens[0]]);
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let mockBehavior = {};

function makeStream({ code = 0, stdout = '', stderr = '', delayMs = 0 }) {
  const handlers = {};
  const stderrHandlers = {};

  setTimeout(() => {
    if (stdout) {
      handlers.data?.(stdout);
    }
    if (stderr) {
      stderrHandlers.data?.(stderr);
    }
    handlers.close?.(code);
  }, delayMs);

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
    if (behavior) {
      behavior.calls = (behavior.calls || 0) + 1;
    }

    if (behavior?.execError) {
      cb(behavior.execError);
      return;
    }

    cb(
      null,
      makeStream({
        code: behavior?.code ?? 0,
        stdout: behavior?.stdout ?? '',
        stderr: behavior?.stderr ?? '',
        delayMs: behavior?.delayMs ?? 0
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

test('preserves zero-valued signal metrics', async () => {
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
            's/n': '0'
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

  const values = app.messages[0].delta.updates[0].values;
  assert.ok(values.some((entry) =>
    entry.path === 'environment.outside.cellular.0.snr' && entry.value === 0
  ));
});

test('detects technology from any available numeric signal field', async () => {
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
            's/n': '0'
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

  assert.deepEqual(app.messages[0].delta.updates[0].values, [
    { path: 'environment.outside.cellular.0.type', value: 'lte' },
    { path: 'environment.outside.cellular.0.snr', value: 0 },
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

    mockBehavior['/usr/bin/mmcli -L'] = { stdout: '' };

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

    mockBehavior['/usr/bin/mmcli -L'] = {
      stdout: '/org/freedesktop/ModemManager1/Modem/0 [Quectel] RM520N\n',
      delayMs: 50
    };
    mockBehavior['/usr/bin/mmcli -m 0 --signal-get --output-json'] = {
      stdout: JSON.stringify({ modem: { signal: { lte: { rsrp: '-90' } } } })
    };
    mockBehavior['/usr/bin/mmcli -m 0 --output-json'] = {
      stdout: JSON.stringify({ modem: {} })
    };

    plugin.start({ host: 'router', username: 'root', password: 'secret', pollInterval: 30 });
    tokens[0].fn();

    await new Promise((resolve) => setTimeout(resolve, 100));
    plugin.stop();

    assert.equal(mockBehavior['/usr/bin/mmcli -L'].calls, 1);
    assert.ok(app.debugCalls.some((message) => /previous poll still running/i.test(message)));
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
  }
});

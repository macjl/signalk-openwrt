/**
 * signalk-openwrt
 *
 * SignalK plugin that connects to an OpenWrt router via ubus HTTP,
 * auto-discovers modems via LuCI-authorized mmcli file.exec calls, and
 * publishes cellular signal metrics to SignalK paths.
 *
 * Paths published per modem (indexed by ModemManager index):
 *   environment.outside.cellular.<index>.type
 *   environment.outside.cellular.<index>.rssi
 *   environment.outside.cellular.<index>.rsrp
 *   environment.outside.cellular.<index>.rsrq
 *   environment.outside.cellular.<index>.snr
 *   environment.outside.cellular.<index>.signalQuality
 *   environment.outside.cellular.<index>.operator
 *   environment.outside.cellular.<index>.connected
 */

'use strict';

const http = require('http');
const https = require('https');

module.exports = function (app) {
  let plugin = {};
  let pollTimer = null;
  let pollInProgress = false;
  let ubusSession = null;
  let publishedMeta = new Set();

  const CELLULAR_METADATA = {
    type: {
      description: 'Mobile network technology reported by ModemManager'
    },
    rssi: {
      description: 'Received Signal Strength Indicator reported by ModemManager (dBm)'
    },
    rsrp: {
      description: 'Reference Signal Received Power reported by ModemManager (dBm)'
    },
    rsrq: {
      description: 'Reference Signal Received Quality reported by ModemManager (dB)'
    },
    snr: {
      description: 'Signal-to-noise ratio reported by ModemManager (dB)'
    },
    signalQuality: {
      units: 'ratio',
      description: 'ModemManager signal quality, normalized from percent to ratio'
    },
    operator: {
      description: 'Mobile network operator name reported by ModemManager'
    },
    connected: {
      description: 'Whether ModemManager reports the modem state as connected'
    }
  };

  plugin.id = 'signalk-openwrt';
  plugin.name = 'OpenWrt Cellular Signal';
  plugin.description = 'Auto-discovers modems on an OpenWrt router via ubus + LuCI mmcli ACLs and publishes cellular signal metrics to SignalK';

  plugin.schema = {
    type: 'object',
    required: ['host', 'username', 'password'],
    properties: {
      host: {
        type: 'string',
        title: 'Router address',
        description: 'IP or hostname of the OpenWrt router',
        default: '192.168.1.1'
      },
      protocol: {
        type: 'string',
        title: 'ubus protocol',
        enum: ['https', 'http'],
        default: 'https'
      },
      port: {
        type: 'number',
        title: 'ubus HTTP(S) port',
        description: 'Leave empty for the protocol default (443 for HTTPS, 80 for HTTP)'
      },
      username: {
        type: 'string',
        title: 'LuCI/rpcd username',
        default: 'root'
      },
      password: {
        type: 'string',
        title: 'LuCI/rpcd password',
        format: 'password'
      },
      allowSelfSigned: {
        type: 'boolean',
        title: 'Allow self-signed HTTPS certificate',
        default: true
      },
      pollInterval: {
        type: 'number',
        title: 'Poll interval (seconds)',
        default: 30,
        minimum: 5
      }
    }
  };

  plugin.uiSchema = {
    password: {
      'ui:widget': 'password'
    }
  };

  // -------------------------------------------------------------------------
  // Plugin lifecycle
  // -------------------------------------------------------------------------

  plugin.start = function (options) {
    app.debug(`Starting OpenWrt plugin — ubus router: ${options.host}`);
    poll(options);
    pollTimer = setInterval(() => poll(options), (options.pollInterval || 30) * 1000);
  };

  plugin.stop = function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    ubusSession = null;
    publishedMeta = new Set();
    app.debug('OpenWrt plugin stopped');
  };

  // -------------------------------------------------------------------------
  // ubus JSON-RPC helpers
  // -------------------------------------------------------------------------

  function ubusRequest(options, payload) {
    return new Promise((resolve, reject) => {
      const protocol = options.protocol || 'https';
      const transport = protocol === 'http' ? http : https;
      const body = JSON.stringify(payload);
      const reqOptions = {
        host: options.host,
        port: options.port || (protocol === 'http' ? 80 : 443),
        path: '/ubus',
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      if (protocol === 'https') {
        reqOptions.rejectUnauthorized = options.allowSelfSigned === false;
      }

      const req = transport.request(reqOptions, (res) => {
        let output = '';

        res.setEncoding('utf8');
        res.on('data', (data) => { output += data; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`ubus HTTP ${res.statusCode}: ${output.trim()}`));
          }

          try {
            resolve(JSON.parse(output));
          } catch (err) {
            reject(new Error(`Invalid ubus JSON response: ${err.message}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('ubus request timed out')));
      req.write(body);
      req.end();
    });
  }

  async function login(options) {
    const response = await ubusRequest(options, {
      jsonrpc: '2.0',
      id: 1,
      method: 'call',
      params: [
        '00000000000000000000000000000000',
        'session',
        'login',
        {
          username: options.username || 'root',
          password: options.password || ''
        }
      ]
    });

    const resultCode = response?.result?.[0];
    const session = response?.result?.[1]?.ubus_rpc_session;

    if (resultCode !== 0 || !session) {
      throw new Error(`ubus login failed with code ${resultCode}`);
    }

    ubusSession = session;
  }

  async function ubusCall(options, object, method, params, retry = true) {
    if (!ubusSession) {
      await login(options);
    }

    const response = await ubusRequest(options, {
      jsonrpc: '2.0',
      id: 2,
      method: 'call',
      params: [ubusSession, object, method, params || {}]
    });

    if (response?.error?.code === -32002 && retry) {
      ubusSession = null;
      await login(options);
      return ubusCall(options, object, method, params, false);
    }

    if (response?.error) {
      throw new Error(`ubus ${object}.${method} failed: ${response.error.message}`);
    }

    const resultCode = response?.result?.[0];
    if (resultCode !== 0) {
      throw new Error(`ubus ${object}.${method} failed with code ${resultCode}`);
    }

    return response?.result?.[1] || {};
  }

  async function mmcli(options, args) {
    const result = await ubusCall(options, 'file', 'exec', {
      command: '/usr/bin/mmcli',
      params: args
    });

    if (result.code !== 0) {
      throw new Error(`mmcli ${args.join(' ')} failed: ${(result.stderr || '').trim()}`);
    }

    return result.stdout || '';
  }

  // -------------------------------------------------------------------------
  // Modem discovery via ubus file.exec mmcli -L -J
  // Returns array of integer indices: [0, 1, ...]
  // -------------------------------------------------------------------------

  async function discoverModems(options) {
    const raw = await mmcli(options, ['-L', '-J']);
    const data = JSON.parse(raw);
    const paths = data?.['modem-list'] || [];

    return paths.reduce((indices, path) => {
      const match = String(path).match(/\/Modem\/(\d+)/);
      if (match) {
        indices.push(parseInt(match[1], 10));
      }
      return indices;
    }, []);
  }

  // -------------------------------------------------------------------------
  // Signal data fetching via ubus file.exec mmcli
  // -------------------------------------------------------------------------

  async function fetchSignal(options, modemIndex) {
    const raw = await mmcli(options, ['-m', String(modemIndex), '--signal-get', '-J']);
    const data = JSON.parse(raw);
    const signal = data?.modem?.signal;

    if (!signal) throw new Error(`No signal data for modem ${modemIndex}`);

    const tech = detectTechnology(signal);

    const src = signal[tech] || {};

    return {
      type: tech,
      rssi: parseSignalNumber(src.rssi),
      rsrp: parseSignalNumber(src.rsrp),
      rsrq: parseSignalNumber(src.rsrq),
      snr: parseSignalNumber(src['s/n'] ?? src.snr)
    };
  }

  function detectTechnology(signal) {
    for (const tech of ['5g', 'lte', 'umts', 'gsm']) {
      if (hasSignalValue(signal[tech])) {
        return tech;
      }
    }
    return 'unknown';
  }

  function hasSignalValue(src) {
    if (!src) return false;
    return ['rssi', 'rsrp', 'rsrq', 's/n', 'snr'].some((key) =>
      parseSignalNumber(src[key]) !== null
    );
  }

  function parseSignalNumber(value) {
    if (value === null || value === undefined || value === '--') {
      return null;
    }

    const parsed = parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseSignalQuality(value) {
    if (value === null || value === undefined || value === '--') {
      return null;
    }

    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) {
      return null;
    }

    return Math.max(0, Math.min(100, parsed)) / 100;
  }

  async function fetchModemInfo(options, modemIndex) {
    try {
      const raw = await mmcli(options, ['-m', String(modemIndex), '-J']);
      const data = JSON.parse(raw);
      const modem = data?.modem || {};

      return {
        operator: modem?.['3gpp']?.['operator-name'] || null,
        signalQuality: parseSignalQuality(modem?.generic?.['signal-quality']?.value),
        connected: parseConnectedState(modem?.generic?.state)
      };
    } catch (e) {
      return { operator: null, signalQuality: null, connected: null };
    }
  }

  function parseConnectedState(value) {
    const state = typeof value === 'object' && value !== null ? value.value : value;

    if (state === null || state === undefined || state === '' || state === '--') {
      return null;
    }

    return String(state).toLowerCase() === 'connected';
  }

  // -------------------------------------------------------------------------
  // Main poll — auto-discovers modems then polls each one
  // -------------------------------------------------------------------------

  async function poll(options) {
    if (pollInProgress) {
      app.debug('OpenWrt poll skipped: previous poll still running');
      return;
    }

    pollInProgress = true;

    try {
      let indices;
      try {
        indices = await discoverModems(options);
      } catch (err) {
        app.error(`OpenWrt modem discovery failed: ${err.message}`);
        return;
      }

      if (indices.length === 0) {
        app.debug('No modems found on router');
        return;
      }

      app.debug(`Discovered modems: [${indices.join(', ')}]`);

      await Promise.all(indices.map(async (idx) => {
        try {
          const [signal, modemInfo] = await Promise.all([
            fetchSignal(options, idx),
            fetchModemInfo(options, idx)
          ]);

          app.debug(`Modem ${idx}: ${JSON.stringify(signal)}, info: ${JSON.stringify(modemInfo)}`);
          publishSignalK(idx, signal, modemInfo);

        } catch (err) {
          app.error(`OpenWrt poll error (modem ${idx}): ${err.message}`);
        }
      }));
    } finally {
      pollInProgress = false;
    }
  }

  // -------------------------------------------------------------------------
  // SignalK publishing
  // -------------------------------------------------------------------------

  function publishSignalK(modemIndex, signal, modemInfo) {
    const base = `environment.outside.cellular.${modemIndex}`;
    const values = [];
    const now = new Date().toISOString();
    const info = modemInfo || {};

    if (signal.type && signal.type !== 'unknown') {
      values.push({ path: `${base}.type`, value: signal.type });
    }
    if (signal.rssi !== null) {
      values.push({ path: `${base}.rssi`, value: signal.rssi });
    }
    if (signal.rsrp !== null) {
      values.push({ path: `${base}.rsrp`, value: signal.rsrp });
    }
    if (signal.rsrq !== null) {
      values.push({ path: `${base}.rsrq`, value: signal.rsrq });
    }
    if (signal.snr !== null) {
      values.push({ path: `${base}.snr`, value: signal.snr });
    }
    if (info.signalQuality !== null && info.signalQuality !== undefined) {
      values.push({ path: `${base}.signalQuality`, value: info.signalQuality });
    }
    if (info.operator) {
      values.push({ path: `${base}.operator`, value: info.operator });
    }
    if (info.connected !== null && info.connected !== undefined) {
      values.push({ path: `${base}.connected`, value: info.connected });
    }

    if (values.length === 0) {
      app.debug(`No signal values to publish for modem ${modemIndex}`);
      return;
    }

    app.handleMessage(plugin.id, {
      updates: [{
        source: { label: `${plugin.id}.${modemIndex}` },
        timestamp: now,
        values,
        ...metadataUpdate(base)
      }]
    });

    app.debug(`Modem ${modemIndex}: published ${values.length} SignalK values`);
  }

  function metadataUpdate(base) {
    if (publishedMeta.has(base)) {
      return {};
    }

    publishedMeta.add(base);

    return {
      meta: Object.entries(CELLULAR_METADATA).map(([suffix, value]) => ({
        path: `${base}.${suffix}`,
        value
      }))
    };
  }

  return plugin;
};

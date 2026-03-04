/**
 * signalk-openwrt
 *
 * SignalK plugin that connects to an OpenWrt router via SSH,
 * runs mmcli to retrieve cellular modem signal metrics, and
 * publishes them to SignalK paths.
 *
 * Supports multiple modems on the same router, each published
 * under a distinct path segment:
 *
 *   environment.outside.cellular.<id>.type
 *   environment.outside.cellular.<id>.rssi
 *   environment.outside.cellular.<id>.rsrp
 *   environment.outside.cellular.<id>.rsrq
 *   environment.outside.cellular.<id>.snr
 *   environment.outside.cellular.<id>.operator
 *   environment.outside.cellular.<id>.connected
 *
 * Where <id> is the modem's configured id (defaults to its index).
 */

'use strict';

const { Client } = require('ssh2');

module.exports = function (app) {
  let plugin = {};
  let pollTimer = null;

  plugin.id = 'signalk-openwrt';
  plugin.name = 'OpenWrt Cellular Signal';
  plugin.description = 'Publishes 4G/5G signal metrics from an OpenWrt router (via SSH + mmcli) to SignalK';

  plugin.schema = {
    type: 'object',
    required: ['host', 'username'],
    properties: {
      host: {
        type: 'string',
        title: 'Router address',
        description: 'IP or hostname of the OpenWrt router',
        default: '192.168.1.1'
      },
      port: {
        type: 'number',
        title: 'SSH port',
        default: 22
      },
      username: {
        type: 'string',
        title: 'SSH username',
        default: 'root'
      },
      password: {
        type: 'string',
        title: 'SSH password',
        description: 'Leave empty to use SSH key auth'
      },
      privateKey: {
        type: 'string',
        title: 'SSH private key path',
        description: 'Path to private key file (e.g. /home/node/.ssh/id_rsa). Used if password is empty.',
        default: ''
      },
      modems: {
        type: 'array',
        title: 'Modems',
        description: 'List of modems to poll. Each modem is identified by its ModemManager index.',
        default: [{ index: 0, id: '0' }],
        items: {
          type: 'object',
          required: ['index'],
          properties: {
            index: {
              type: 'number',
              title: 'Modem index',
              description: 'ModemManager modem index (from mmcli -L)',
              default: 0
            },
            id: {
              type: 'string',
              title: 'Path identifier',
              description: 'Segment used in the SignalK path, e.g. "lte", "5g", "sim1". Defaults to the modem index.',
              default: '0'
            }
          }
        }
      },
      pollInterval: {
        type: 'number',
        title: 'Poll interval (seconds)',
        default: 30,
        minimum: 5
      }
    }
  };

  // -------------------------------------------------------------------------
  // Plugin lifecycle
  // -------------------------------------------------------------------------

  plugin.start = function (options) {
    const modems = normalizeModems(options);
    app.debug(`Starting OpenWrt plugin — router: ${options.host}, modems: ${modems.map(m => `#${m.index}→${m.id}`).join(', ')}`);
    poll(options);
    pollTimer = setInterval(() => poll(options), (options.pollInterval || 30) * 1000);
  };

  plugin.stop = function () {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    app.debug('OpenWrt plugin stopped');
  };

  // -------------------------------------------------------------------------
  // Normalize modems config — support legacy single modemIndex field
  // -------------------------------------------------------------------------

  function normalizeModems(options) {
    // Legacy single-modem config compatibility
    if (!options.modems || options.modems.length === 0) {
      const idx = options.modemIndex || 0;
      return [{ index: idx, id: String(idx) }];
    }
    return options.modems.map(m => ({
      index: m.index ?? 0,
      id: m.id || String(m.index ?? 0)
    }));
  }

  // -------------------------------------------------------------------------
  // SSH helper — runs a single command and returns stdout
  // -------------------------------------------------------------------------

  function sshExec(options, command) {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let output = '';
      let errorOutput = '';

      const connConfig = {
        host: options.host,
        port: options.port || 22,
        username: options.username || 'root',
        readyTimeout: 10000,
        hostVerifier: () => true
      };

      if (options.password) {
        connConfig.password = options.password;
      } else if (options.privateKey) {
        const fs = require('fs');
        try {
          connConfig.privateKey = fs.readFileSync(options.privateKey);
        } catch (e) {
          return reject(new Error(`Cannot read private key: ${e.message}`));
        }
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(err);
          }
          stream.on('close', (code) => {
            conn.end();
            if (code !== 0) {
              reject(new Error(`Command exited with code ${code}: ${errorOutput.trim()}`));
            } else {
              resolve(output);
            }
          });
          stream.on('data', (data) => { output += data; });
          stream.stderr.on('data', (data) => { errorOutput += data; });
        });
      });

      conn.on('error', (err) => reject(err));
      conn.connect(connConfig);
    });
  }

  // -------------------------------------------------------------------------
  // Signal data fetching via mmcli
  // -------------------------------------------------------------------------

  async function fetchSignal(options, modemIndex) {
    const raw = await sshExec(options, `/usr/bin/mmcli -m ${modemIndex} --signal-get --output-json`);
    const data = JSON.parse(raw);
    const signal = data?.modem?.signal;

    if (!signal) throw new Error(`No signal data for modem ${modemIndex}`);

    const tech =
      (signal['5g'] && signal['5g'].rsrp !== '--') ? '5g' :
      (signal.lte  && signal.lte.rsrp  !== '--') ? 'lte' :
      (signal.umts && signal.umts.rssi !== '--') ? 'umts' :
      (signal.gsm  && signal.gsm.rssi  !== '--') ? 'gsm' :
      'unknown';

    const src = signal[tech] || {};

    return {
      type: tech,
      rssi: parseFloat(src.rssi)               || null,
      rsrp: parseFloat(src.rsrp)               || null,
      rsrq: parseFloat(src.rsrq)               || null,
      snr:  parseFloat(src['s/n'] || src.snr)  || null
    };
  }

  async function fetchOperator(options, modemIndex) {
    try {
      const raw = await sshExec(options, `/usr/bin/mmcli -m ${modemIndex} --output-json`);
      const data = JSON.parse(raw);
      return data?.modem?.['3gpp']?.['operator-name'] || null;
    } catch (e) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Main poll — iterates over all configured modems
  // -------------------------------------------------------------------------

  async function poll(options) {
    const modems = normalizeModems(options);

    await Promise.all(modems.map(async (modem) => {
      try {
        const [signal, operator] = await Promise.all([
          fetchSignal(options, modem.index),
          fetchOperator(options, modem.index)
        ]);

        app.debug(`Modem ${modem.id}: ${JSON.stringify(signal)}, operator: ${operator}`);
        publishSignalK(modem.id, signal, operator);

      } catch (err) {
        app.error(`OpenWrt poll error (modem ${modem.id}): ${err.message}`);
      }
    }));
  }

  // -------------------------------------------------------------------------
  // SignalK publishing
  // -------------------------------------------------------------------------

  function publishSignalK(modemId, signal, operator) {
    const base = `environment.outside.cellular.${modemId}`;
    const values = [];
    const now = new Date().toISOString();

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
    if (operator) {
      values.push({ path: `${base}.operator`, value: operator });
    }

    values.push({
      path: `${base}.connected`,
      value: signal.rssi !== null || signal.rsrp !== null
    });

    if (values.length === 0) {
      app.debug(`No signal values to publish for modem ${modemId}`);
      return;
    }

    app.handleMessage(plugin.id, {
      updates: [{
        source: { label: `${plugin.id}.${modemId}` },
        timestamp: now,
        values
      }]
    });

    app.debug(`Modem ${modemId}: published ${values.length} SignalK values`);
  }

  return plugin;
};

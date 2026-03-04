/**
 * signalk-openwrt
 *
 * SignalK plugin that connects to an OpenWrt router via SSH,
 * auto-discovers modems via ModemManager (mmcli -L), and
 * publishes cellular signal metrics to SignalK paths.
 *
 * Paths published per modem (indexed by ModemManager index):
 *   environment.outside.cellular.<index>.type
 *   environment.outside.cellular.<index>.rssi
 *   environment.outside.cellular.<index>.rsrp
 *   environment.outside.cellular.<index>.rsrq
 *   environment.outside.cellular.<index>.snr
 *   environment.outside.cellular.<index>.operator
 *   environment.outside.cellular.<index>.connected
 */

'use strict';

const { Client } = require('ssh2');

module.exports = function (app) {
  let plugin = {};
  let pollTimer = null;

  plugin.id = 'signalk-openwrt';
  plugin.name = 'OpenWrt Cellular Signal';
  plugin.description = 'Auto-discovers modems on an OpenWrt router via SSH + mmcli and publishes cellular signal metrics to SignalK';

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
    app.debug(`Starting OpenWrt plugin — router: ${options.host}`);
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
  // Modem discovery via mmcli -L
  // Parses output like:
  //   /org/freedesktop/ModemManager1/Modem/0 [manufacturer] model
  //   /org/freedesktop/ModemManager1/Modem/1 [manufacturer] model
  // Returns array of integer indices: [0, 1, ...]
  // -------------------------------------------------------------------------

  async function discoverModems(options) {
    const raw = await sshExec(options, '/usr/bin/mmcli -L');
    const indices = [];
    for (const line of raw.split('\n')) {
      const match = line.match(/\/Modem\/(\d+)/);
      if (match) {
        indices.push(parseInt(match[1], 10));
      }
    }
    return indices;
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
      rssi: parseFloat(src.rssi)              || null,
      rsrp: parseFloat(src.rsrp)              || null,
      rsrq: parseFloat(src.rsrq)              || null,
      snr:  parseFloat(src['s/n'] || src.snr) || null
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
  // Main poll — auto-discovers modems then polls each one
  // -------------------------------------------------------------------------

  async function poll(options) {
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
        const [signal, operator] = await Promise.all([
          fetchSignal(options, idx),
          fetchOperator(options, idx)
        ]);

        app.debug(`Modem ${idx}: ${JSON.stringify(signal)}, operator: ${operator}`);
        publishSignalK(idx, signal, operator);

      } catch (err) {
        app.error(`OpenWrt poll error (modem ${idx}): ${err.message}`);
      }
    }));
  }

  // -------------------------------------------------------------------------
  // SignalK publishing
  // -------------------------------------------------------------------------

  function publishSignalK(modemIndex, signal, operator) {
    const base = `environment.outside.cellular.${modemIndex}`;
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
      app.debug(`No signal values to publish for modem ${modemIndex}`);
      return;
    }

    app.handleMessage(plugin.id, {
      updates: [{
        source: { label: `${plugin.id}.${modemIndex}` },
        timestamp: now,
        values
      }]
    });

    app.debug(`Modem ${modemIndex}: published ${values.length} SignalK values`);
  }

  return plugin;
};

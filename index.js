/**
 * signalk-openwrt
 *
 * SignalK plugin that connects to an OpenWrt router via SSH,
 * runs mmcli to retrieve cellular modem signal metrics, and
 * publishes them to SignalK paths.
 *
 * SignalK paths published:
 *   environment.outside.cellular.type          - Network type (lte, 5g, umts...)
 *   environment.outside.cellular.rssi          - RSSI in dBm
 *   environment.outside.cellular.rsrp          - RSRP in dBm (LTE/5G)
 *   environment.outside.cellular.rsrq          - RSRQ in dB  (LTE/5G)
 *   environment.outside.cellular.snr           - SNR/SINR in dB (LTE/5G)
 *   environment.outside.cellular.operator      - Operator name
 *   environment.outside.cellular.connected     - Connection status (bool)
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
      modemIndex: {
        type: 'number',
        title: 'Modem index',
        description: 'ModemManager modem index (usually 0)',
        default: 0
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
    app.debug(`Starting OpenWrt plugin — router: ${options.host}, modem index: ${options.modemIndex || 0}`);
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
        // Tolerate OpenWrt's often self-signed or missing host key
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

  async function fetchSignal(options) {
    const modemIdx = options.modemIndex || 0;
    const raw = await sshExec(options, `/usr/bin/mmcli -m ${modemIdx} --signal-get --output-json`);
    const data = JSON.parse(raw);
    const signal = data?.modem?.signal;

    if (!signal) throw new Error('No signal data in mmcli output');

    // Detect best available technology
    const tech =
      (signal['5g'] && signal['5g'].rsrp !== '--') ? '5g' :
      (signal.lte  && signal.lte.rsrp  !== '--') ? 'lte' :
      (signal.umts && signal.umts.rssi !== '--') ? 'umts' :
      (signal.gsm  && signal.gsm.rssi  !== '--') ? 'gsm' :
      'unknown';

    const src = signal[tech] || {};

    return {
      type: tech,
      rssi: parseFloat(src.rssi)  || null,
      rsrp: parseFloat(src.rsrp)  || null,
      rsrq: parseFloat(src.rsrq)  || null,
      snr:  parseFloat(src['s/n'] || src.snr) || null
    };
  }

  async function fetchOperator(options) {
    try {
      const modemIdx = options.modemIndex || 0;
      const raw = await sshExec(options, `/usr/bin/mmcli -m ${modemIdx} --output-json`);
      const data = JSON.parse(raw);
      return data?.modem?.['3gpp']?.['operator-name'] || null;
    } catch (e) {
      return null; // Operator name is optional
    }
  }

  // -------------------------------------------------------------------------
  // Main poll
  // -------------------------------------------------------------------------

  async function poll(options) {
    try {
      const [signal, operator] = await Promise.all([
        fetchSignal(options),
        fetchOperator(options)
      ]);

      app.debug(`Signal: ${JSON.stringify(signal)}, operator: ${operator}`);
      publishSignalK(signal, operator);

    } catch (err) {
      app.error(`OpenWrt poll error: ${err.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // SignalK publishing
  // -------------------------------------------------------------------------

  function publishSignalK(signal, operator) {
    const values = [];
    const now = new Date().toISOString();

    if (signal.type && signal.type !== 'unknown') {
      values.push({ path: 'environment.outside.cellular.type', value: signal.type });
    }
    if (signal.rssi !== null) {
      values.push({ path: 'environment.outside.cellular.rssi', value: signal.rssi });
    }
    if (signal.rsrp !== null) {
      values.push({ path: 'environment.outside.cellular.rsrp', value: signal.rsrp });
    }
    if (signal.rsrq !== null) {
      values.push({ path: 'environment.outside.cellular.rsrq', value: signal.rsrq });
    }
    if (signal.snr !== null) {
      values.push({ path: 'environment.outside.cellular.snr', value: signal.snr });
    }
    if (operator) {
      values.push({ path: 'environment.outside.cellular.operator', value: operator });
    }

    values.push({
      path: 'environment.outside.cellular.connected',
      value: signal.rssi !== null || signal.rsrp !== null
    });

    if (values.length === 0) {
      app.debug('No signal values to publish');
      return;
    }

    app.handleMessage(plugin.id, {
      updates: [{
        source: { label: plugin.id },
        timestamp: now,
        values
      }]
    });

    app.debug(`Published ${values.length} SignalK values`);
  }

  return plugin;
};

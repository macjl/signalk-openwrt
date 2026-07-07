# signalk-openwrt

SignalK plugin that connects to an OpenWrt 4G/5G router via **ubus HTTP(S)**, auto-discovers modems via LuCI-authorized ModemManager `mmcli` calls, and publishes cellular signal metrics to SignalK paths.

Modems are discovered dynamically at each poll — no manual configuration required. If a modem is added or removed, the plugin adapts automatically.

Tested on GL.iNet GL-X300B (OpenWrt 24.10).

## Polling behavior

At each poll, the plugin discovers currently available modems, reads their signal
metrics, and publishes one SignalK update per modem.

If a poll is still running when the next interval fires, the new poll is skipped.
This avoids overlapping ubus requests on slow or temporarily unresponsive routers.

Network technology is selected from the first available technology that exposes a
numeric signal value, in this priority order: `5g`, `lte`, `umts`, `gsm`.
Numeric zero values (for example `0` dB SNR) are preserved and published.

## SignalK paths published

For each discovered modem (indexed by its ModemManager index):

| Path | Description | Unit |
|------|-------------|------|
| `environment.outside.cellular.<index>.type` | Network technology | string (`lte`, `5g`, `umts`, `gsm`) |
| `environment.outside.cellular.<index>.rssi` | Received Signal Strength Indicator | dBm |
| `environment.outside.cellular.<index>.rsrp` | Reference Signal Received Power (LTE/5G) | dBm |
| `environment.outside.cellular.<index>.rsrq` | Reference Signal Received Quality (LTE/5G) | dB |
| `environment.outside.cellular.<index>.snr` | Signal-to-Noise Ratio / SINR (LTE/5G) | dB |
| `environment.outside.cellular.<index>.signalQuality` | ModemManager signal quality | ratio (`0` to `1`) |
| `environment.outside.cellular.<index>.operator` | Mobile operator name | string |
| `environment.outside.cellular.<index>.connected` | Whether ModemManager reports the modem state as connected | boolean |

With a single modem (index 0), paths are:
`environment.outside.cellular.0.rssi`, `environment.outside.cellular.0.rsrp`, etc.

The plugin also publishes Signal K metadata for each concrete modem path. The
`signalQuality` path declares `units: "ratio"`. Radio signal paths include their
dB/dBm unit in the description because these units are not part of the standard
Signal K unit preference definitions.

## Requirements

### On the OpenWrt router

- **ModemManager** must be installed and running:
  ```sh
  opkg update
  opkg install modemmanager luci-proto-modemmanager
  /etc/init.d/modemmanager enable
  /etc/init.d/modemmanager start
  ```
- **LuCI/rpcd ubus access** must be enabled over HTTP(S), typically provided by LuCI/uhttpd at `/ubus`.
- **luci-proto-modemmanager** must be installed, because this plugin intentionally uses the same `mmcli` ACLs as LuCI.
- Signal polling must be enabled on each modem:
  ```sh
  mmcli -m 0 --signal-setup=30
  ```

### On the SignalK server

No additional npm dependencies.

## Configuration

In SignalK: **Server → Plugin Config → OpenWrt Cellular Signal**

| Option | Description | Default |
|--------|-------------|---------|
| Router address | IP or hostname of the OpenWrt router | `192.168.1.1` |
| ubus protocol | `https` or `http` | `https` |
| ubus HTTP(S) port | Router web port | protocol default |
| Username | LuCI/rpcd username | `root` |
| Password | LuCI/rpcd password, masked in the configuration UI | — |
| Allow self-signed HTTPS certificate | Accept the router's self-signed certificate | `true` |
| Poll interval | Seconds between polls | `30` |

## Installation

### From npm

```sh
npm install --prefix ~/.signalk signalk-openwrt
```

### From GitHub

```sh
npm install --prefix ~/.signalk https://github.com/macjl/signalk-openwrt.git
```

Restart SignalK after installation, then configure the plugin via **Server → Plugin Config**.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT — Jean-Laurent Girod

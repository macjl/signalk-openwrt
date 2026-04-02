# signalk-openwrt

SignalK plugin that connects to an OpenWrt 4G/5G router via **SSH**, auto-discovers modems via ModemManager (`mmcli -L`), and publishes cellular signal metrics to SignalK paths.

Modems are discovered dynamically at each poll — no manual configuration required. If a modem is added or removed, the plugin adapts automatically.

Tested on GL.iNet GL-X300B (OpenWrt 24.10).

## SignalK paths published

For each discovered modem (indexed by its ModemManager index):

| Path | Description | Unit |
|------|-------------|------|
| `environment.outside.cellular.<index>.type` | Network technology | string (`lte`, `5g`, `umts`, `gsm`) |
| `environment.outside.cellular.<index>.rssi` | Received Signal Strength Indicator | dBm |
| `environment.outside.cellular.<index>.rsrp` | Reference Signal Received Power (LTE/5G) | dBm |
| `environment.outside.cellular.<index>.rsrq` | Reference Signal Received Quality (LTE/5G) | dB |
| `environment.outside.cellular.<index>.snr` | Signal-to-Noise Ratio / SINR (LTE/5G) | dB |
| `environment.outside.cellular.<index>.operator` | Mobile operator name | string |
| `environment.outside.cellular.<index>.connected` | Modem connection status | boolean |

With a single modem (index 0), paths are:
`environment.outside.cellular.0.rssi`, `environment.outside.cellular.0.rsrp`, etc.

## Requirements

### On the OpenWrt router

- **ModemManager** must be installed and running:
  ```sh
  opkg update
  opkg install modemmanager
  /etc/init.d/modemmanager enable
  /etc/init.d/modemmanager start
  ```
- **SSH access** must be enabled (enabled by default on OpenWrt)
- Signal polling must be enabled on each modem:
  ```sh
  mmcli -m 0 --signal-setup=30
  ```

### On the SignalK server

No additional dependencies — `ssh2` is installed automatically.

## Configuration

In SignalK: **Server → Plugin Config → OpenWrt Cellular Signal**

| Option | Description | Default |
|--------|-------------|---------|
| Router address | IP or hostname of the OpenWrt router | `192.168.1.1` |
| SSH port | SSH port | `22` |
| Username | SSH username | `root` |
| Password | SSH password (leave empty to use key auth) | — |
| SSH private key path | Path to private key file (if no password) | — |
| Poll interval | Seconds between polls | `30` |

### SSH key authentication (recommended)

Instead of storing a password, you can use SSH key authentication:

1. Generate a key pair on the SignalK server (if not already done):
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/id_signalk_openwrt
   ```
2. Copy the public key to the router:
   ```sh
   ssh-copy-id -i ~/.ssh/id_signalk_openwrt.pub root@192.168.1.1
   ```
3. In the plugin config, leave **Password** empty and set **SSH private key path** to `/home/node/.ssh/id_signalk_openwrt`

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

### 0.4.1
- Added a built-in Node test suite covering modem discovery, publishing, and error handling

### 0.4.0
- Dynamic modem auto-discovery via `mmcli -L` — no manual configuration required
- Modems indexed by their ModemManager index in SignalK paths

### 0.3.0
- Multi-modem support with configurable path id per modem

### 0.2.0
- Switched from ubus JSON-RPC to SSH + mmcli for broader compatibility
- Added SSH key authentication support
- Auto-detection of best available technology (5G, LTE, UMTS, GSM)

### 0.1.0
- Initial release (ubus JSON-RPC, experimental)

## License

MIT — Jean-Laurent Girod

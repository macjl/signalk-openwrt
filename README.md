# signalk-openwrt

SignalK plugin that connects to an OpenWrt 4G/5G router via **SSH** and publishes cellular modem signal metrics to SignalK paths, using ModemManager (`mmcli`).

Tested on GL.iNet GL-X300B (OpenWrt 24.10).

## SignalK paths published

| Path | Description | Unit |
|------|-------------|------|
| `environment.outside.cellular.type` | Network technology | string (`lte`, `5g`, `umts`, `gsm`) |
| `environment.outside.cellular.rssi` | Received Signal Strength Indicator | dBm |
| `environment.outside.cellular.rsrp` | Reference Signal Received Power (LTE/5G) | dBm |
| `environment.outside.cellular.rsrq` | Reference Signal Received Quality (LTE/5G) | dB |
| `environment.outside.cellular.snr` | Signal-to-Noise Ratio / SINR (LTE/5G) | dB |
| `environment.outside.cellular.operator` | Mobile operator name | string |
| `environment.outside.cellular.connected` | Modem connection status | boolean |

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
- SSH signal polling must be enabled on the modem:
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
| Modem index | ModemManager modem index | `0` |
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

### 0.2.0
- Switched from ubus JSON-RPC to SSH + mmcli for broader compatibility
- Added SSH key authentication support
- Auto-detection of best available technology (5G, LTE, UMTS, GSM)

### 0.1.0
- Initial release (ubus JSON-RPC, experimental)

## License

MIT — Jean-Laurent Girod

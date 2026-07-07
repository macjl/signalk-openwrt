# Changelog

## 0.5.0

- Replace SSH polling with ubus HTTP(S) calls to LuCI-authorized `mmcli` commands.
- Remove SSH dependencies and SSH configuration fields.
- Add LuCI/rpcd configuration fields, including masked password input.
- Publish ModemManager signal quality as `environment.outside.cellular.<index>.signalQuality` in Signal K ratio units.
- Publish Signal K metadata descriptions for every cellular path and `units: "ratio"` for signal quality.
- Derive `environment.outside.cellular.<index>.connected` from ModemManager's real modem state.
- Package App Store metadata and app icon.

## 0.4.3

- Preserve zero-valued signal metrics instead of treating them as missing.
- Detect network technology from any available numeric signal field.
- Skip overlapping polls when a previous poll is still running.

## 0.4.2

- Synced package metadata with the npm release.

## 0.4.1

- Added a built-in Node test suite covering modem discovery, publishing, and error handling.

## 0.4.0

- Dynamic modem auto-discovery via `mmcli -L` - no manual configuration required.
- Modems indexed by their ModemManager index in SignalK paths.

## 0.3.0

- Multi-modem support with configurable path id per modem.

## 0.2.0

- Switched from ubus JSON-RPC to SSH + mmcli for broader compatibility.
- Added SSH key authentication support.
- Auto-detection of best available technology (5G, LTE, UMTS, GSM).

## 0.1.0

- Initial release (ubus JSON-RPC, experimental).

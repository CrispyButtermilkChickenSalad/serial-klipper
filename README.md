# serial-klipper

Connect to a Klipper host over a serial connection: reach Moonraker + Fluidd/Mainsail,
the Klipper API socket, and auxiliary MCU serial ports from a PC with only a serial link.

```
PC                                         Klipper host
serial-klipper (client) <== serial link ==> serial-klipper-host (systemd)
  localhost:8080  -> Fluidd/Mainsail (:80)     -> localhost TCP (80, 7125, 7126 ...)
  localhost:7125  -> Moonraker                 -> ~/printer_data/comms/*.sock (Klipper API)
  localhost:N     -> raw serial of an MCU      -> /dev/serial/by-id/*, ttyUSB*, ttyACM*
```

Frames are COBS-delimited with a CRC-16; every connection is a multiplexed channel with
per-channel flow control, so several browser connections and MCU consoles share one link.
Corrupted frames are dropped (UARTs and USB are normally reliable; there is no retransmit).

## Host install (Klipper host, as the Klipper user)

```sh
./deploy/install.sh /dev/ttyUSB1 115200     # link port, baud
```

This copies the daemon to `~/serial-klipper`, writes `/etc/default/serial-klipper`
(`LINK`, `BAUD`) and enables `serial-klipper-host.service`. The link port must be a
serial device not used by Klipper or a getty (a USB-serial adapter, a spare UART, or a
USB gadget `/dev/ttyGS0`). Needs `python3` and `pyserial`.

## PC usage

```sh
pip install .                                   # or: python -m serial_klipper ...
serial-klipper -p COM5 list                     # host info + serial devices (and who holds them)
serial-klipper -p COM5 connect --web 8080       # Fluidd/Mainsail on http://localhost:8080, Moonraker :7125
serial-klipper -p COM5 connect -L 7127:unix:klippy.sock      # Klipper API socket as TCP
serial-klipper -p COM5 connect -L 7126:7126                  # e.g. the ALPS-logger bridge
serial-klipper -p COM5 connect --serial usb-Klipper_xyz:5000:250000   # MCU as raw TCP on :5000
serial-klipper -p COM5 console usb-1a86_USB_Serial-if00-port0 --baud-dev 115200   # Ctrl-] exits
```

`-p` also accepts pyserial URLs (e.g. `socket://host:port`). Only one process can hold the
link, so combine `--web`, `-L` and `--serial` in a single `connect`.

## Auxiliary MCUs and Klipper

Klipper keeps its MCU ports open. Opening one yourself would corrupt its protocol, so the host
refuses ports already in use unless you pass `--force`. Use the Klipper API socket / Moonraker
for MCUs Klipper owns; use raw passthrough for MCUs it does not (e.g. a board on stock firmware).

## Optional web UI (GitHub Pages)

`web/` is a static app that hosts Fluidd and Mainsail in your browser and tunnels them over a
serial port using the Web Serial API (Chrome / Edge, https or localhost). Nothing is uploaded: the
page talks to `serial-klipper-host` on the Klipper machine directly.

1. Run the host daemon (see above) on the port wired to your PC.
2. Open the Pages site, click **Connect serial port**, pick the port, then **Open Fluidd / Mainsail**.
3. The page also lists the host's serial devices and offers a raw console for each.

Notes: the apps are fetched at deploy time by `tools/build_site.py` (`.github/workflows/pages.yml`;
enable Pages with source "GitHub Actions"). Webcam streams are not supported, and file uploads/thumbnails
are limited by link speed. Keep the launcher tab open; it owns the serial port.

Try it without hardware: `ssh -L 9000:127.0.0.1:9000 host`, run the host with `--listen 127.0.0.1:9000`,
`python tools/ws_bridge.py --tcp 127.0.0.1:9000`, `python tools/build_site.py --base=` and serve `_site`,
then open `http://localhost:8000/?link=ws://127.0.0.1:9001`.

## Link speed and config backup (web UI)

After connecting, **Link speed** switches the serial link (up to 3 Mbaud) without touching the host: the daemon
changes rate, the page reopens the port at the new rate and re-handshakes. If no handshake arrives within 15 s the
host reverts to its configured `BAUD`, so a rate the UART can't sustain never strands the link. Set the permanent
default in `/etc/default/serial-klipper`.

**Config backup** downloads every file in Moonraker's `config` root as a zip, over the same link.
Klipper itself can't run inside a web page (it needs native timing-critical code and raw MCU access), so
the page only talks to a host that runs Klipper.

## Security

The host only allows localhost TCP ports 80, 81, 443, 7125, 7126 (extend with `--allow-port`),
`*.sock` files in the comms directory and serial devices. Anyone with access to the link has
Moonraker access, so treat it like a trusted LAN client.

## Tests

`python -m unittest discover -s tests`

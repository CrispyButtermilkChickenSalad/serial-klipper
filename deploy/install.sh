#!/bin/sh
# Install the serial-klipper host daemon on the Klipper host (run as the Klipper user).
#   ./deploy/install.sh [LINK_PORT] [BAUD]
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
dest="$HOME/serial-klipper"
user=$(id -un)
link=${1:-}
baud=${2:-}

mkdir -p "$dest"
rm -rf "$dest/serial_klipper"
cp -r "$here/serial_klipper" "$dest/"
find "$dest" -name __pycache__ -prune -exec rm -rf {} +

python3 -c 'import serial' 2>/dev/null || sudo apt-get install -y python3-serial

if [ ! -f /etc/default/serial-klipper ]; then
    printf 'LINK=%s\nBAUD=%s\n' "${link:-/dev/ttyUSB1}" "${baud:-115200}" | sudo tee /etc/default/serial-klipper >/dev/null
else
    [ -n "$link" ] && sudo sed -i "s|^LINK=.*|LINK=$link|" /etc/default/serial-klipper
    [ -n "$baud" ] && sudo sed -i "s|^BAUD=.*|BAUD=$baud|" /etc/default/serial-klipper
fi

sed -e "s|@USER@|$user|g" -e "s|@DIR@|$dest|g" "$here/deploy/serial-klipper-host.service" \
    | sudo tee /etc/systemd/system/serial-klipper-host.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable serial-klipper-host
sudo systemctl restart serial-klipper-host
sleep 1
systemctl --no-pager --lines=5 status serial-klipper-host || true

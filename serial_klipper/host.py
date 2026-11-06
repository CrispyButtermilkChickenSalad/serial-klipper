"""Host daemon: runs on the Klipper host, serves channels over a serial link."""
import argparse
import asyncio
import glob
import json
import os
import re
import socket
import sys
import threading

import serial

from . import __version__, proto
from .link import SerialLink, StreamLink
from .mux import Session

DEFAULT_PORTS = (80, 81, 443, 7125, 7126)
LINK_BAUDS = (9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 1500000, 2000000, 3000000)
REVERT_SECONDS = 15
DEV_DIRS = ("/dev/serial/by-id", "/dev/serial/by-path")


def users_of(real):
    """PIDs (as 'pid:comm') holding `real` open, best effort via /proc."""
    out = []
    for fd in glob.glob("/proc/[0-9]*/fd/*"):
        try:
            if os.path.realpath(fd) == real:
                pid = fd.split("/")[2]
                with open(f"/proc/{pid}/comm") as f:
                    out.append(f"{pid}:{f.read().strip()}")
        except OSError:
            pass
    return sorted(set(out))


def list_devices(link_real=None):
    devs, seen = [], set()
    for d in DEV_DIRS:
        for p in sorted(glob.glob(d + "/*")):
            real = os.path.realpath(p)
            seen.add(real)
            devs.append({"name": os.path.basename(p), "path": p, "real": real,
                         "in_use": users_of(real), "link": real == link_real})
    for real in sorted(glob.glob("/dev/ttyUSB*") + glob.glob("/dev/ttyACM*")):
        if real not in seen:
            devs.append({"name": os.path.basename(real), "path": real, "real": real,
                         "in_use": users_of(real), "link": real == link_real})
    return devs


class Host:
    def __init__(self, args):
        self.args = args
        self.ports = set(args.allow_port or DEFAULT_PORTS)
        self.comms = os.path.realpath(os.path.expanduser(args.comms_dir))
        self.link_real = None
        self.link = None
        self.revert = None
        if args.link and args.link.startswith("/dev/"):
            self.link_real = os.path.realpath(args.link)

    async def on_open(self, session, ch, params):
        kind = params.get("kind")
        fn = getattr(self, "open_" + str(kind), None)
        if not fn:
            raise ValueError(f"unknown channel kind {kind!r}")
        await fn(session, ch, params)

    async def open_info(self, session, ch, p):
        info = {"version": __version__, "hostname": socket.gethostname(),
                "tcp_ports": sorted(self.ports), "comms_dir": self.comms,
                "link_baud": getattr(getattr(self.link, "ser", None), "baudrate", None), "bauds": list(LINK_BAUDS),
                "sockets": sorted(os.path.basename(s) for s in glob.glob(self.comms + "/*.sock")),
                "devices": await asyncio.get_running_loop().run_in_executor(None, list_devices, self.link_real)}
        ch.start(self._null)
        await session.reply_open(ch, True)
        await ch.send(json.dumps(info).encode())
        await ch.close()

    async def _null(self, data):
        pass

    async def open_baud(self, session, ch, p):
        """Switch the link speed at runtime; reverts to --baud unless the client re-handshakes in time."""
        baud = int(p.get("baud", 0))
        if baud not in LINK_BAUDS:
            raise ValueError(f"unsupported link baud {baud}")
        if not hasattr(self.link, "set_baud"):
            raise ValueError("this link has no baud rate")
        ch.start(self._null)
        await session.reply_open(ch, True)
        await ch.close()
        self._cancel_revert()
        self.revert = asyncio.ensure_future(self._switch(baud))

    async def _switch(self, baud):
        await asyncio.sleep(0.7)  # let the reply drain at the old speed
        await self.link.set_baud(baud)
        print(f"link baud -> {baud}", flush=True)
        if baud != self.args.baud:
            await self._revert()

    async def _revert(self):
        await asyncio.sleep(REVERT_SECONDS)
        await self.link.set_baud(self.args.baud)
        print(f"no handshake at the new speed; link baud -> {self.args.baud}", flush=True)

    def _cancel_revert(self):
        if self.revert:
            self.revert.cancel()
            self.revert = None

    async def _bridge(self, session, ch, reader, writer):
        async def sink(data):
            writer.write(data)
            await writer.drain()

        async def pump():
            try:
                while True:
                    data = await reader.read(proto.MAX_PAYLOAD)
                    if not data:
                        break
                    await ch.send(data)
            except (ConnectionError, OSError):
                pass
            await ch.close()

        task = asyncio.ensure_future(pump())

        def closed():
            task.cancel()
            writer.close()

        ch.start(sink, closed)
        await session.reply_open(ch, True)

    async def open_tcp(self, session, ch, p):
        host, port = p.get("host", "127.0.0.1"), int(p.get("port", 0))
        if host not in ("127.0.0.1", "localhost", "::1") or port not in self.ports:
            raise PermissionError(f"{host}:{port} is not allowed (allowed ports: {sorted(self.ports)})")
        r, w = await asyncio.open_connection(host, port)
        await self._bridge(session, ch, r, w)

    async def open_unix(self, session, ch, p):
        name = str(p.get("name", ""))
        if os.path.basename(name) != name or not name.endswith(".sock"):
            raise PermissionError("only *.sock files in the comms directory are allowed")
        r, w = await asyncio.open_unix_connection(os.path.join(self.comms, name))
        await self._bridge(session, ch, r, w)

    def resolve_device(self, name):
        if os.path.basename(name) != name:
            raise PermissionError("device must be a bare name")
        for d in DEV_DIRS:
            if os.path.exists(os.path.join(d, name)):
                return os.path.realpath(os.path.join(d, name))
        if re.fullmatch(r"tty(USB|ACM)\d+", name) and os.path.exists("/dev/" + name):
            return "/dev/" + name
        raise FileNotFoundError(f"no such device {name!r}")

    async def open_serial(self, session, ch, p):
        loop = asyncio.get_running_loop()
        real = self.resolve_device(str(p.get("device", "")))
        if real == self.link_real:
            raise PermissionError("that device carries this link")
        busy = users_of(real)
        if busy and not p.get("force"):
            raise PermissionError(f"{real} is in use by {', '.join(busy)} (Klipper owns it?); "
                                  "use --force to open anyway")
        ser = serial.Serial(real, int(p.get("baud", 115200)), timeout=0.1, write_timeout=5)
        stop = threading.Event()

        def reader():
            try:
                while not stop.is_set():
                    data = ser.read(ser.in_waiting or 1)
                    if data:
                        asyncio.run_coroutine_threadsafe(ch.send(data), loop).result()
            except Exception:
                pass
            asyncio.run_coroutine_threadsafe(ch.close(), loop)

        async def sink(data):
            await loop.run_in_executor(None, ser.write, data)

        def closed():
            stop.set()
            ser.close()

        ch.start(sink, closed)
        threading.Thread(target=reader, daemon=True).start()
        await session.reply_open(ch, True)

    async def serve_link(self, link):
        session = Session(link.write)
        session.on_open = lambda ch, p: self.on_open(session, ch, p)

        async def on_reset(peer):
            self._cancel_revert()
            await session.send_hello("host")

        session.on_reset = on_reset
        self.link = link
        try:
            while True:
                data = await link.read()
                if not data:
                    break
                await session.feed(data)
        finally:
            self._cancel_revert()
            await session.reset()
            link.close()

    async def run(self):
        a = self.args
        if a.listen:
            host, _, port = a.listen.rpartition(":")

            async def handle(r, w):
                await self.serve_link(StreamLink(r, w))

            srv = await asyncio.start_server(handle, host or "127.0.0.1", int(port))
            print(f"listening on {a.listen}", flush=True)
            async with srv:
                await srv.serve_forever()
        while True:
            try:
                link = SerialLink(a.link, a.baud)
                print(f"link {a.link} @ {a.baud} open", flush=True)
                await self.serve_link(link)
            except (serial.SerialException, OSError) as e:
                print(f"link error: {e}", file=sys.stderr, flush=True)
            await asyncio.sleep(2)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="serial-klipper-host", description=__doc__)
    ap.add_argument("--link", help="serial port carrying the link (e.g. /dev/ttyGS0, /dev/ttyUSB1)")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--listen", help="[host:]port TCP listener instead of a serial link (testing)")
    ap.add_argument("--allow-port", type=int, action="append", help="localhost TCP port clients may reach")
    ap.add_argument("--comms-dir", default="~/printer_data/comms")
    args = ap.parse_args(argv)
    if not (args.link or args.listen):
        ap.error("--link or --listen required")
    try:
        asyncio.run(Host(args).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()

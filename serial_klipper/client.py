"""PC client: forwards local TCP ports and serial consoles over the serial link."""
import argparse
import asyncio
import json
import os
import sys
import threading

from . import __version__
from .link import SerialLink
from .mux import Session


class Client:
    def __init__(self, args):
        self.args = args
        self.session = None
        self.link = None

    async def connect(self):
        self.link = SerialLink(self.args.port, self.args.baud)
        self.session = Session(self.link.write)
        self.reader = asyncio.ensure_future(self._read())
        for _ in range(5):
            await self.session.send_hello("client")
            try:
                await asyncio.wait_for(self.session.hello.wait(), 1.5)
                return
            except asyncio.TimeoutError:
                pass
        raise ConnectionError(f"no answer from the host daemon on {self.args.port}")

    async def _read(self):
        while True:
            data = await self.link.read()
            if not data:
                print("link closed", file=sys.stderr)
                os._exit(1)
            await self.session.feed(data)

    async def info(self):
        buf = bytearray()

        async def sink(d):
            buf.extend(d)

        done = asyncio.get_running_loop().create_future()
        ch = await self.session.open({"kind": "info"}, sink, lambda: done.set_result(None) if not done.done() else None)
        await asyncio.wait_for(done, 10)
        return json.loads(buf)

    async def forward(self, local_port, params, bind="127.0.0.1"):
        async def handle(r, w):
            try:
                async def sink(d):
                    w.write(d)
                    await w.drain()

                ch = await self.session.open(params, sink, w.close)
            except ConnectionError as e:
                print(f"[{local_port}] {e}", file=sys.stderr)
                w.close()
                return
            try:
                while True:
                    d = await r.read(1024)
                    if not d:
                        break
                    await ch.send(d)
            except (ConnectionError, OSError):
                pass
            await ch.close()

        srv = await asyncio.start_server(handle, bind, local_port)
        return srv

    async def console(self, device, baud, force):
        done = asyncio.get_running_loop().create_future()

        async def sink(d):
            sys.stdout.buffer.write(d)
            sys.stdout.buffer.flush()

        ch = await self.session.open({"kind": "serial", "device": device, "baud": baud, "force": force},
                                     sink, lambda: done.done() or done.set_result(None))
        print(f"-- {device} @ {baud}; Ctrl-] to exit --", file=sys.stderr)
        loop = asyncio.get_running_loop()

        def stdin_thread():
            for key in keys():
                if key == b"\x1d":
                    break
                asyncio.run_coroutine_threadsafe(ch.send(key), loop)
            loop.call_soon_threadsafe(lambda: done.done() or done.set_result(None))

        threading.Thread(target=stdin_thread, daemon=True).start()
        await done
        await ch.close()


def keys():
    if os.name == "nt":
        import msvcrt
        while True:
            c = msvcrt.getwch()
            if c in ("\x00", "\xe0"):
                msvcrt.getwch()
                continue
            yield (b"\r" if c == "\r" else c.encode())
    else:
        import termios
        import tty
        fd = sys.stdin.fileno()
        old = termios.tcgetattr(fd) if sys.stdin.isatty() else None
        try:
            if old:
                tty.setraw(fd)
            while True:
                c = os.read(fd, 1)
                if not c:
                    return
                yield c
        finally:
            if old:
                termios.tcsetattr(fd, termios.TCSADRAIN, old)


def parse_forward(spec):
    """LOCAL:PORT | LOCAL:HOST:PORT | LOCAL:unix:NAME.sock"""
    parts = spec.split(":")
    local = int(parts[0])
    if len(parts) == 2:
        return local, {"kind": "tcp", "host": "127.0.0.1", "port": int(parts[1])}
    if len(parts) == 3 and parts[1] == "unix":
        return local, {"kind": "unix", "name": parts[2]}
    if len(parts) == 3:
        return local, {"kind": "tcp", "host": parts[1], "port": int(parts[2])}
    raise argparse.ArgumentTypeError(f"bad forward spec {spec!r}")


def parse_serial(spec):
    """NAME:LOCALPORT[:BAUD] - expose a host serial device as a local raw TCP port."""
    parts = spec.rsplit(":", 2)
    if len(parts) == 3 and parts[1].isdigit() and parts[2].isdigit():
        return parts[0], int(parts[1]), int(parts[2])
    name, _, port = spec.rpartition(":")
    return name, int(port), 115200


def print_info(info):
    print(f"host {info['hostname']} (serial-klipper {info['version']})")
    print(f"tcp ports: {info['tcp_ports']}  sockets: {', '.join(info['sockets']) or '-'}")
    for d in info["devices"]:
        state = "LINK" if d["link"] else ("in use by " + ",".join(d["in_use"]) if d["in_use"] else "free")
        print(f"  {d['name']:<55} {d['real']:<16} {state}")


async def amain(args):
    c = Client(args)
    await c.connect()
    if args.cmd == "list":
        print_info(await c.info())
        return
    if args.cmd == "console":
        await c.console(args.device, args.baud_dev, args.force)
        return
    servers = []
    fwd = list(args.forward or [])
    if args.web:
        fwd += [(args.web, {"kind": "tcp", "host": "127.0.0.1", "port": 80}),
                (7125, {"kind": "tcp", "host": "127.0.0.1", "port": 7125})]
    for local, params in fwd:
        servers.append(await c.forward(local, params))
        print(f"localhost:{local} -> {params}", flush=True)
    for name, local, baud in args.serial or []:
        servers.append(await c.forward(local, {"kind": "serial", "device": name, "baud": baud,
                                               "force": args.force}))
        print(f"localhost:{local} -> serial {name} @ {baud}", flush=True)
    if args.web:
        print(f"Fluidd/Mainsail: http://localhost:{args.web}   Moonraker: http://localhost:7125", flush=True)
    if not servers:
        print("nothing to forward; use --web, -L or --serial", file=sys.stderr)
        return
    await asyncio.Event().wait()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="serial-klipper", description=__doc__)
    ap.add_argument("--port", "-p", required=True, help="serial port or pyserial URL (COM5, /dev/ttyUSB0, socket://h:p)")
    ap.add_argument("--baud", "-b", type=int, default=115200, help="link baud rate")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="show host info and serial devices")
    pc = sub.add_parser("console", help="interactive terminal on a host serial device")
    pc.add_argument("device")
    pc.add_argument("--baud-dev", type=int, default=115200)
    pc.add_argument("--force", action="store_true", help="open even if Klipper holds the device")
    pf = sub.add_parser("connect", help="forward ports until interrupted")
    pf.add_argument("--web", type=int, metavar="PORT", help="Fluidd/Mainsail on localhost:PORT, Moonraker on 7125")
    pf.add_argument("-L", dest="forward", action="append", type=parse_forward, metavar="LOCAL:[HOST:]PORT|LOCAL:unix:NAME.sock")
    pf.add_argument("--serial", action="append", type=parse_serial, metavar="DEVICE:LOCALPORT[:BAUD]")
    pf.add_argument("--force", action="store_true", help="open serial devices even if Klipper holds them")
    ap.add_argument("--version", action="version", version=__version__)
    args = ap.parse_args(argv)
    try:
        asyncio.run(amain(args))
    except (KeyboardInterrupt, ConnectionError) as e:
        if isinstance(e, ConnectionError):
            sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()

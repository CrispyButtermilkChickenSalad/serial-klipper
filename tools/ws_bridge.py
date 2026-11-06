#!/usr/bin/env python3
"""Development bridge: expose a TCP endpoint (a `serial-klipper-host --listen` daemon, e.g. through
`ssh -L 9000:127.0.0.1:9000 host`) as a WebSocket carrying the raw link bytes, so the web app can be
tried without Web Serial hardware:   http://localhost:8000/?link=ws://localhost:9001

    python tools/ws_bridge.py --tcp 127.0.0.1:9000 --listen 9001
"""
import argparse
import asyncio
import base64
import hashlib
import struct

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


async def read_frame(r):
    b0, b1 = await r.readexactly(2)
    n = b1 & 0x7F
    if n == 126:
        n = struct.unpack(">H", await r.readexactly(2))[0]
    elif n == 127:
        n = struct.unpack(">Q", await r.readexactly(8))[0]
    mask = await r.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
    data = bytearray(await r.readexactly(n))
    for i in range(n):
        data[i] ^= mask[i & 3]
    return b0 & 0x0F, bytes(data)


def frame(op, data):
    n = len(data)
    head = bytes([0x80 | op]) + (bytes([n]) if n < 126 else b"\x7e" + struct.pack(">H", n) if n < 65536 else b"\x7f" + struct.pack(">Q", n))
    return head + data


async def open_target(args):
    if args.serial:
        import serial
        ser = serial.Serial(args.serial, args.baud, timeout=0.05)
        loop = asyncio.get_running_loop()

        class R:
            async def read(self, n):
                while True:
                    d = await loop.run_in_executor(None, ser.read, 1024)
                    if d:
                        return d
                    if not ser.is_open:
                        return b""

        class W:
            def write(self, d):
                ser.write(d)

            async def drain(self):
                pass

            def close(self):
                ser.close()

        return R(), W()
    host, _, port = args.tcp.rpartition(":")
    return await asyncio.open_connection(host, int(port))


async def handle(args, r, w):
    head = await r.readuntil(b"\r\n\r\n")
    key = next(l.split(b":", 1)[1].strip() for l in head.split(b"\r\n") if l.lower().startswith(b"sec-websocket-key"))
    acc = base64.b64encode(hashlib.sha1(key + GUID).digest())
    w.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + acc + b"\r\n\r\n")
    tr, tw = await open_target(args)

    async def up():
        while True:
            op, data = await read_frame(r)
            if op == 8:
                break
            if op in (1, 2):
                tw.write(data)
                await tw.drain()

    async def down():
        while d := await tr.read(4096):
            w.write(frame(2, d))
            await w.drain()

    tasks = [asyncio.ensure_future(up()), asyncio.ensure_future(down())]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in tasks:
        t.cancel()
    tw.close()
    w.close()


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--tcp", help="host:port of serial-klipper-host --listen")
    ap.add_argument("--serial", help="serial port (e.g. COM3) instead of --tcp")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--listen", type=int, default=9001)
    args = ap.parse_args()
    srv = await asyncio.start_server(lambda r, w: handle(args, r, w), "127.0.0.1", args.listen)
    print(f"ws://127.0.0.1:{args.listen} -> {args.serial or args.tcp}", flush=True)
    async with srv:
        await srv.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

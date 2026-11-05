import asyncio
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from serial_klipper import proto
from serial_klipper.client import Client
from serial_klipper.host import Host


class ProtoTests(unittest.TestCase):
    def test_cobs_roundtrip(self):
        for data in (b"", b"\x00", b"abc", bytes(range(256)) * 3, b"\x00" * 600, b"a" * 254, b"a" * 255):
            self.assertEqual(proto.cobs_decode(proto.cobs_encode(data)), data)

    def test_frame_and_corruption(self):
        f = proto.encode_frame(proto.DATA, 7, b"hello\x00world")
        d = proto.Decoder()
        bad = bytearray(f)
        bad[3] ^= 0xFF
        out = list(d.feed(bytes(bad) + f))
        self.assertEqual(out, [(proto.DATA, 7, b"hello\x00world")])
        self.assertEqual(d.errors, 1)


class EndToEnd(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        async def echo(r, w):
            while d := await r.read(4096):
                w.write(d.upper())
                await w.drain()
            w.close()

        self.echo = await asyncio.start_server(echo, "127.0.0.1", 0)
        self.echo_port = self.echo.sockets[0].getsockname()[1]
        args = types.SimpleNamespace(allow_port=[self.echo_port], comms_dir=".", link=None)
        self.host = Host(args)
        self.srv = await asyncio.start_server(
            lambda r, w: self.host.serve_link(__import__("serial_klipper.link", fromlist=["x"]).StreamLink(r, w)),
            "127.0.0.1", 0)
        self.link_port = self.srv.sockets[0].getsockname()[1]
        self.client = Client(types.SimpleNamespace(port=f"socket://127.0.0.1:{self.link_port}", baud=115200))
        await self.client.connect()

    async def asyncTearDown(self):
        self.client.link.close()
        self.srv.close()
        self.echo.close()

    async def test_info(self):
        info = await self.client.info()
        self.assertEqual(info["tcp_ports"], [self.echo_port])

    async def test_tcp_forward_large(self):
        srv = await self.client.forward(0, {"kind": "tcp", "host": "127.0.0.1", "port": self.echo_port})
        port = srv.sockets[0].getsockname()[1]
        r, w = await asyncio.open_connection("127.0.0.1", port)
        payload = bytes(range(1, 256)) * 100  # ~25 KB, exceeds the flow-control window
        data = bytes(b % 26 + 97 for b in payload)

        async def writer():
            w.write(data)
            await w.drain()

        task = asyncio.ensure_future(writer())
        expect = data.upper()
        got = await asyncio.wait_for(r.readexactly(len(expect)), 20)
        await task
        self.assertEqual(got, expect)
        w.close()

    async def test_disallowed_port(self):
        with self.assertRaises(ConnectionError):
            await self.client.session.open({"kind": "tcp", "host": "127.0.0.1", "port": 22}, lambda d: None)


if __name__ == "__main__":
    unittest.main()

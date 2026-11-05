"""Channel multiplexer shared by the host daemon and the PC client."""
import asyncio
import json
import struct

from . import proto

WINDOW = 16384  # unacknowledged bytes allowed in flight per channel


class Channel:
    def __init__(self, session, cid):
        self.session = session
        self.id = cid
        self.inflight = 0
        self.space = asyncio.Event()
        self.space.set()
        self.rx = asyncio.Queue()
        self.sink = None  # async callable(bytes) consuming incoming data
        self.on_close = None
        self.closed = False
        self.opened = asyncio.get_running_loop().create_future()
        self._pump = None

    def start(self, sink, on_close=None):
        self.sink = sink
        self.on_close = on_close
        self._pump = asyncio.ensure_future(self._consume())

    async def _consume(self):
        try:
            while True:
                data = await self.rx.get()
                if data is None:
                    break
                await self.sink(data)
                await self.session.send(proto.ACK, self.id, struct.pack("<I", len(data)))
        except Exception:
            pass
        finally:
            await self.close()

    async def send(self, data: bytes):
        for i in range(0, len(data), proto.MAX_PAYLOAD):
            chunk = data[i:i + proto.MAX_PAYLOAD]
            while self.inflight + len(chunk) > WINDOW:
                if self.closed:
                    return
                self.space.clear()
                await self.space.wait()
            if self.closed:
                return
            self.inflight += len(chunk)
            await self.session.send(proto.DATA, self.id, chunk)

    def acked(self, n):
        self.inflight = max(0, self.inflight - n)
        self.space.set()

    async def close(self, notify=True):
        if self.closed:
            return
        self.closed = True
        self.space.set()
        self.rx.put_nowait(None)
        self.session.channels.pop(self.id, None)
        if notify:
            try:
                await self.session.send(proto.CLOSE, self.id)
            except Exception:
                pass
        if self.on_close:
            r = self.on_close()
            if asyncio.iscoroutine(r):
                await r
        if not self.opened.done():
            self.opened.set_result({"ok": False, "error": "closed"})


class Session:
    """One framed link. `write` is an async callable that puts bytes on the wire."""

    def __init__(self, write, on_open=None, on_reset=None):
        self.write = write
        self.on_open = on_open  # async (channel, params) for host side
        self.on_reset = on_reset
        self.channels = {}
        self.decoder = proto.Decoder()
        self.lock = asyncio.Lock()
        self.next_id = 1
        self.hello = asyncio.Event()
        self.peer = {}

    async def send(self, ftype, cid, payload=b""):
        async with self.lock:
            await self.write(proto.encode_frame(ftype, cid, payload))

    async def send_hello(self, role):
        await self.send(proto.HELLO, 0, json.dumps({"v": proto.PROTO_VERSION, "role": role}).encode())

    async def reset(self):
        for ch in list(self.channels.values()):
            await ch.close(notify=False)

    async def feed(self, data: bytes):
        for ftype, cid, payload in self.decoder.feed(data):
            await self._dispatch(ftype, cid, payload)

    async def _dispatch(self, ftype, cid, payload):
        if ftype == proto.HELLO:
            self.peer = json.loads(payload or b"{}")
            await self.reset()
            if self.on_reset:
                await self.on_reset(self.peer)
            self.hello.set()
        elif ftype == proto.OPEN and self.on_open:
            ch = Channel(self, cid)
            self.channels[cid] = ch
            try:
                params = json.loads(payload)
            except ValueError:
                params = {}
            asyncio.ensure_future(self._handle_open(ch, params))
        elif ftype == proto.OPENED:
            ch = self.channels.get(cid)
            if ch and not ch.opened.done():
                ch.opened.set_result(json.loads(payload))
        else:
            ch = self.channels.get(cid)
            if not ch:
                return
            if ftype == proto.DATA:
                ch.rx.put_nowait(payload)
            elif ftype == proto.ACK:
                ch.acked(struct.unpack("<I", payload)[0])
            elif ftype == proto.CLOSE:
                await ch.close(notify=False)

    async def _handle_open(self, ch, params):
        try:
            await self.on_open(ch, params)
        except Exception as e:  # report any failure to the peer
            await self.reply_open(ch, False, str(e))
            await ch.close()

    async def reply_open(self, ch, ok, error=None):
        msg = {"ok": ok}
        if error:
            msg["error"] = error
        await self.send(proto.OPENED, ch.id, json.dumps(msg).encode())

    async def open(self, params, sink, on_close=None, timeout=10):
        """Client side: open a channel; raises on refusal."""
        cid = self.next_id
        self.next_id = self.next_id % 65535 + 1
        ch = Channel(self, cid)
        self.channels[cid] = ch
        ch.start(sink, on_close)
        await self.send(proto.OPEN, cid, json.dumps(params).encode())
        try:
            res = await asyncio.wait_for(ch.opened, timeout)
        except asyncio.TimeoutError:
            await ch.close()
            raise ConnectionError("timed out opening channel (is the host daemon running?)")
        if not res.get("ok"):
            await ch.close(notify=False)
            raise ConnectionError(res.get("error", "open refused"))
        return ch

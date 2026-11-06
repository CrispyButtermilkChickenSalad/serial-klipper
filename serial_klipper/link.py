"""Byte-stream links: a pyserial port/URL, or an asyncio stream (TCP test mode)."""
import asyncio
import threading

import serial


class SerialLink:
    def __init__(self, url, baud=115200):
        self.ser = serial.serial_for_url(url, baudrate=baud, timeout=0.1, write_timeout=5)
        self.loop = asyncio.get_running_loop()
        self.q = asyncio.Queue()
        self.alive = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        try:
            while self.alive:
                data = self.ser.read(self.ser.in_waiting or 1)
                if data:
                    self.loop.call_soon_threadsafe(self.q.put_nowait, data)
        except Exception:
            pass
        self.loop.call_soon_threadsafe(self.q.put_nowait, b"")

    async def read(self):
        return await self.q.get()

    async def write(self, data):
        await self.loop.run_in_executor(None, self.ser.write, data)

    async def set_baud(self, baud):
        await self.loop.run_in_executor(None, setattr, self.ser, "baudrate", baud)

    def close(self):
        self.alive = False
        try:
            self.ser.close()
        except Exception:
            pass


class StreamLink:
    def __init__(self, reader, writer):
        self.r, self.w = reader, writer

    async def read(self):
        return await self.r.read(4096)

    async def write(self, data):
        self.w.write(data)
        await self.w.drain()

    def close(self):
        self.w.close()

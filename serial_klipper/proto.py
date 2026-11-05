"""Wire format: COBS-encoded frames delimited by 0x00.

Frame (before COBS): type u8 | channel u16 LE | payload | crc16 u16 LE
CRC is CRC-16/CCITT-FALSE over type+channel+payload.
"""
import struct

HELLO, OPEN, OPENED, DATA, ACK, CLOSE = range(1, 7)
MAX_PAYLOAD = 1024
PROTO_VERSION = 1


def crc16(data: bytes, crc: int = 0xFFFF) -> int:
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def cobs_encode(data: bytes) -> bytes:
    out = bytearray()
    block = bytearray()
    for b in data:
        if b == 0:
            out.append(len(block) + 1)
            out += block
            block.clear()
        else:
            block.append(b)
            if len(block) == 254:
                out.append(255)
                out += block
                block.clear()
    out.append(len(block) + 1)
    out += block
    return bytes(out)


def cobs_decode(data: bytes) -> bytes:
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        code = data[i]
        if code == 0 or i + code > n:
            raise ValueError("bad COBS block")
        out += data[i + 1:i + code]
        i += code
        if code != 255 and i < n:
            out.append(0)
    return bytes(out)


def encode_frame(ftype: int, chan: int, payload: bytes = b"") -> bytes:
    body = struct.pack("<BH", ftype, chan) + payload
    body += struct.pack("<H", crc16(body))
    return cobs_encode(body) + b"\x00"


def decode_frame(raw: bytes):
    body = cobs_decode(raw)
    if len(body) < 5:
        raise ValueError("short frame")
    if crc16(body[:-2]) != struct.unpack("<H", body[-2:])[0]:
        raise ValueError("crc mismatch")
    ftype, chan = struct.unpack("<BH", body[:3])
    return ftype, chan, body[3:-2]


class Decoder:
    """Incremental stream decoder; bad frames are counted and skipped."""

    def __init__(self):
        self.buf = bytearray()
        self.errors = 0

    def feed(self, data: bytes):
        for b in data:
            if b:
                self.buf.append(b)
                if len(self.buf) > 4 * MAX_PAYLOAD:
                    self.buf.clear()
                    self.errors += 1
                continue
            if not self.buf:
                continue
            raw = bytes(self.buf)
            self.buf.clear()
            try:
                yield decode_frame(raw)
            except ValueError:
                self.errors += 1

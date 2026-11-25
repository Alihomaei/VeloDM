#!/usr/bin/env python3
"""VeloDM Chrome native-messaging relay (the IDMMsgHost.exe equivalent).

Chrome starts this per extension connection. It forwards Chrome's
length-prefixed JSON frames to the engine daemon's Unix socket (newline
JSON) and back, starting the engine if it isn't running. Downloads live in
the engine, so closing Chrome doesn't stop them.
"""
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
from pathlib import Path

STATE_DIR = Path.home() / "Library" / "Application Support" / "VeloDM"
SOCK = STATE_DIR / "engine.sock"
ENGINE = Path(__file__).with_name("velodm_engine.py")


def connect():
    for attempt in range(40):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            s.connect(str(SOCK))
            return s
        except OSError:
            s.close()
            if attempt == 0:
                subprocess.Popen([sys.executable, "-I", str(ENGINE)], start_new_session=True,
                                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.25)
    return None


out_lock = threading.Lock()


def to_chrome(obj_bytes: bytes):
    with out_lock:
        sys.stdout.buffer.write(struct.pack("<I", len(obj_bytes)) + obj_bytes)
        sys.stdout.buffer.flush()


def main():
    s = connect()
    if not s:
        to_chrome(json.dumps({"type": "fatal", "error": "could not start VeloDM engine"}).encode())
        return

    def pump_engine():
        buf = b""
        while True:
            chunk = s.recv(65536)
            if not chunk:
                os._exit(0)  # engine went away; Chrome will reconnect
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    to_chrome(line)

    threading.Thread(target=pump_engine, daemon=True).start()
    while True:
        raw = sys.stdin.buffer.read(4)
        if len(raw) < 4:
            break
        (n,) = struct.unpack("<I", raw)
        s.sendall(sys.stdin.buffer.read(n) + b"\n")
    s.close()


if __name__ == "__main__":
    main()

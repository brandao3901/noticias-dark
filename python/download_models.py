"""Baixa os modelos do Kokoro v1.0 para a raiz do projeto (idempotente).

Uso: python python/download_models.py
"""

from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
FILES = {
    "kokoro-v1.0.onnx": 325_532_387,
    "voices-v1.0.bin": 28_214_398,
}


def download(name: str, expected: int, target: Path) -> None:
    if target.exists() and target.stat().st_size >= expected * 0.98:
        print(f"[ok] {name} já existe ({target.stat().st_size / 1024 / 1024:.1f} MB)")
        return

    url = f"{BASE}/{name}"
    print(f"[..] baixando {name} ({expected / 1024 / 1024:.0f} MB)")
    started = time.time()
    tmp = target.with_suffix(target.suffix + ".part")

    with urllib.request.urlopen(url, timeout=60) as response, tmp.open("wb") as handle:
        total = int(response.headers.get("content-length") or expected)
        done = 0
        while True:
            chunk = response.read(1024 * 256)
            if not chunk:
                break
            handle.write(chunk)
            done += len(chunk)
            if done % (1024 * 1024 * 8) < 1024 * 256:
                pct = done / total * 100
                print(f"     {pct:5.1f}%  {done / 1024 / 1024:.0f}/{total / 1024 / 1024:.0f} MB")

    if tmp.stat().st_size < expected * 0.98:
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"download incompleto de {name}")

    tmp.replace(target)
    print(f"[ok] {name} ({time.time() - started:.0f}s)")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    for name, size in FILES.items():
        try:
            download(name, size, root / name)
        except Exception as exc:  # noqa: BLE001
            print(f"[erro] {name}: {exc}")
            return 1
    print("[ok] modelos prontos")
    return 0


if __name__ == "__main__":
    sys.exit(main())

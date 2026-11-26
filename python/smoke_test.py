"""Teste rápido do Kokoro: fala pt-BR, mistura de vozes e medição de tempo.

Uso: python python/smoke_test.py
Gera `build/kokoro-smoke.wav` e imprime um JSON com o resultado.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voices import blend_named, describe_state, models_ready, save_blended  # noqa: E402

TEXT = (
    "O comitê decidiu manter a taxa básica de juros em quinze por cento ao ano, "
    "em decisão unânime."
)


def main() -> int:
    out = Path(__file__).resolve().parent.parent / "build" / "kokoro-smoke.wav"
    state = describe_state()

    if not models_ready():
        print(json.dumps({"ok": False, "error": "MODELS_MISSING", "state": state}, ensure_ascii=False))
        return 2

    print(json.dumps({"ok": True, "stage": "importando"}, ensure_ascii=False))

    from tts import synthesize  # noqa: E402

    started = time.time()
    result = synthesize(TEXT, out, voice="blend")
    total = time.time() - started

    # Mistura explícita 70/30 para provar que o vetor combinado é diferente.
    mix_vector = blend_named("pm_alex", "pf_dora", 0.7)
    mix_path = save_blended(mix_vector)

    print(
        json.dumps(
            {
                "ok": True,
                "audio": result,
                "totalSec": round(total, 2),
                "realtimeFactor": round(result["seconds"] / max(total, 0.01), 2),
                "blendSaved": str(mix_path),
                "blendShape": list(mix_vector.shape),
                "voices": state["voices"][:8],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

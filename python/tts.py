"""Síntese de fala com Kokoro (ONNX, CPU) em pt-BR.

Uso:
    python python/tts.py --text-file frase.txt --out saida.wav
    python python/tts.py --text "Olá" --out saida.wav --voice pm_alex --speed 1.1
    python python/tts.py --text "Olá" --out saida.wav --voice blend

Saída: WAV mono PCM 16-bit e uma linha JSON no stdout com os detalhes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voices import (  # noqa: E402
    load_kokoro,
    models_ready,
    read_config,
    resolve_voice,
)


def synthesize(
    text: str,
    out_path: Path,
    voice: str | None = None,
    speed: float | None = None,
    lang: str | None = None,
) -> dict:
    config = read_config()["voice"]
    kokoro = load_kokoro()

    voice_arg, voice_label = resolve_voice(voice)
    speed_value = float(speed if speed is not None else config.get("speed", 1.0))
    lang_value = (lang or config.get("lang", "pt-br")).strip() or "pt-br"

    started = time.time()
    audio, sample_rate = kokoro.create(
        text,
        voice=voice_arg,
        speed=max(0.5, min(2.0, speed_value)),
        lang=lang_value,
    )
    elapsed = time.time() - started

    import soundfile as sf

    out_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out_path), audio, sample_rate, subtype="PCM_16")

    return {
        "ok": True,
        "out": str(out_path),
        "seconds": round(len(audio) / float(sample_rate), 3),
        "sampleRate": int(sample_rate),
        "voice": voice_label,
        "speed": speed_value,
        "lang": lang_value,
        "elapsedSec": round(elapsed, 2),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Kokoro TTS pt-BR (CPU)")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--text", help="texto a sintetizar")
    group.add_argument("--text-file", help="arquivo com o texto")
    parser.add_argument("--out", required=True, help="caminho do WAV de saída")
    parser.add_argument("--voice", default=None, help="nome da voz, 'blend' ou vazio")
    parser.add_argument("--speed", type=float, default=None, help="velocidade (0.5–2.0)")
    parser.add_argument("--lang", default=None, help="idioma (padrão pt-br)")
    args = parser.parse_args()

    if not models_ready():
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "MODELS_MISSING",
                    "message": "kokoro-v1.0.onnx/voices-v1.0.bin ausentes. Rode python/download_models.py",
                }
            )
        )
        return 2

    text = args.text
    if args.text_file:
        text = Path(args.text_file).read_text(encoding="utf-8")

    text = " ".join((text or "").split())
    if len(text) < 2:
        print(json.dumps({"ok": False, "error": "EMPTY_TEXT"}))
        return 2

    try:
        result = synthesize(text, Path(args.out), args.voice, args.speed, args.lang)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - queremos a mensagem no JSON
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

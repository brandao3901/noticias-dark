"""Estúdio de voz: prévia, mistura e gravação da voz padrão do canal.

Usado pela interface Streamlit (`studio_app.py`) e pelo endpoint de prévia.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from voices import (  # noqa: E402
    BLENDED_VOICE_PATH,
    PT_BR_VOICE_IDS,
    available_voices,
    blend_named,
    describe_state,
    load_kokoro,
    models_ready,
    read_config,
    save_blended,
    write_config,
    write_voice_default,
)

PUBLIC_VOICES = ("pm_alex", "pf_dora", "pm_santa")


def list_voices() -> list[str]:
    """Vozes pt-BR primeiro; inclui 'blend' como voz do canal."""
    try:
        all_voices = available_voices()
    except Exception:
        all_voices = list(PT_BR_VOICE_IDS)
    pt = [v for v in all_voices if v in PUBLIC_VOICES]
    return pt + ["blend"] if pt else all_voices


def state() -> dict:
    info = describe_state()
    info["publicVoices"] = list(PUBLIC_VOICES)
    info["blendFile"] = str(BLENDED_VOICE_PATH)
    return info


def preview(
    text: str,
    voice_a: str,
    voice_b: str,
    mix: float,
    speed: float = 1.0,
    lang: str = "pt-br",
) -> tuple[bytes, dict]:
    """Sintetiza uma frase com a mistura informada e devolve WAV em memória."""
    if not models_ready():
        raise RuntimeError("Modelos do Kokoro ausentes: rode python/download_models.py")

    clean = " ".join((text or "").split())
    if len(clean) < 2:
        raise ValueError("Escreva uma frase para ouvir a prévia.")

    kokoro = load_kokoro()
    vector = blend_named(voice_a, voice_b, float(mix))

    audio, sample_rate = kokoro.create(
        clean,
        voice=vector,
        speed=max(0.5, min(2.0, float(speed))),
        lang=lang,
    )

    import soundfile as sf

    buffer = io.BytesIO()
    sf.write(buffer, audio, sample_rate, format="WAV", subtype="PCM_16")
    return buffer.getvalue(), {
        "seconds": round(len(audio) / float(sample_rate), 3),
        "sampleRate": int(sample_rate),
        "voiceA": voice_a,
        "voiceB": voice_b,
        "mix": round(float(mix), 2),
        "speed": round(float(speed), 2),
    }


def save_default(
    voice_a: str,
    voice_b: str,
    mix: float,
    speed: float = 1.0,
    lang: str = "pt-br",
) -> dict:
    """Grava `voz_canal.npy` + `config.json` e devolve a configuração final."""
    if not models_ready():
        raise RuntimeError("Modelos do Kokoro ausentes: rode python/download_models.py")

    vector = blend_named(voice_a, voice_b, float(mix))
    save_blended(vector)

    config = read_config()
    config["voice"] = {
        **config.get("voice", {}),
        "engine": "kokoro",
        "a": voice_a,
        "b": voice_b,
        "mix": round(float(mix), 2),
        "speed": round(float(speed), 2),
        "lang": lang,
        "file": "voz_canal.npy",
    }
    write_config(config)
    # Toda pauta passa a usar esta voz (o render segue o padrão do canal).
    write_voice_default("kokoro", "blend")

    return {
        "ok": True,
        "config": config["voice"],
        "file": str(BLENDED_VOICE_PATH),
        "shape": list(vector.shape),
    }


def _cli() -> int:
    import argparse
    import json

    parser = argparse.ArgumentParser(description="Estúdio de voz do Canal Dark")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--save", action="store_true", help="grava a voz padrão do canal")
    mode.add_argument("--preview", action="store_true", help="gera um WAV de prévia")
    mode.add_argument("--selftest", action="store_true", help="teste rápido")
    parser.add_argument("--a", default="pm_alex")
    parser.add_argument("--b", default="pf_dora")
    parser.add_argument("--mix", type=float, default=0.7)
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="pt-br")
    parser.add_argument("--text", default=None)
    parser.add_argument("--out", default="build/preview.wav")
    args = parser.parse_args()

    try:
        if args.save:
            print(json.dumps(save_default(args.a, args.b, args.mix, args.speed, args.lang), ensure_ascii=False))
            return 0
        if args.preview:
            text = args.text or "Esta é a voz do canal com a mistura escolhida no estúdio."
            data, meta = preview(text, args.a, args.b, args.mix, args.speed, args.lang)
            out = Path(args.out)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(data)
            print(json.dumps({"ok": True, "out": str(out), **meta}, ensure_ascii=False))
            return 0
        data, meta = preview(
            "Esta é a voz do canal, mistura de setenta por cento da voz um com trinta por cento da voz dois.",
            "pm_alex",
            "pf_dora",
            0.7,
        )
        out = Path(__file__).resolve().parent.parent / "build" / "preview.wav"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        print(json.dumps({"ok": True, "out": str(out), **meta}, ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(_cli())

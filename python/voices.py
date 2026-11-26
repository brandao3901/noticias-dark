"""Vozes do Kokoro: listagem, mistura de vetores e persistência da voz do canal.

O Kokoro v1.0 guarda cada voz como um vetor de estilo (numpy) dentro de
`voices-v1.0.bin`. Misturar duas vozes é média ponderada desses vetores — não há
treino, só combinação.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

import numpy as np

ROOT = Path(__file__).resolve().parent.parent

MODEL_PATH = ROOT / "kokoro-v1.0.onnx"
VOICES_PATH = ROOT / "voices-v1.0.bin"
CONFIG_PATH = ROOT / "config.json"
BLENDED_VOICE_PATH = ROOT / "voz_canal.npy"

# Vozes pt-BR do Kokoro v1.0 (prefixo p + gênero m/f).
PT_BR_VOICE_IDS = ("pm_alex", "pm_santa", "pf_dora", "pf_dora_santa")

DEFAULT_CONFIG: dict[str, Any] = {
    "voice": {
        "engine": "kokoro",
        "a": "pm_alex",
        "b": "pf_dora",
        "mix": 0.7,
        "speed": 1.0,
        "lang": "pt-br",
        "file": "voz_canal.npy",
    },
    "paths": {
        "models": "kokoro-v1.0.onnx",
        "voices": "voices-v1.0.bin",
        "projects": "projects",
    },
    "api": {"node": "http://127.0.0.1:3000"},
    # Voz do canal: vale para TODAS as pautas (o render segue isto).
    "default": {"engine": "kokoro", "voice": "blend"},
}

_lock = Lock()
_kokoro: Any = None


def read_config() -> dict[str, Any]:
    """Config atual, com defaults preenchidos (nunca lança)."""
    if not CONFIG_PATH.exists():
        return json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        raw = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))

    merged = json.loads(json.dumps(DEFAULT_CONFIG))
    for section, values in raw.items():
        if isinstance(values, dict) and isinstance(merged.get(section), dict):
            merged[section].update(values)
        else:
            merged[section] = values
    return merged


def write_config(config: dict[str, Any]) -> dict[str, Any]:
    CONFIG_PATH.write_text(
        json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return config


def read_voice_default() -> dict[str, str]:
    """Voz do canal: {engine, voice}. É o padrão de todos os vídeos."""
    config = read_config().get("default") or {}
    engine = str(config.get("engine") or "kokoro")
    voice = str(config.get("voice") or "blend")
    return {"engine": engine, "voice": voice}


def write_voice_default(engine: str, voice: str) -> dict[str, str]:
    config = read_config()
    config["default"] = {"engine": engine, "voice": voice}
    write_config(config)
    return {"engine": engine, "voice": voice}


def models_ready() -> bool:
    # O .onnx tem ~325 MB e o .bin ~28 MB; tamanho mínimo pega download truncado.
    return (
        MODEL_PATH.exists()
        and MODEL_PATH.stat().st_size > 300 * 1024 * 1024
        and VOICES_PATH.exists()
        and VOICES_PATH.stat().st_size > 20 * 1024 * 1024
    )


def load_kokoro():
    """Instância única do Kokoro (carrega ~325 MB uma vez)."""
    global _kokoro
    with _lock:
        if _kokoro is not None:
            return _kokoro
        if not models_ready():
            raise FileNotFoundError(
                f"Modelos ausentes em {ROOT}: rode `python python/download_models.py`."
            )
        from kokoro_onnx import Kokoro

        _kokoro = Kokoro(str(MODEL_PATH), str(VOICES_PATH))
        return _kokoro


def available_voices() -> list[str]:
    """Ids de voz que existem no arquivo de vozes, priorizando pt-BR."""
    try:
        voices = load_kokoro().voices
        ids = sorted(voices.keys())
    except Exception:
        ids = list(PT_BR_VOICE_IDS)

    pt = [v for v in ids if v in PT_BR_VOICE_IDS]
    rest = [v for v in ids if v.startswith("p") and v not in pt]
    others = [v for v in ids if v not in pt and v not in rest]
    return pt + rest + others


def voice_vector(name: str) -> np.ndarray:
    kokoro = load_kokoro()
    voices = kokoro.voices
    if name not in voices:
        raise KeyError(f"Voz '{name}' não existe no voices-v1.0.bin.")
    return np.asarray(voices[name], dtype=np.float32)


def blend_vectors(a: np.ndarray, b: np.ndarray, mix: float) -> np.ndarray:
    """Média ponderada: `mix` = peso da voz A (0..1)."""
    weight = max(0.0, min(1.0, float(mix)))
    if a.shape != b.shape:
        raise ValueError(f"Vetores com formatos diferentes: {a.shape} vs {b.shape}")
    return (a * weight + b * (1.0 - weight)).astype(np.float32)


def blend_named(a: str, b: str, mix: float) -> np.ndarray:
    return blend_vectors(voice_vector(a), voice_vector(b), mix)


def save_blended(vector: np.ndarray, path: Path | None = None) -> Path:
    target = path or BLENDED_VOICE_PATH
    np.save(target, vector)
    return target


def load_blended(path: Path | None = None) -> np.ndarray | None:
    target = path or BLENDED_VOICE_PATH
    if not target.exists():
        return None
    try:
        return np.load(target).astype(np.float32)
    except Exception:
        return None


def resolve_voice(voice: str | None) -> tuple[str | np.ndarray, str]:
    """
    Decide o vetor de voz a usar.

    - `voice` vazio -> voz do canal (`voz_canal.npy`) se existir; senão config.
    - `voice` = "blend" -> força a voz do canal.
    - `voice` = nome de voz -> usa aquela voz pura.
    """
    config = read_config()["voice"]
    requested = (voice or "").strip()

    if requested in ("", "blend", "canal", "default"):
        blended = load_blended()
        if blended is not None:
            return blended, "blend"
        a, b = config.get("a", "pm_alex"), config.get("b", "pf_dora")
        mix = float(config.get("mix", 0.7))
        return blend_named(a, b, mix), f"blend:{a}+{b}@{mix}"

    return requested, requested


def describe_state() -> dict[str, Any]:
    config = read_config()
    return {
        "modelsReady": models_ready(),
        "modelPath": str(MODEL_PATH),
        "voicesPath": str(VOICES_PATH),
        "blendedVoiceExists": BLENDED_VOICE_PATH.exists(),
        "config": config,
        "voices": available_voices(),
    }

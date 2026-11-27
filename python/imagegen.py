"""Geração de imagens ilustrativas com Stable Diffusion Turbo, em CPU.

Uso:
    python python/imagegen.py --prompt "..." --out imagem.png
    python python/imagegen.py --prompt "..." --out imagem.png --width 1080 --height 1920 --steps 2

O modelo é baixado uma vez (Hugging Face) e fica em cache. Roda em CPU: no Ryzen
5 5600G, 512x512 com 1 passo leva dezenas de segundos. A saída é sempre 9:16
(recorte/redimensionamento no fim), pronta para o render.

Saída: JSON de uma linha no stdout com ok, out, segundos e tempos.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

DEFAULT_MODEL = "stabilityai/sd-turbo"

_pipe = None


def load_pipeline(model_name: str):
    """Carrega (uma vez) o pipeline em CPU."""
    global _pipe
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import AutoPipelineForText2Image

    torch.set_num_threads(max(1, min(12, torch.get_num_threads())))
    _pipe = AutoPipelineForText2Image.from_pretrained(
        model_name,
        torch_dtype=torch.float32,
        safety_checker=None,
        requires_safety_checker=False,
    )
    _pipe = _pipe.to("cpu")
    _pipe.set_progress_bar_config(disable=True)
    return _pipe


def fit_to_vertical(image, width: int, height: int):
    """Encaixa a imagem gerada em 9:16 sem distorcer (recorte central)."""
    from PIL import Image

    target_ratio = width / height
    w, h = image.size
    ratio = w / h

    if ratio > target_ratio:
        new_w = int(h * target_ratio)
        left = (w - new_w) // 2
        image = image.crop((left, 0, left + new_w, h))
    else:
        new_h = int(w / target_ratio)
        top = (h - new_h) // 2
        image = image.crop((0, top, w, top + new_h))

    return image.resize((width, height), Image.LANCZOS)


def main() -> int:
    parser = argparse.ArgumentParser(description="Stable Diffusion Turbo (CPU)")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--negative", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    started = time.time()
    try:
        import torch
        from diffusers import AutoPipelineForText2Image  # noqa: F401  (garante erro claro)

        pipe = load_pipeline(args.model)

        # O modelo trabalha em 512x512 (ou 512x896 para 9:16); depois ampliamos.
        gen_w, gen_h = 512, 896
        seed = args.seed if args.seed is not None else int(time.time()) % 1_000_000
        generator = torch.Generator(device="cpu").manual_seed(seed)

        result = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative or None,
            num_inference_steps=max(1, min(8, args.steps)),
            guidance_scale=0.0,
            width=gen_w,
            height=gen_h,
            generator=generator,
        )

        image = result.images[0]
        image = fit_to_vertical(image, args.width, args.height)

        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        image.save(out, format="PNG")

        elapsed = time.time() - started
        print(
            json.dumps(
                {
                    "ok": True,
                    "out": str(out),
                    "width": args.width,
                    "height": args.height,
                    "seed": seed,
                    "steps": args.steps,
                    "model": args.model,
                    "elapsedSec": round(elapsed, 1),
                },
                ensure_ascii=False,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": type(exc).__name__, "message": str(exc)[:400]}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

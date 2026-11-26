"""Console local do Canal Dark (Streamlit).

Três abas:
  1. Gerar vídeo    — escolhe a pauta, edita o roteiro, renderiza e assiste.
  2. Estúdio de voz — mistura duas vozes Kokoro, ouve a prévia e salva o padrão.
  3. Histórico      — vídeos já renderizados e configurações de API/pastas.

O render continua sendo o mesmo pipeline Node/FFmpeg do app; este console só
chama a API. A voz roda local (Kokoro/ONNX) via `python/voice_studio.py`.

Rodar:
    streamlit run studio_app.py --server.runOnSave true
"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import streamlit as st

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "python"))

from voice_studio import list_voices, preview, save_default, state  # noqa: E402


# ---------------------------------------------------------------------------
# Utilidades
# ---------------------------------------------------------------------------

def read_config() -> dict:
    path = ROOT / "config.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def node_url() -> str:
    return str(read_config().get("api", {}).get("node") or "http://127.0.0.1:3000").rstrip("/")


def api(method: str, path: str, body: dict | None = None, timeout: float = 30.0):
    """Chamada HTTP simples à API Node (stdlib, sem dependência extra)."""
    url = f"{node_url()}{path}"
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:400]
        raise RuntimeError(f"{exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"API Node indisponível em {node_url()} — inicie com `npm run dev`."
        ) from exc


def api_bytes(path: str) -> bytes:
    with urllib.request.urlopen(f"{node_url()}{path}", timeout=120) as response:
        return response.read()


def node_online() -> bool:
    try:
        api("GET", "/api/config/status", timeout=4)
        return True
    except Exception:
        return False


st.set_page_config(page_title="Canal Dark · Console", page_icon="🔥", layout="wide")

st.markdown(
    """
    <style>
      .block-container { padding-top: 2rem; }
      h1, h2, h3 { letter-spacing: -0.02em; }
      .status-dot { height: 10px; width: 10px; border-radius: 50%; display: inline-block; margin-right: 6px; }
    </style>
    """,
    unsafe_allow_html=True,
)

header_left, header_right = st.columns([0.7, 0.3])
with header_left:
    st.title("Canal Dark · Console")
    st.caption("Roteiro → voz Kokoro (offline) → render FFmpeg → vídeo pronto")
with header_right:
    online = node_online()
    color = "#22c55e" if online else "#ef4444"
    st.markdown(
        f"<div style='text-align:right;padding-top:1.2rem'>"
        f"<span class='status-dot' style='background:{color}'></span>"
        f"Node {'online' if online else 'offline'}</div>",
        unsafe_allow_html=True,
    )

tab_video, tab_voice, tab_history = st.tabs(["🎬 Gerar vídeo", "🎙️ Estúdio de voz", "🗂️ Histórico"])


# ---------------------------------------------------------------------------
# Aba 1 — Gerar vídeo
# ---------------------------------------------------------------------------

with tab_video:
    if not online:
        st.warning("O servidor Node não respondeu. Rode `npm run dev` na pasta do projeto.")
    else:
        try:
            payload = api("GET", "/api/projects")
            projects = payload.get("projects", [])
        except Exception as exc:  # noqa: BLE001
            projects = []
            st.error(str(exc))

        if not projects:
            st.info("Nenhuma pauta salva ainda. Use a aba Descoberta do app principal para criar uma.")
        else:
            labels = {
                f"{item.get('title', 'sem título')[:70]} · {item.get('stage', '?')}": item["id"]
                for item in projects
            }
            chosen = st.selectbox("Pauta", list(labels.keys()))
            pauta_id = labels[chosen]

            project = api("GET", f"/api/projects/{pauta_id}")
            scenes = project.get("script", {}).get("scenes", []) or []

            st.markdown(f"**{project.get('title', '')}** · {project.get('editorial', '')} · estágio `{project.get('stage')}`")

            # Voz do render: por padrão a voz do canal salva no config.json.
            voice_config = read_config().get("voice", {})
            blend_label = (
                f"Voz do canal · {voice_config.get('a', '?')} "
                f"{round(float(voice_config.get('mix', 0.7)) * 100)}% + "
                f"{voice_config.get('b', '?')} "
                f"{round((1 - float(voice_config.get('mix', 0.7))) * 100)}%"
            )
            options: list[tuple[str, str, str]] = [("blend", "kokoro", blend_label)]
            try:
                catalog = api("GET", "/api/config/status").get("tts", {}).get("voices", [])
                for voice in catalog:
                    if voice.get("engine") == "kokoro" and voice.get("id") != "blend":
                        options.append((voice["id"], "kokoro", f"Kokoro · {voice.get('label')}"))
                for voice in catalog:
                    if voice.get("engine") in ("gemini", "edge"):
                        options.append(
                            (voice["id"], voice["engine"], f"{voice.get('engine')} · {voice.get('label')}")
                        )
            except Exception:  # noqa: BLE001 - catálogo é opcional
                pass

            chosen_voice = st.selectbox(
                "Voz deste vídeo",
                options=[item[2] for item in options],
                index=0,
                help="A voz do canal vem do Estúdio de voz (config.json + voz_canal.npy).",
            )
            selected = options[[item[2] for item in options].index(chosen_voice)]

            with st.form("script_form"):
                st.markdown("#### Roteiro (edite antes de renderizar)")
                edited: list[str] = []
                for index, scene in enumerate(scenes):
                    edited.append(
                        st.text_area(
                            f"Cena {index + 1}",
                            value=scene.get("narration", ""),
                            height=90,
                            key=f"scene_{pauta_id}_{scene.get('id', index)}",
                        )
                    )

                col_save, col_render = st.columns(2)
                save = col_save.form_submit_button("💾 Salvar roteiro", use_container_width=True)
                render = col_render.form_submit_button("🚀 Gerar vídeo", use_container_width=True)

            if save:
                updated = json.loads(json.dumps(project))
                for scene, text in zip(updated.get("script", {}).get("scenes", []), edited):
                    scene["narration"] = text
                updated["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
                api("PUT", f"/api/projects/{pauta_id}", updated)
                st.success("Roteiro salvo.")

            if render:
                try:
                    started = api(
                        "POST",
                        f"/api/studio/render/{pauta_id}",
                        {"engine": selected[1], "voice": selected[0]},
                    )
                    job = started.get("job", {})
                    st.caption(f"Job {job.get('id')} · modo `{started.get('mode')}`")

                    bar = st.progress(0, text="Preparando…")
                    status_box = st.empty()
                    final = None
                    for _ in range(600):
                        current = api("GET", f"/api/jobs/{job.get('id')}")
                        pct = max(0, min(100, int(current.get("pct") or 0)))
                        bar.progress(pct / 100, text=f"{current.get('stage')}: {current.get('message')}")
                        status_box.caption(f"{pct}% · {current.get('status')}")
                        if current.get("status") in ("done", "failed", "cancelled"):
                            final = current
                            break
                        time.sleep(1)

                    if final and final.get("status") == "done":
                        st.success(f"Vídeo pronto · {final.get('result', {}).get('seconds')}s")
                        voice = final.get("result", {}).get("ttsEngine", "?")
                        st.caption(f"Voz: **{voice}** · {final.get('result', {}).get('ttsVoice', '')}")
                        video_url = f"{node_url()}/api/projects/{pauta_id}/video"
                        st.video(video_url)
                        st.download_button(
                            "⬇️ Baixar MP4",
                            data=api_bytes(f"/api/projects/{pauta_id}/video"),
                            file_name=f"{pauta_id}.mp4",
                            mime="video/mp4",
                        )
                    elif final:
                        st.error(f"Render falhou: {final.get('error')}")
                except Exception as exc:  # noqa: BLE001
                    st.error(str(exc))


# ---------------------------------------------------------------------------
# Aba 2 — Estúdio de voz
# ---------------------------------------------------------------------------

with tab_voice:
    info = state()
    if not info.get("modelsReady"):
        st.error(
            "Modelos do Kokoro ausentes. Rode `python python/download_models.py` "
            "(~354 MB, uma vez)."
        )
    else:
        voices = list_voices()
        pure = [v for v in voices if v != "blend"]
        current = info.get("config", {}).get("voice", {})

        col_a, col_b = st.columns(2)
        voice_a = col_a.selectbox(
            "Voz 1", pure, index=pure.index(current.get("a")) if current.get("a") in pure else 0
        )
        voice_b = col_b.selectbox(
            "Voz 2", pure, index=pure.index(current.get("b")) if current.get("b") in pure else min(1, len(pure) - 1)
        )

        mix = st.slider(
            f"Mistura — {voice_a} ← → {voice_b}",
            min_value=0,
            max_value=100,
            value=int(round(float(current.get("mix", 0.7)) * 100)),
            step=5,
            help="100% = só a voz 1; 0% = só a voz 2.",
        )
        speed = st.slider(
            "Velocidade", 0.7, 1.4, float(current.get("speed", 1.0)), 0.05
        )

        phrase = st.text_area(
            "Frase de teste",
            value="O comitê manteve a taxa de juros em quinze por cento ao ano. Você acha que vai cair?",
            height=90,
        )

        col_play, col_save = st.columns(2)
        if col_play.button("🔊 Ouvir prévia", use_container_width=True):
            with st.spinner("Sintetizando em CPU…"):
                try:
                    audio, meta = preview(phrase, voice_a, voice_b, mix / 100.0, speed)
                    st.audio(audio, format="audio/wav")
                    st.caption(
                        f"{meta['seconds']}s · {meta['voiceA']} {100 - int(meta['mix'] * 100)}% / "
                        f"{meta['voiceB']} {int(meta['mix'] * 100)}% · velocidade {meta['speed']}"
                    )
                except Exception as exc:  # noqa: BLE001
                    st.error(str(exc))

        if col_save.button("💾 Salvar como voz padrão do canal", type="primary", use_container_width=True):
            try:
                saved = save_default(voice_a, voice_b, mix / 100.0, speed)
                st.success(
                    f"Voz do canal salva: {voice_a} {100 - mix}% + {voice_b} {mix}% · "
                    f"velocidade {speed} → `config.json`"
                )
                st.json(saved)
            except Exception as exc:  # noqa: BLE001
                st.error(str(exc))

        st.divider()
        st.caption(
            "A voz misturada é um vetor salvo em `voz_canal.npy`. Todos os vídeos novos "
            "usam essa voz por padrão (engine `kokoro`)."
        )
        with st.expander("Configuração atual"):
            st.json(info.get("config", {}))


# ---------------------------------------------------------------------------
# Aba 3 — Histórico / configurações
# ---------------------------------------------------------------------------

with tab_history:
    st.subheader("Vídeos renderizados")
    if not online:
        st.info("Node offline.")
    else:
        try:
            items = api("GET", "/api/projects").get("projects", [])
        except Exception as exc:  # noqa: BLE001
            items = []
            st.error(str(exc))

        rendered = [item for item in items if item.get("hasVideo")]
        if not rendered:
            st.info("Nenhum vídeo renderizado ainda.")
        for item in rendered:
            with st.expander(f"{item.get('title', 'sem título')} · {item.get('stage')}"):
                st.video(f"{node_url()}/api/projects/{item['id']}/video")
                st.download_button(
                    "⬇️ Baixar MP4",
                    data=api_bytes(f"/api/projects/{item['id']}/video"),
                    file_name=f"{item['id']}.mp4",
                    mime="video/mp4",
                    key=f"dl_{item['id']}",
                )

    st.divider()
    st.subheader("Configurações")
    config = read_config()
    api_url = st.text_input("URL da API Node", value=config.get("api", {}).get("node", "http://127.0.0.1:3000"))
    if st.button("Salvar configuração"):
        config.setdefault("api", {})["node"] = api_url.rstrip("/")
        (ROOT / "config.json").write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        st.success("Configuração salva.")

    st.caption(f"Projeto: `{ROOT}`")
    st.caption(
        "Formatos de vídeo: fotos, documento e cartões são escolhidos na aba **Estúdio e QC** do app "
        "Angular (http://localhost:3000)."
    )

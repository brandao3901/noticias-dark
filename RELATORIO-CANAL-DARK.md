# Canal Dark — diagnóstico completo e proposta de interface visual

**Repositório:** https://github.com/brandao3901/noticias-dark.git (clone em `C:\CanalDark\noticias-dark`, branch `main`, HEAD `4a22392`)
**Data da análise:** 25/11/2026
**Escopo:** leitura dos 44 arquivos do projeto + verificação de build/execução + proposta de interface para **gerar, editar e visualizar** vídeos.

---

## 0. Como validei (não é achismo)

| Verificação | Comando | Resultado |
|---|---|---|
| Clone | `git -c http.sslBackend=openssl clone ...` | OK (o backend `schannel` falha nesta máquina) |
| Dependências | `npm install --ignore-scripts --cache .npm-cache` | 628 pacotes, OK |
| Tipos | `npm run lint` (`tsc --noEmit`) | **0 erros** |
| Build | `npm run build` (`ng build`, SSR) | **OK em 5,6 s** — 510,62 kB inicial (warning: budget de 500 kB) |
| Servidor SSR | `node dist/canal-dark/server/server.mjs` | sobe e responde: `{"geminiConfigured":false,...}` em `/api/config/status` |
| Desktop (Electron) | `node -e "import('./dist/.../server.mjs')"` + fetch :3000 | **quebrado** — a porta 3000 não escuta (ECONNREFUSED) |
| Vídeo de referência do repo | `ffprobe short_pauta-*.mp4` | 1080×1920, H.264/AAC, 75 s — prova de que o render já funcionou |

Observação de ambiente: o sandbox bloqueia `spawn` com pipes, então o build só passou com uma execução única de acesso total. O código em si está sadio.

---

## 1. Inventário — o que existe de fato

### 1.1 Frente (Angular 22, zoneless, standalone, signals, Tailwind v4 + Material icons)

| Arquivo | Linhas | Papel |
|---|---|---|
| `src/app/app.ts` | 242 | Casca do app: topbar, fila lateral de pautas, 5 abas por `signal` (sem router — `app.routes.ts` é vazio), faixa de feedback global |
| `src/app/services/studio-store.ts` | 1777 | **Cérebro do estado**: signal store único, persistência em `localStorage` (`canal_dark_pautas_v1`), orquestra pesquisa, roteiro, mídia, QC, legendas, manifesto |
| `src/app/models/studio.models.ts` | 218 | Contratos: `PautaRecord`, 9 estágios do pipeline, `DossierEvidence`, `EditableScript`, `ScriptScene`, `MediaAsset` com licença, `NarrationState`, `QcReport` |
| `src/app/services/speech-preview.ts` | 412 | Web Speech pt-BR + `AudioContext` (RMS → `jawOpen`), normalização de números/siglas, áudio importado, loop de animação |
| `src/app/components/discovery-view.ts` | 347 | Cadastro por URL + 11 feeds RSS com filtro por editoria |
| `src/app/components/dossier-view.ts` | 355 | Extração da matéria, GDELT, RSS, síntese Gemini, tabela de fontes com IDs |
| `src/app/components/script-view.ts` | 457 | Editor do roteiro por cenas (texto, duração, avatar, expressão, queries PT/EN, vínculo de fontes) |
| `src/app/components/media-voice-view.ts` | 685 | Busca de acervo (Wikimedia/Internet Archive), auto-preenchimento por nomes citados, ordenação de mídias, narração TTS/Clipchamp |
| `src/app/components/studio-qc-view.ts` | 699 | Prévia 9:16 + QC + aprovação + downloads (MP4/SRT/VTT/JSON/TXT) + comando FFmpeg |
| `src/app/components/presenter-avatar.ts` | 208 | Avatar SVG procedural (boca, sobrancelhas, expressões) — **só no DOM** |

### 1.2 Servidor (Express 5 + Angular SSR)

| Arquivo | Linhas | Papel |
|---|---|---|
| `src/server.ts` | 289 | 9 endpoints REST + estático + SSR catch-all |
| `src/server/research.ts` | 1415 | Extração HTML/JSON-LD, GDELT DOC 2.0, Wikimedia/Wikipedia, Internet Archive, auto-fill por entidades |
| `src/server/gemini.ts` | 437 | `@google/genai`: URL Context (sem grounding) + roteiro com `responseSchema`, pausa global em 429 |
| `src/server/feeds.ts` | 322 | 11 feeds (g1, Folha, UOL, R7, Metrópoles ×3, Gente/iG), dedup, cache 5 min |
| `src/server/ssrf-guard.ts` | 299 | Bloqueio de IP privado/loopback, `.local`, X/Twitter, redirect manual com revalidação, limite de bytes, charset |
| `src/server/export-video.ts` | 235 | Render FFmpeg: download seguro, segmentos 1080×1920, concat, `drawtext` + `subtitles`, áudio opcional |
| `electron/main.js` | 55 | Processo principal do Electron (importa o SSR e abre janela em `:3000`) |

### 1.3 Documento de produto escondido no repositório

`public/assets/aistudio/Paste_November_24__2026_-_3_14PM_aab74d2c` (300 linhas) é a **especificação completa**: RF-01…RF-14, 15 critérios de aceite, arquitetura alvo (SQLite + diretórios por pauta), decisões sobre Gemini/Grok/X, avatar e monetização. Vale renomear para `docs/ESPECIFICACAO.md` — hoje ele é inalcançável.

---

## 2. O que já está pronto

### 2.1 Núcleo editorial (a parte mais valiosa e mais madura)

1. **Entrada de pauta por URL** com validação de esquema, normalização, detecção de duplicata e bloqueio explícito de links do X.
2. **Descoberta por 11 feeds públicos** com cache de 5 min, dedup por URL/título, contagem `responded/total` e status por veículo.
3. **Extração SSRF-safe**: JSON-LD, `og:*`, `<p>` filtrados, detecção de paywall, limite de 1,5 MB, timeout 8,5 s, redirects revalidados um a um, charset `windows-1252` tratado.
4. **GDELT DOC 2.0** (sem chave, últimos 3 dias) com cache e tratamento de 429.
5. **Gemini URL Context** com filtro de URLs (sem X/Instagram/login), cache de 10 min, e uso explícito de `urlContextMetadata` para só citar o que foi realmente recuperado.
6. **Roteiro estruturado por cenas** via `responseSchema`, com filtro estrito dos `sourceIds` contra o dossiê (não deixa a IA inventar IDs) e guia de extensão por versão (curta/expandida).
7. **Dois fallbacks sem IA**: “Montar rascunho do dossiê” (determinístico, uma cena por fonte, ressalva automática) e “Criar roteiro manual”.
8. **Ficha de direitos** por ativo (autor, licença, URL da licença, atribuição, data de captura) + **manifesto JSON auditável** com `autoPublishEnabled: false`.

### 2.2 Mídia licenciada (bem acima da média)

9. Wikimedia por dois caminhos (foto canônica do artigo da Wikipédia → Commons API) + Internet Archive com resolução do arquivo real.
10. **Filtros de licença reais**: rejeita ND (`by-nd`, `nc-nd`), exige licença identificável, rejeita SVG/mapa/bandeira/logo/meme por regex, exige resolução mínima, pontua coerência com a busca e penaliza erro geográfico (Argentina/Chile quando a pauta é Brasil).
11. **Auto-preenchimento por nomes citados** na ordem em que aparecem na narração, com cache por termo, dedupe global e entidades ignoráveis (`ignoredEntities`).

### 2.3 Qualidade, legenda e export

12. **QC com 6 verificações** (fontes, vínculo de afirmações, direitos, voz, duração/monetização >60 s, gate humano) e **bloqueio real da aprovação** quando há erro bloqueante.
13. **SRT/VTT** com quebra por 42 caracteres e timing proporcional à duração da cena.
14. **Render MP4** 1080×1920 H.264/AAC via FFmpeg, com legenda queimada, faixa do canal e áudio opcional — comprovadamente funcional (o MP4 de 75 s está no repo).
15. **UI dark coerente**, responsiva, com prévia 9:16 que toca narração e anima a boca do avatar.

---

## 3. O que falta — e o que está quebrado

### 3.1 Lacunas que impedem “gerar, editar e visualizar vídeos” de verdade

| # | Lacuna | Evidência no código | Impacto |
|---|---|---|---|
| 1 | **A prévia não é o vídeo** | `presenter-avatar.ts` é SVG no DOM; `export-video.ts` não compõe avatar nenhum, só escreve `drawtext='CANAL DARK · APRESENTADOR VIRTUAL'` | O arquivo final não tem apresentador. O spec (§16, critério 10) admite que está pendente; a UI não avisa |
| 2 | **Render é síncrono e descartável** | `POST /api/export/render-mp4` devolve `Buffer` como download; `execFileAsync` com 30 s/segmento e 90 s final; sem job, sem %, sem cancelar | Para 10–20 cenas a requisição pode passar de minutos e o navegador fica pendurado; nada fica salvo |
| 3 | **Não existe biblioteca de vídeos** | Nenhum endpoint de listagem/streaming; `stage: 'RENDERED'` **nunca é atribuído** (só existe no type) | “Visualizar vídeos” hoje = prévia sintética. Não há como reabrir, reassistir ou rebaixar um render |
| 4 | **Persistência só em `localStorage`** | `persist()` engole `QuotaExceededError`; nada no servidor | Contraria a arquitetura alvo (SQLite + pasta por pauta); perde tudo ao limpar o navegador, não há backup, não cabe em muitas pautas (URLs de mídia + trechos) |
| 5 | **Sem áudio exportável por padrão** | `narration.mode: 'tts'` → na hora do render, `audioBase64` só existe se o usuário exportou WAV no **Clipchamp manualmente**; senão entra `anullsrc` (silêncio) | O caminho “gerar vídeo pronto” termina em MP4 mudo. É o maior bloqueio prático |
| 6 | **Edição pobre** | Sem arrastar cena, sem trim por mídia, sem duração por ativo (usa thresholds de progresso), sem transições, sem trilha/efeitos, sem estilo de legenda, sem undo/redo, sem versões do roteiro | O “editor” é um formulário. Roteiro é 1 por pauta, sem histórico (spec §6 pede versões) |
| 7 | **Pipeline incompleto** | `REVIEWED` só aparece em comparação; `RENDERED` nunca setado; `analyticsNotes` nunca usado | Máquina de estados existe no papel e não no fluxo (critério 14 não atendido) |
| 8 | **Pexels não existe** | `MediaAsset.provider` aceita `'pexels'`, nenhum código implementa; RF-07 pede | Fonte de vídeo vertical (a que tem melhor qualidade para 9:16) ausente |
| 9 | **Sem aviso real de envio ao Gemini** | `promptNoticeAccepted: true` hardcoded em 4 lugares | O consentimento que a spec §20 exige é decorativo |

### 3.2 Bugs e problemas técnicos verificados

| # | Problema | Como comprovei |
|---|---|---|
| 10 | **Electron nunca sobe o servidor** — `server.mjs` só chama `app.listen` quando `isMainModule(import.meta.url)`; importado pelo Electron, é `false`; a janela carrega `localhost:3000` após 1,2 s fixos | `import(...)` + `fetch(:3000)` → **ECONNREFUSED** |
| 11 | `electron/main.js` é ESM sem `"type": "module"` no `package.json` | Hoje passa porque o Node 26/Electron recente auto-detecta ESM; é frágil (renomear para `.mjs` resolve) |
| 12 | Electron sem `preload`/IPC, sem `safeStorage` para a chave (spec §20 exige), sem ícone, `electron-builder` mínimo | leitura de `electron/main.js` + bloco `build` do `package.json` |
| 13 | **Ícones e fontes vêm do CDN do Google** | `src/index.html` linhas 17–23 → offline/desktop sem `mat-icon` |
| 14 | **Servidor escuta em `0.0.0.0`** com a chave Gemini no processo, sem autenticação | `src/server.ts:284` e `angular.json` (`host: 0.0.0.0`) → qualquer máquina da LAN gasta sua cota |
| 15 | **Corpo de 25 MB × áudio base64 de 20 MB = 26,7 MB** | `express.json({limit:'25mb'})` × `MAX_AUDIO_BYTES` → 413 para WAV grande; o limite de áudio é inalcançável |
| 16 | Legenda quebra em **42** no SRT e em **40** na prévia | `buildSubtitles` (42) × `studio-qc-view.ts:481` (40) → prévia ≠ arquivo |
| 17 | Duas cópias dos extratores de entidades e das stopwords | `studio-store.ts` × `research.ts` (~150 linhas duplicadas) |
| 18 | **Zero testes** | nenhum `*.spec.ts`, apesar de `tsconfig.spec.json` existir; `lint` é só `tsc` |
| 19 | README é o boilerplate do Angular CLI | 59 linhas, nada sobre o produto |
| 20 | Budget estourado | build acima: 510,62 kB > 500 kB |
| 21 | Modelo `gemini-4-hydrogen` hardcoded | `gemini.ts:10`; a spec fala “Gemini 3.8 Flash” — divergência e risco de 404 na conta |
| 22 | Mistura de idioma na UI | `stage` (`DISCOVERED`) e `severity` (`blocking`) crus na tela |

---

## 4. Proposta de interface visual completa

### 4.1 Princípio: separar o que já é bom do que precisa ser refeito

O app tem um **núcleo editorial forte** (dossiê, vínculo de fontes, licenças, QC, aprovação) e uma **camada de vídeo fraca** (render síncrono, sem biblioteca, sem áudio real, prévia fictícia). A interface nova deve:

- manter o núcleo editorial como está (é o diferencial e o que a spec protege);
- trocar a camada de vídeo por **jobs + artefatos persistidos + player real**;
- fazer a prévia **ser** o vídeo (mesmo compositor, resolução menor).

### 4.2 Arquitetura alvo

```
┌───────────────────────── Navegador (Angular) ─────────────────────────┐
│ Biblioteca │ Wizard (5 passos) │ Editor (timeline+player+inspetor)    │
│ Player final │ Fila de jobs (SSE) │ Configurações                      │
└───────────────┬───────────────────────────────────────────────────────┘
                │ REST + SSE
┌───────────────▼─────────── Express (BFF) ─────────────────────────────┐
│ /api/projects  /api/jobs  /api/videos  /api/render  /api/tts          │
│ /api/media  (existentes: rss, gdelt, extract, gemini, auto-fill)      │
│ ┌────────────┐  ┌──────────────┐  ┌───────────────┐  ┌─────────────┐  │
│ │ Fila de    │  │ Armazenamento│  │ Motor FFmpeg  │  │ Motor TTS   │  │
│ │ jobs (1:1) │  │ SQLite+files │  │ (render)      │  │ pt-BR       │  │
│ └────────────┘  └──────────────┘  └───────────────┘  └─────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

**Novos endpoints**

| Método | Rota | Função |
|---|---|---|
| `GET/POST` | `/api/projects` | Lista/cria pauta (substitui o `localStorage`) |
| `GET/PATCH/DELETE` | `/api/projects/:id` | Carrega/salva o projeto inteiro (roteiro, cenas, mídias, QC) |
| `POST` | `/api/projects/:id/import-legacy` | Migração única do `localStorage` |
| `POST` | `/api/jobs` | Enfileira `research`, `script`, `media`, `tts`, `render-preview`, `render-final` |
| `GET` | `/api/jobs`, `/api/jobs/:id` | Estado, etapa, %, ETA, log |
| `GET` | `/api/jobs/events` | **SSE** para a fila ao vivo |
| `POST` | `/api/jobs/:id/cancel` | Cancelar |
| `GET` | `/api/videos` | Biblioteca (paginada, filtro por status) |
| `GET` | `/api/videos/:id/stream` | MP4 com **HTTP Range** (seek no player) |
| `GET` | `/api/videos/:id/artifacts/:name` | SRT, VTT, manifesto, thumbnail, roteiro |
| `POST` | `/api/videos/:id/duplicate` | Duplicar para variação (A/B de duração) |

### 4.3 As seis telas

**1) Biblioteca (nova home)**
Grid de cards 9:16 (thumb do meio da cena 1) com: título, editoria, selo de status (`Rascunho / Pronto para render / Renderizado / Aprovado`), duração, data, e ações rápidas (Abrir no editor, ▶ Assistir, ⬇ MP4, ⋯ duplicar/excluir). Filtros por status e editoria + busca. Botão fixo **“Novo vídeo”** que abre o wizard.
*Resolve:* “visualizar os vídeos” e a ausência total de biblioteca.

**2) Wizard de geração (5 passos, cancelável)**
Barra de progresso horizontal com etapas vivas:

1. **Pauta** — URL ou manchete dos feeds; editoria; versão (45–60 s / 90–150 s).
2. **Fontes** — roda extração + GDELT + RSS + URL Context em paralelo, mostrando cada fonte chegar (chip verde/âmbar/cinza). Botão “refazer com outro termo”.
3. **Roteiro** — Gemini com streaming do JSON → cenas aparecem conforme chegam; três botões de origem (Gemini / rascunho do dossiê / manual). Aviso explícito de envio ao Gemini com checkbox (conserta o item 9).
4. **Mídia e voz** — auto-fill por nomes citados; grade de candidatos com licença visível; escolha da voz pt-BR e **geração do áudio real** com botão ▶ para ouvir.
5. **Render** — preview 540×960 (rápido) e final 1080×1920, com fila, % e log.

Cada passo grava no servidor; fechar o navegador não perde nada.

**3) Editor — a “mesa de edição” (3 painéis + topbar)**

```
┌ topbar: [◀ Biblioteca]  Título do vídeo…   ⟲ ↷  ● Salvo 2s  [Prévia] [Renderizar final] ┐
├───────────────┬──────────────────────────────────┬─────────────────────────────────────┤
│ CENAS         │        PREVIEW 9:16              │  INSPETOR (cena selecionada)         │
│ ┌───────────┐ │  ┌────────────────────┐          │  Narração (textarea + contador)      │
│ │ 01 · 6s ⣿ │ │  │                    │          │  Duração [slider 3–30 s]             │
│ │ [thumb]   │ │  │   <video> real     │          │  Avatar: tela cheia / PiP / oculto   │
│ │ ● 2 fontes│ │  │       1080×1920    │          │  Expressão: neutra…encerramento      │
│ └───────────┘ │  │                    │          │  ── Mídias da cena ──                │
│ ┌───────────┐ │  └────────────────────┘          │  [1] ▬▬▬▬▬ 3,2 s  ⣿ ✕              │
│ │ 02 · 8s ⣿ │ │  ▶ 00:12 / 00:58   ─────●──      │  [2] ▬▬▬ 2,1 s     ⣿ ✕   [+ add]    │
│ └───────────┘ │  [Safes zones] [9:16] [Auto]     │  ── Legenda ──                       │
│ [+ nova cena] │                                  │  Estilo: bloco/preview, tamanho      │
│               │                                  │  ── Fontes vinculadas ──             │
│               │                                  │  [SRC-1] [SRC-3]  ⚠ cena sem fonte   │
└───────────────┴──────────────────────────────────┴─────────────────────────────────────┘
```

- **Timeline vertical com drag & drop** (reordenar cenas), badge de duração total, e uma **régua de 60 s** marcando o limite de monetização.
- **Player real**: `<video>` tocando um **proxy renderizado** (720×1280, 12 fps, `ultrafast`) — não uma simulação. Play, pause, seek, volume, e toggle de safe zones desenhadas em SVG por cima.
- **Inspetor** com trim por mídia (barras arrastáveis), estilo de legenda com preview ao lado, e aviso vermelho quando a cena não tem fonte vinculada (o QC antecipado).
- **Topbar** com undo/redo (pilha de patches no store), indicador de autosave (“Salvo há 2 s”), e dois botões: **Prévia** (rápido, 720p) e **Renderizar final** (vai para a fila, 1080p).

**4) Player / visualizador final (modal)**
`<video>` com Range streaming e abas: **Vídeo · Legendas · Roteiro · Dossiê · Manifesto · QC**. Cada aba é exportável (MP4, SRT, VTT, TXT, JSON). Aqui entram os campos de `analyticsNotes` (views, % assistido) para o critério 14.

**5) Fila de execução (drawer global)**
Jobs com etapa (`Baixando mídia 3/8`), barra de %, ETA, log expansível, botão cancelar. Alimentada por SSE — o usuário pode navegar sem perder o progresso.

**6) Configurações**
Chave Gemini (mascarada; `safeStorage` no Electron), voz pt-BR padrão, fontes de mídia habilitadas, limite de cota/pausa, pasta de projetos, e um botão “Rodar diagnóstico” (ffmpeg presente? chave válida? feeds respondendo?).

### 4.4 Modelo de dados e arquivos

```sql
projects(id, title, url, editorial, stage, mode, created_at, updated_at, approved_at, approval_note)
sources(id, project_id, kind, domain, title, url, published_at, consulted_at, excerpt)
scenes(id, project_id, order, duration_sec, narration, visual_pt, visual_en,
       avatar_mode, avatar_expression, transition, source_ids_json)
scene_media(id, scene_id, asset_id, position, start_sec, end_sec, is_documentary)
media_assets(id, provider, kind, media_url, page_url, author, license_name, license_url, attribution)
renders(id, project_id, kind /*preview|final*/, status, progress, path, duration_sec, bytes, error)
script_versions(id, project_id, payload_json, created_at, origin /*gemini|dossie|manual*/)
jobs(id, project_id, kind, status, stage, pct, message, log, created_at, started_at, finished_at)
```

```
CanalDark/projects/<projectId>/
├── project.json          (snapshot legível, à prova de corrupção do SQLite)
├── assets/<assetId>.jpg
├── audio/narracao.mp3
├── subs/legendas.srt|.vtt|.ass
├── render/preview.mp4
├── render/final.mp4
└── manifesto-direitos.json
```

### 4.5 O problema central: paridade entre prévia e arquivo final

Hoje existem dois mundos: a prévia (SVG no navegador) e o MP4 (FFmpeg). A correção é **um único compositor canônico** alimentando os dois.

1. **Render de prévia** = mesmo pipeline do final, com `scale=720:1280`, `-r 12`, `preset ultrafast`, `crf 30`, e cortando em N cenas para responder em segundos.
2. **Avatar dentro do MP4** — duas rotas:
   - **(a) recomendada:** rasterizar o SVG (canvas offscreen ou Playwright) em sequência PNG com `jawOpen` vindo do envelope de áudio já calculado no servidor → `ffmpeg -i frames/%05d.png -i fundo -filter_complex overlay`;
   - **(b) atalho:** `MediaRecorder` no navegador gerando WebM do canvas em tempo real (simples, mas exige reproduzir o vídeo inteiro e tem qualidade inferior).
3. **Legendas**: trocar `drawtext` + `subtitles` por **ASS gerado por template** com fonte empacotada localmente (`Anton` ou `Bebas`), área segura, contorno e estilo configurável — o mesmo ASS alimenta a prévia via WebVTT.
4. **Áudio**: TTS pt-BR real (`edge-tts` `pt-BR-AntonioNeural`/`FranciscaNeural`, gratuito, com `WordBoundary`), mixagem com música em ducking (`sidechaincompress`) e `loudnorm -14 LUFS`.
5. **Movimento**: `Ken Burns` em stills (`zoompan`) e transições `xfade` entre segmentos — hoje tudo é corte seco.

### 4.6 Caminho alternativo (e provavelmente o mais rápido): motor `purffle-shorts`

Você já tem, nesta mesma pasta, o **`C:\CanalDark\purffle-shorts`** — um pipeline Python em produção que:

- gera **voz pt-BR neural** (`edge:pt-BR-AntonioNeural`, confirmado em `metadata.json`);
- legendas **palavra por palavra** a partir de `WordBoundary` (renderizadas como PNG com emoji);
- transições, grade de cor, música com ducking, loudness, `cover.jpg`, `captions.srt`, `metadata.json`;
- exporta **1080×1920 H.264/AAC** de verdade (5 vídeos prontos em `output_videos/`, um de 77,5 s);
- expõe **REST API com jobs + SSE** (`/api/make`, `/api/draft`, `/api/jobs`, `/api/events`, `/api/videos`, `/api/videos/<id>/file/...`) e MCP;
- aceita **`script_file` JSON** exatamente no formato que o Canal Dark já sabe produzir:

```json
{ "title": "...", "hook": "...", "scenes": [
    { "narration": "texto pt-BR", "search_query": "meteor night sky" } ], "cta": "" }
```

- aceita **mídia local** (`MEDIA_DIR` + `VISUAL_SOURCES=local`): dá para despejar as mídias **licenciadas e com atribuição do Canal Dark** em `media/` e usar `visualQueryEn` como `search_query`, preservando a proveniência.

**Como ficaria a integração**

```
Angular (editor) → Express → POST http://127.0.0.1:8765/api/make  (X-Studio-Token)
                              body = script.json montado do PautaRecord
                              ↓ SSE /api/events (etapa/%)
                ← copia output_videos/<id>/short.mp4 + captions.srt + cover.jpg
                ← grava em projects/<id>/render/final.mp4 e atualiza stage=RENDERED
```

**O que delegar** ao purffle: TTS, legendas palavra-a-palavra, transições, música, grade, render e biblioteca de arquivos.
**O que nunca delegar**: dossiê, vínculo de afirmações, QC, aprovação humana e manifesto de direitos (o `metadata.json` do purffle lista `pixabay` por id, **sem autor nem URL de licença** — não serve como ficha de direitos).

**Riscos**: dois runtimes (Node + Python), porta/token extras, e o fork pode divergir do upstream. Mitigação: contrato em um único arquivo (`purffle-bridge.ts`) e fallback para o motor FFmpeg nativo se a ponte falhar.

### 4.7 Roadmap sugerido (ordem que entrega valor a cada fase)

| Fase | Entrega | Esforço |
|---|---|---|
| **F0 — Fundação** | SQLite + `/api/projects` + jobs + SSE + biblioteca + `GET /api/videos/:id/stream`; migração do `localStorage`; `stage: RENDERED` real | 2–3 d |
| **F1 — Editor** | Timeline com drag & drop + trim por mídia + inspetor + undo/redo + autosave; player de **prévia renderizada** | 4–6 d |
| **F2 — Áudio e paridade** | TTS pt-BR real; avatar no MP4; ASS templatizado; transições + música; preview/final | 3–5 d |
| **F3 — Geração guiada** | Wizard 5 passos com progresso e cancelamento; fila em lote; versão curta/expandida A/B | 2–3 d |
| **F4 — Visualização** | Player final com Range + abas (roteiro/dossiê/manifesto/QC) + analytics manual | 2 d |
| **F5 — Desktop** | Electron corrigido, `preload`+IPC, chave com `safeStorage`, fontes/ícones locais, instalador | 2–3 d |
| **F6 — Consolidação** | Testes Vitest nos módulos puros (subtitles, entidades, ssrf, args de FFmpeg), README, CI | contínuo |

### 4.8 Quick wins (menos de um dia, alto impacto)

1. `export function startServer(port)` em `server.ts` e o Electron chamando — **hoje o desktop abre em tela branca**.
2. Bind em `127.0.0.1` por padrão (com flag `--lan`).
3. Setar `stage: 'RENDERED'` após render OK + guardar o último MP4 em `projects/<id>/`.
4. Unificar a quebra de legenda (42) entre prévia e export.
5. Elevar o budget para 600 kB (ou lazy-load do Material).
6. Empacotar Material Icons e as fontes em `public/assets/fonts/`.
7. `README.md` do produto + `.env.example` com `GEMINI_API_KEY`, `PORT`, `TTS_VOICE`.
8. Aviso real de envio ao Gemini (substituir `promptNoticeAccepted: true`).
9. Corrigir o limite de corpo (30 MB) ou enviar áudio por `multipart/form-data`.
10. Deduplicar os extratores de entidades em um módulo compartilhado.

### 4.9 Critérios de aceite da nova interface

1. Do zero ao MP4 com avatar, voz e legenda em **≤ 8 cliques**.
2. Prévia de 60 s renderizada em **< 20 s**; final em **< 3 min**; progresso visível e cancelável.
3. Nenhuma ação destrutiva sem undo; autosave ≤ 2 s; fechar o navegador não perde trabalho.
4. A biblioteca sobrevive a reinício e o player faz **seek** (Range).
5. Arquivo final **é igual** à prévia (mesma composição, avatar e legenda).
6. QC bloqueante impede render final sem fonte/licença.
7. Zero `localStorage` como fonte de verdade; zero `any` na fronteira de API.

---

## 5. Decisões que preciso de você

1. **Motor de render:** (a) evoluir só o FFmpeg nativo do app; (b) **híbrido**, usando o `purffle-shorts` para TTS/legendas/transições e o Canal Dark como front editorial (mais rápido para chegar a vídeo com voz); (c) adotar o purffle inteiro e aposentar o Angular.
2. **Onde roda:** desktop Electron (offline, chaves locais) ou navegador local (`127.0.0.1`)?
3. **Avatar:** manter o SVG procedural (rápido, sem licença de terceiros) ou partir para um modelo neural (avatarz/WebGL → mais realista, precisa de licença comercial do personagem)?
4. **Publicação:** fica fora do escopo (como a spec manda) ou entra como “exportar pacote pronto para upload” já na F4?

Com essas respostas, a F0 + F1 saem como código funcionando na próxima rodada.

---

## 6. Atualização de 25/11/2026 — chave Gemini instalada e funcionando

Depois do diagnóstico, a chave Gemini de faixa gratuita foi configurada **apenas no servidor** e validada de ponta a ponta. O que mudou:

### 6.1 Correções aplicadas

| # | Mudança | Motivo |
|---|---|---|
| 1 | `.env`, `.env.local`, `.env.*.local` adicionados ao `.gitignore` (`!.env.example`) | O `.env` **não estava ignorado**: a chave poderia ir para o commit |
| 2 | `.env` criado (nunca versionado) com `GEMINI_API_KEY` e `GEMINI_MODEL` | Segredo isolado no processo Node |
| 3 | Modelo passou de `gemini-4-hydrogen` (const) para `activeGeminiModel()` lendo `GEMINI_MODEL` | Constante de módulo lia o ambiente **antes** do `process.loadEnvFile()` |
| 4 | `DEFAULT_GEMINI_MODEL = 'gemini-flash-lite-latest'` | `gemini-4-hydrogen`/`3.8-flash` retornam **503 UNAVAILABLE** com frequência; `gemini-2.5-*` retornam **404 "no longer available to new users"** |
| 5 | `httpOptions.apiVersion = 'v1beta'` no cliente Gemini | O SDK usa **v1** por padrão, onde aliases `*-flash-lite-latest` **não existem** (404) e `urlContext` não está disponível |
| 6 | `withGeminiModelFallback()` + cadeia `['gemini-flash-lite-latest', 'gemini-3.5-flash-lite']` + mensagem clara para 503 | Antes, um 503 devolvia o JSON cru do erro na interface |
| 7 | `.env.example` documenta `GEMINI_MODEL` | Descobribilidade |

### 6.2 Evidências (medidas nesta máquina)

| Teste | Resultado |
|---|---|
| `/api/config/status` | `geminiConfigured: true`, `activeModel: gemini-flash-lite-latest` |
| Chave no bundle do navegador (`/`, `/main.js`) | **não aparece** |
| `POST /api/gemini/script` (2 fontes, modo curto) | HTTP 200 em **2,1 s**, 4 cenas, `sourceIds` corretamente vinculados (`SRC-1` para o fato, `SRC-2` para a repercussão) |
| `POST /api/gemini/url-context` (2 URLs) | HTTP 200 em **7,2 s**, 6 fatos, 4 incertezas, 2 URLs recuperadas |
| `POST /api/research/extract` | `status: ok`, 2.600 caracteres extraídos |
| `tsc --noEmit` | 0 erros |

### 6.3 Observação importante de segurança

A chave foi enviada pelo chat, portanto **existe no histórico desta conversa**. Recomenda-se:

1. criar uma chave dedicada ao projeto no AI Studio e revogar esta depois;
2. nunca commitar o `.env` (agora ignorado);
3. manter o servidor em `127.0.0.1` — o `npm run dev` do projeto usa `0.0.0.0` e não há autenticação.

### 6.4 Como trocar de modelo

Editar `GEMINI_MODEL` no `.env` e reiniciar o servidor (o `.env` é lido no boot). Para listar o que a chave acessa:

```bash
node -e "fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200',{headers:{'x-goog-api-key':process.env.GEMINI_API_KEY}}).then(r=>r.json()).then(j=>console.log(j.models.map(m=>m.name).join('\n')))"
```

---

## 7. Correção de 25/11/2026 — render MP4 falhava ao baixar (`drawtext` / fontconfig)

### 7.1 Sintoma

Ao clicar em **Baixar vídeo 9:16 (.MP4)** o servidor devolvia:

```
Fontconfig error: Cannot load default config file: File not found
```

e o processo FFmpeg morria com `0xC0000005` (access violation), sem gerar o arquivo.

### 7.2 Causa

O filtro `drawtext` (faixa "CANAL DARK · APRESENTADOR VIRTUAL") precisa de uma fonte. O build do FFmpeg para Windows distribuído pelo gyan **não inclui fontconfig configurado**, então o filtro não encontra a fonte padrão e derruba o processo.

Tentativa intermediária também falhou: passar `fontfile=C:/Windows/Fonts/arialbd.ttf` **quebra o parser de filtros**, porque o `:` do drive é lido como separador de opções (`No option name near '/Windows/Fonts/...'`).

### 7.3 Solução aplicada (`src/server/export-video.ts`)

1. `resolveLabelFontPath()` escolhe uma fonte existente, nesta ordem: `CANAL_DARK_FONT` (env) → `public/assets/fonts/canal-dark-bold.ttf` (empacotada) → Arial/Segoe UI Bold do Windows → Arial/Liberation/DejaVu (macOS/Linux).
2. A fonte é **copiada para a pasta de trabalho** e referenciada como `fontfile=label-font.ttf` — caminho relativo, **sem o `C:`** que quebra o parser.
3. `buildVideoFilter(includeLabel)` monta a cadeia condicionalmente (faixa + legenda).
4. Se o passe final falhar **por causa da faixa**, o render é repetido **sem ela**, preservando a legenda — o vídeo nunca mais é perdido por um detalhe cosmético.
5. Legenda reposicionada para a zona segura: `MarginV=48`, `FontSize=12` (≈ 80 px de texto e ≈ 320 px de margem no 1080×1920, acima da barra do Shorts).

### 7.4 Evidências

| Teste | Resultado |
|---|---|
| Reprodução isolada do `drawtext` sem `fontfile` | crash `0xC0000005` + erro de fontconfig |
| `drawtext` com `fontfile` relativo | exit 0 |
| `drawtext` + `subtitles` juntos | exit 0, imagem com diferença PSNR 18 dB vs. fundo liso (texto realmente renderizado) |
| `POST /api/export/render-mp4` (2 cenas, 8 s, sem áudio) | **HTTP 200 em 2,6 s**, 246 KB, H.264 1080×1920 + AAC, 8,0 s |
| Inspeção visual do frame | faixa do canal legível com caixa preta; legenda "O Copom manteve a Selic em 15% ao ano." com acentos corretos na zona segura |

Amostra gerada: `C:\CanalDark\teste-render-1080x1920.mp4`.

### 7.5 Pendências relacionadas (do diagnóstico inicial)

- O vídeo final **ainda não contém o avatar** — a faixa textual é só rótulo. Ver §4.5 (rasterizar o SVG e sobrepor).
- Vídeos sem áudio importado continuam saindo com faixa silenciosa (`anullsrc`); a solução definitiva é o TTS pt-BR (§4.5, item 4).

---

## 8. Avatar no MP4 e narração automática em pt-BR (implementados em 25/11/2026)

Fecha as duas lacunas de §7.5.

### 8.1 Narração: voz neural sem chave de API

- **Motor:** `msedge-tts` (mesmo serviço que o Edge/Clipchamp usam), em **Node puro** — sem Python, sem chave, sem custo. Vozes: `pt-BR-AntonioNeural` e `pt-BR-FranciscaNeural`.
- **Normalização compartilhada:** a regra de fala (números, `%`, `R$`, siglas) saiu de `speech-preview.ts` para `src/app/services/pt-br-speech.ts` e passou a ser usada **também no servidor** — a prévia do navegador e o áudio do MP4 pronunciam igual.
- **Timeline dirigida pelo áudio:** cada cena é sintetizada, medida, e a cena **cresce** quando a fala não cabe (com 0,25 s de respiro). O SRT é **retemporalizado** proporcionalmente (`src/server/subtitles.ts`), então a legenda não atrasa. Nada de voz cortada.
- **Faixa única:** PCM 16 kHz mono decodificado via FFmpeg, concatenado com silêncio de preenchimento, gravado como WAV para o passe final (AAC 44,1 kHz).
- **Falha de TTS não perde o vídeo:** cena muda vira silêncio; se a narração foi pedida e nada foi gerado, a API responde com erro explícito em vez de entregar um vídeo mudo sem avisar.

### 8.2 Avatar: SVG do componente rasterizado e sobreposto

- `src/server/avatar-svg.ts` é o **porte fiel** do componente `presenter-avatar.ts` (mesmas coordenadas, sobrancelhas por expressão, inclinação da cabeça, balanço ao falar, boca e dentes).
- `src/server/avatar-overlay.ts` rasteriza com **`@resvg/resvg-js`** (binário nativo, sem navegador) em **8 níveis de abertura de boca**, monta um `concat` de imagens e codifica um **MOV com canal alfa** (`png/rgba`) na taxa do vídeo.
- **Sincronismo por envelope de áudio:** `buildJawEnvelope()` calcula o RMS por quadro (30 fps) do PCM da narração, normaliza pelo percentil 92, suaviza e quantiza em 8 níveis — a boca abre quando há fala e fecha no silêncio.
- **Por cena:** `avatarMode` define `full` (figura central, acima da legenda), `pip` (cartão arredondado no topo direito, como na prévia) ou `hidden` (sem avatar). Cada janela entra no passe final via `overlay=...:enable='between(t,a,b)'`.
- Sem narração (áudio importado do Clipchamp ou nenhum), o avatar usa uma respiração suave para não parecer congelado.

### 8.3 Interface

Na aba **Estúdio e QC → Pacote de saída**, antes dos botões de download:

- ☑ **Narração pt-BR neural** + seletor de voz (Antonio/Francisca);
- ☑ **Avatar no vídeo**;
- texto de apoio explicando o que cada opção faz.

O payload do render passou a enviar `narration`, `avatarMode` e `avatarExpression` por cena.

### 8.4 Evidências

| Teste | Resultado |
|---|---|
| Render 3 cenas (full / pip / hidden), sem mídia, com narração | **HTTP 200 em 12,4 s** |
| Duração planejada vs. real | 16,0 s → **18,07 s** (falas não cabiam; SRT remapeado) |
| Áudio tem fala? | `mean −21,6 dB`, `peak −3,7 dB` |
| Frame t=2 s | avatar em tela cheia, boca aberta, **acima da legenda** |
| Frame t=8 s | avatar PiP com cartão arredondado, legenda livre |
| Frame t=13 s | cena `hidden`, sem avatar |
| Alfa do PNG | composição sobre fundo vermelho sem caixa preta |

Amostra: `C:\CanalDark\teste-avatar-narracao.mp4` (18 s, 1,1 MB).

### 8.5 Infra e dependências

- **Novas dependências:** `msedge-tts` (TTS) e `@resvg/resvg-js` (rasterização). Ambas nativas/binárias.
- **`angular.json`:** as duas foram marcadas como `externalDependencies` (build dev e produção) e excluídas do `prebundle` do dev-server — sem isso o otimizador do Vite tenta empacotar o `.node` e quebra o SSR.
- **Arquivos novos:** `src/server/narration.ts`, `src/server/avatar-svg.ts`, `src/server/avatar-overlay.ts`, `src/server/subtitles.ts`, `src/app/services/pt-br-speech.ts`.

### 8.6 Limites conhecidos (próximas etapas)

1. **Empacotamento:** com as dependências externas, o `server.mjs` de produção exige `node_modules` em runtime. O `files` do `electron-builder` hoje não inclui `node_modules` — o instalador desktop precisará embarcá-las (§5, F5).
2. **TTS exige rede** (serviço do Edge). Sem internet, o render precisa rodar com narração desligada.
3. **Trilha musical/efeitos** e **transições/Ken Burns** continuam ausentes (§4.5, itens 4 e 5).
4. Render é **síncrono**: 16 s de vídeo levaram 12 s, mas um Short de 90 s pode passar de um minuto de espera sem barra de progresso — a fila com SSE (§5, F0) resolve.
5. Boca quantizada em 8 níveis a 30 fps: leitura natural, sem interpolação fina.

---

## 9. Notícias mais variadas e mídia mais coerente (25/11/2026)

### 9.1 Fontes de notícia: 11 → 51 feeds

| Antes | Depois |
|---|---|
| 11 feeds fixos | **51 feeds**, todos respondendo |
| 143 manchetes (cache) | **400 manchetes** na janela |
| ~10 veículos | **28 veículos** |
| Sem filtro de data | **Janela explícita** (24 h / 48 h / 3 dias / 7 dias / sem filtro) |

**Fontes adicionadas:** 7 feeds do Google News (Brasil, Mundo, Economia, Tecnologia, Ciência, Esportes, Entretenimento), Agência Brasil (5 editorias), g1 (política, ciência, esportes, pop), Folha (poder, ilustrada, esporte), UOL (economia, esporte, tecnologia, entretenimento), Metrópoles (esportes), BBC Brasil, CartaCapital, Brasil de Fato, InfoMoney, Exame, Tecnoblog, ShowMeTech, MobileTime, ge, ESPN Brasil, Poder360, CNN Brasil, Jovem Pan, Veja, Agência Senado.

**Substituídos por estarem mortos:** UOL Splash (404), R7 (404), TecMundo (204 sem conteúdo), Gazeta do Povo (0 itens), Metrópoles Tecnologia (0 itens), g1 Esportes (0 itens), Agência Câmara (0 itens).

**Evidência do último refresh:** 51/51 feeds OK, 0 vazios, 400 itens, **todos publicados nas últimas 24 h**, mais recente com 8 minutos.

### 9.2 Mídia: menos imagens, muito mais critério

O padrão passou a ser **1 mídia por cena** (antes 2). As mudanças de seleção:

1. **Fim do casamento por substring.** `scoreAssetCoherence` usava `includes`, então "Selic" casava com "Selic Alaska" e com o sobrenome "Šelić". Agora o casamento é por **palavra inteira** (`\b`), sobre título **e descrição/categorias** do acervo (novo campo `description` em `MediaAsset`, vindo do `extmetadata` do Commons).
2. **Exigência de contexto.** Uma busca de **uma palavra** só é aceita se o ativo também trouxer um termo de contexto da cena/pauta. Isso barra homônimos e nomes parecidos.
3. **Fim dos termos genéricos.** A editoria saiu da busca e as queries visuais do roteiro só entram se nomearem algo concreto (lista de termos genéricos: "reunião", "comitê", "economia", "inflação", "meeting", "building"...).
4. **Fim do preenchimento forçado.** Antes, se a busca não achava nada bom, o código preenchia com os primeiros resultados do acervo. Agora a cena fica **sem mídia** e o render usa o cenário do estúdio — o que você pediu: menos imagens, mais coerência.
5. **Enquadramento como desempate:** vertical +1,5, horizontal −0,5, resolução alta +1.
6. **Rejeição de conteúdo não fotográfico** por título/categorias: gráfico, mapa, logo, bandeira, print, tabela, pôster.
7. **Dedupe por título** além de id, para não repetir a mesma foto em cenas diferentes.

### 9.3 Resultado medido (mesmas cenas, antes e depois)

| Cena | Antes | Depois |
|---|---|---|
| "Copom manteve a Selic em 15%" | `Kulturni programi NBVG - Marko Šelić Marčelo` (pessoa errada) | `Banco Central do Brasil 1970.jpg` (vertical) |
| "decisão unânime do comitê" | `Jennifer Mueller-Applegate FO- Selic Alaska` | **sem mídia** (nada coerente) |
| "Lula se reuniu com Haddad" | — | `Pronunciamento à Nação` (foto do Lula, vertical) |
| "enchente na Avenida Paulista" | — | `Vista da Avenida Paulista - Sesc` (vertical) |

### 9.4 Na interface

- **Descoberta:** seletor de janela de atualidade + "mais recente dd/MM HH:mm" + botão **"Mostrar mais manchetes"** (30 por vez).
- **Mídia e Voz:** o seletor de mídias por cena já abre em **1 mídia/cena**.

### 9.5 Limites

1. Acervos livres (Wikimedia/Internet Archive) **não têm foto do fato noticiado**: para pautas econômicas abstratas, é comum a cena ficar sem mídia. O caminho para cobrir isso é Pexels/Pixabay (RF-07) ou banco próprio de imagens.
2. O filtro de coerência é lexical: entende "Banco Central do Brasil" × "Banco Central do Brasil", mas não entende ironia, contexto ou imagem visualmente parecida com outro assunto.
3. Feeds mudam de URL com frequência; o app mostra o status por veículo, então quebras aparecem no painel em vez de sumirem em silêncio.

### 9.6 Decisão registrada: manter só acervos livres

Pexels/Pixabay **não** serão integrados (nem com chave gratuita). Consequência aceita de propósito:

- pautas abstratas (Selic, inflação, PIB) costumam ficar **sem mídia**;
- a cena sem mídia usa o **cenário do estúdio** (`public/assets/studio-fallback-bg.jpg`), que já tem a faixa do canal e a legenda por cima;
- o QC sinaliza "cobertura visual" como **aviso**, nunca como bloqueio — o vídeo pode ser aprovado mesmo sem imagem em alguma cena.

Validação com o pior caso (nenhuma cena com mídia): render de **16,1 s em 13,1 s**, 1080×1920 H.264/AAC, avatar em tela cheia e em PiP, narração e legenda sincronizadas. Amostra: `C:\CanalDark\teste-sem-midia.mp4`.

Limitação visível desse caminho: o cenário do estúdio é **a mesma foto parada** em todas as cenas sem mídia — durante vários segundos e repetida entre cenas. Melhorias possíveis, se fizer sentido: *Ken Burns* (zoom lento) no fundo e alternância entre 2–3 cenários.

---

## 10. Ken Burns em todas as imagens (25/11/2026)

Aplicado o movimento de câmera em **toda imagem parada** — fotos do acervo **e** o cenário do estúdio usado nas cenas sem mídia. Vídeos de verdade e cor sólida não recebem o filtro (já têm movimento ou não têm o que mover).

### 10.1 Como funciona

- Filtro `zoompan` com **10% de variação de zoom** ao longo de cada cena, calculado pelo número de quadros (`step = 0.1 / (duração × 30)`).
- **Alternância aproximação/afastamento** por índice de segmento: duas cenas seguidas não repetem o mesmo movimento.
- Zoom centralizado (`x/y` em `iw/2-(iw/zoom/2)`), para não deslocar o enquadramento.
- Entrada da imagem em **30 fps fixos** (`-framerate 30`), senão o `zoompan` receberia 25 fps por padrão e o movimento ficaria irregular.
- **Base 1,5×** (`scale=1620:2880` antes do `zoompan`, saída 1080×1920): o zoom recorta de uma imagem maior, então não amolece como aconteceria ampliando a partir dos 1080 px finais.

### 10.2 Evidências

| Teste | Resultado |
|---|---|
| Movimento entre 1 s e 4 s da mesma cena | **PSNR 21,7 dB** (antes do filtro os quadros eram idênticos) |
| Enquadramento | sem bordas pretas; avatar, faixa e legenda estáticos (correto: só o fundo se move) |
| Tempo de render (2 cenas, 11 s) | **8,9 s** — igual ao render sem Ken Burns |
| Arquivo | 1080×1920, 30 fps, H.264/AAC, ~2 MB para 11 s |

Amostra: `C:\CanalDark\teste-ken-burns.mp4`.

### 10.3 Efeito colateral aceitável

O movimento aumenta a taxa de bits (o arquivo ficou ~2× maior) porque o codificador gasta mais em cena com deslocamento. Para Shorts de até 3 minutos isso continua longe de qualquer limite prático.

---

## 11. Política de duração: o menor vídeo que monetiza (25/11/2026)

**Decisão do produto:** Shorts curtos, no mínimo necessário para monetizar. Passar um pouco do alvo é aceitável; ficar **abaixo** do mínimo, não.

### 11.1 O que mudou

| Antes | Depois |
|---|---|
| Modos "curta (45–60 s)" e "expandida (90–150 s)" | **"Curto (45–58 s)"** e **"Monetizável (60–75 s)"** |
| Meta de 180–230 palavras / 90–140 s | **6 cenas de 26 a 32 palavras** (156–192 no total) |
| QC avisava quando passava de 60 s | QC avisa quando fica **abaixo de 60 s** e quando passa de 180 s |
| Duração final dependia só do roteiro | **Piso determinístico de 60 s** no render |

### 11.2 Como o piso é garantido (três camadas)

1. **Meta por cena no prompt.** Modelos seguem "26 a 32 palavras por cena" muito melhor do que um total solto. Se o roteiro sair abaixo de 150 palavras, o servidor faz **uma única correção** pedindo explicitamente a faixa por cena (nunca um laço).
2. **Ajuste de velocidade medido.** Se a fala medida ainda ficar abaixo do piso, a narração é re-sintetizada **uma vez** na velocidade corrigida (`medida/alvo`, mínimo 0,8×). Não inventa conteúdo nem muda o texto.
3. **Respiro distribuído.** Se nem a 0,8× a fala chega ao piso, a diferença é distribuída como pausa entre as cenas. O Ken Burns e o avatar continuam animando esse tempo, então não parece tela parada.

### 11.3 Evidências

| Cenário | Resultado |
|---|---|
| Roteiro de 140 palavras / 50 s planejados | 58,3 s com ajuste de velocidade (`0,903×`) — curto |
| **116 palavras / 50 s planejados, piso 62 s** | **62,0 s exatos** (`0,8×` + respiro distribuído) |
| Cabeçalhos de resposta | `X-Video-Seconds`, `X-Narration-Rate`, `X-Narration-Seconds` |
| Interface | mostra "Último render: 62s · voz a 0,8× para alcançar o piso de 1 minuto" |

Amostra: `C:\CanalDark\teste-monetizavel.mp4` (62,0 s, 1080×1920).

### 11.4 Nota de honestidade sobre a regra

O "1 minuto" **não é** um requisito formal do YouTube: a elegibilidade ao compartilhamento de receita é do **canal** (1.000 inscritos + 10 milhões de visualizações de Shorts em 90 dias), e Shorts podem ter até **3 minutos**. O minuto foi adotado aqui como **piso editorial de segurança** — é o que a especificação do projeto já tratava no Critério 15 (risco de reivindicação em vídeos acima de 1 minuto) e o que o usuário definiu como alvo. O teto de 3 minutos, esse sim, é regra da plataforma e está no QC.

---

## 12. Etapa 10 da spec: QC e arquivo por pauta (25/11/2026)

Fecha a última etapa da lista da spec (§2) e os critérios de aceite 2 e 8 do MVP. Só os **dados do YouTube** (critério 14) ficaram de fora, por decisão explícita.

### 12.1 O que passou a existir

Cada pauta agora é um diretório com o pacote completo (§4.12):

```
projects/<pautaId>/
├── video.mp4                 1080×1920 H.264/AAC
├── thumbnail.jpg             540×960, frame em ~1 s do próprio vídeo
├── legendas.srt / .vtt       VTT gerado do SRT, com timestamps remapeados
├── roteiro.txt               roteiro + fontes + créditos
├── manifesto-direitos.json   autoria, licença, atribuição por ativo
├── qc-report.json            relatório de QC do momento do render
├── render.json               duração real e velocidade da narração
└── project.json              snapshot completo da pauta
```

**Endpoints novos**

| Método | Rota | Função |
|---|---|---|
| `GET` | `/api/projects` | Lista com `hasVideo`, `hasThumbnail`, `videoSeconds` |
| `GET/PUT/DELETE` | `/api/projects/:id` | Lê, grava e remove o `project.json` |
| `GET` | `/api/projects/:id/video` | MP4 com **HTTP Range** (player pode buscar) |
| `GET` | `/api/projects/:id/thumbnail` | Capa |
| `GET` | `/api/projects/:id/file/:name` | SRT, VTT, roteiro, manifesto, QC (allowlist) |

**Gate de aprovação (critérios 2 e 8):** `POST /api/export/render-mp4` agora aceita `pautaId` e `mode`. Em `mode: 'final'` o servidor **lê o `project.json` do disco** e recusa com `409` se houver QC bloqueante ou se o estágio não for `APPROVED`. Sem identificação de pauta (ou com `mode: 'preview'`), devolve o binário/arquiva a prévia sem liberar o pacote.

### 12.2 Cliente

- `StudioStore` passou a **espelhar as pautas no servidor** (PUT debounced de 800 ms, só do que mudou), com `localStorage` como cache/fallback e `syncFromServer()` no boot para recuperar pautas de outro navegador.
- `markRendered()` grava `stage: RENDERED` e o `render` na pauta — o estágio existia no tipo e nunca era atribuído.
- A aba **Estúdio e QC** ganhou **"Renderizar prévia"** ao lado de "Gerar pacote final", cartão do pacote arquivado (capa, duração, aviso "abaixo de 1 minuto", links para abrir/baixar e para o manifesto/SRT) e mensagem do gate quando o render é recusado.

### 12.3 Evidências (fluxo real, via API)

| Passo | Resultado |
|---|---|
| `PUT` pauta DRAFTED com QC bloqueante | 200 |
| Render `final` sem aprovação | **409** — "O QC tem itens bloqueantes…" |
| `PUT` pauta APPROVED com QC limpo | 200 |
| Render `final` aprovado | **200** — 8 arquivos gravados |
| `GET /video` com `Range: bytes=0-1023` | **206** `bytes 0-1023/1274817` |
| `GET /thumbnail` | 200 `image/jpeg` (60 KB) |
| `GET` manifesto | 200 com o conteúdo |
| `GET /api/projects` | `hasVideo: true`, `hasThumbnail: true`, `videoSeconds: 8` |
| Id malicioso (`../../etc`) | **400** |

### 12.4 Bug encontrado e corrigido no caminho

A primeira execução gravou o pacote **sem faixa do canal e sem avatar**. Causa: o grafo montava sempre `[2:v]split=2[avsrcF][avsrcP]`, mas quando **todas** as cenas usavam o mesmo enquadramento, um dos ramos ficava sem conexão e o FFmpeg abortava com `Filter 'split' has output 0 (avsrcP) unconnected`. O `catch` de segurança então renderizava sem faixa/avatar — falha silenciosa que só apareceu porque a thumbnail foi inspecionada.

Correção: o `split` só é criado quando os dois enquadramentos existem no vídeo; com um modo só, o stream `[2:v]` é usado direto. O aviso de fallback também passou a logar só a primeira linha do erro, em vez do dump completo do FFmpeg.

### 12.5 Situação da spec

| Item da spec | Estado |
|---|---|
| §2, etapas 1–9 | ✅ concluídas |
| §2, etapa 10 (QC + arquivo) | ✅ **concluída agora** |
| §11, critérios 1–9 | ✅ (critérios 2 e 8 passaram a ser **impostos pelo servidor**) |
| §16, critérios 10–12 | ✅ avatar no MP4, composição e revisão |
| §17, critério 15 (QC de direitos/duração) | ✅ |
| **§17, critério 14 (analytics do YouTube)** | ⏸️ **fora de escopo por decisão do usuário** |

Com isso, a lista de implementação da spec está **fechada**; o que resta é o registro de desempenho, que depende de dados do YouTube.

---

## 13. Fila de render com progresso (25/11/2026)

Antes, "Gerar pacote final" prendia o botão por ~35 s (e passaria de um minuto num Short de 90 s) sem nenhum retorno. Agora o render roda em fila no servidor e a interface acompanha ao vivo.

### 13.1 Servidor (`src/server/render-jobs.ts`)

- **Um worker por vez:** render é CPU/IO pesado; paralelizar degradaria o FFmpeg.
- **Histórico de 25 jobs** em memória, com `status`, `stage`, `pct`, `message`, `elapsedSec`, `error` e `result`.
- **Progresso real do pipeline**, não tempo estimado: cada etapa reporta quando começa e quando avança (narração cena a cena, montagem segmento a segmento).
- **Cancelamento:** job na fila é cancelado na hora; job em execução recebe o pedido e a interface mostra "cancelamento solicitado" (o pipeline checa entre etapas, sem matar o FFmpeg no meio).
- **SSE** em `/api/jobs/events`, com snapshot inicial, broadcast a cada mudança e heartbeat de 15 s.

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/render` | Valida + gate + **enfileira**, devolve `202 { job }` |
| `GET` | `/api/jobs` | Lista (fila + histórico) |
| `GET` | `/api/jobs/:id` | Um job |
| `POST` | `/api/jobs/:id/cancel` | Cancela |
| `GET` | `/api/jobs/events` | SSE com a lista a cada mudança |

O endpoint síncrono antigo (`/api/export/render-mp4`) continua funcionando e compartilha a mesma validação, o mesmo gate e a mesma execução — os testes de API não precisaram ser reescritos.

### 13.2 Cliente (`src/app/services/render-queue.ts`)

- Serviço com `EventSource`, reconexão automática e **polling de 2 s como rede de segurança** se o SSE cair.
- Sinais `jobs`, `activeJob`, `activeCount`.
- A aba Estúdio e QC ganhou **cartão de progresso** (etapa, barra, mensagem, "N na fila", botão Cancelar) e o botão de render desabilita enquanto há job desta pauta.
- Um `effect` reage ao fim do job: grava `stage: RENDERED` + `render` na pauta e mostra o pacote arquivado.

### 13.3 Progresso medido (render de 62 s)

```
na fila 0 → iniciando 1 → narração 3 → 12 → 20 → 28
→ montagem 53 → 61 → 70 → avatar 76 → render 88 → arquivo 96 → concluído 100
```

13 eventos SSE, 34,5 s de ponta a ponta, 8 arquivos no pacote.

### 13.4 Dois bugs corrigidos no caminho

1. **SSE não entregava nada:** `/api/jobs/events` estava declarado depois de `/api/jobs/:id`, então `"events"` era interpretado como id e a rota respondia 404. Em produção o `EventSource` cairia no polling silenciosamente — funcionaria, mas sem tempo real. Corrigido movendo a rota para antes.
2. **Régua fora de ordem:** o avatar é montado *depois* dos segmentos, mas reportava 36% depois de a montagem chegar a 86% — a barra andaria para trás. A escala passou a ser monotônica: narração 3–28, montagem 44–70, avatar 76, render 88, arquivo 96.

### 13.5 Persistência em uso real

Enquanto a fila era implementada, três pautas criadas **na interface** já apareceram no disco (`projects/`), incluindo uma `APPROVED` — confirmando que o espelhamento do `StudioStore` para o servidor funciona fora dos testes: título, dossiê, QC e estágio sobrevivem ao navegador.

---

## 14. Foto real da matéria no lugar de imagem de acervo (25/11/2026)

O usuário pediu para usar **a foto publicada na matéria pesquisada** em vez de imagens de acervo sem relação com o fato.

### 14.1 Causa raiz de as imagens "não terem sentido"

Duas coisas somadas:

1. **O app nunca extraía a imagem da matéria.** `extractArticleMetadata` lia título, descrição, autor e trecho, mas nenhum `og:image` — então só sobrava acervo livre, que raramente tem o fato noticiado.
2. **Os portais bloqueavam o nosso User-Agent.** Teste direto na URL do UOL: UA `CanalDarkEditorial/0.1` → **403 Access Denied**; UA de navegador → **200** com título e `og:image`. Ou seja, a extração caía em `limited`, sem texto e sem imagem, e o pipeline seguia só com acervo.

### 14.2 O que foi implementado

1. **Extração da imagem**: `extractArticleImage()` lê `og:image`, `og:image:url`, `og:image:secure_url`, `twitter:image` e o `image` do JSON-LD, resolve URL relativa contra a página e captura `og:image:alt` e crédito (`credit`/`article:author`).
2. **User-Agent de navegador** centralizado em `src/server/http.ts` (`WEB_USER_AGENT`, sobrescrevível por `CANAL_DARK_USER_AGENT`), aplicado em: extração de página, feeds RSS, GDELT, Internet Archive e download de mídia. **Wikimedia mantém o UA descritivo** — a política deles exige isso.
3. **Ativo de primeira classe**: a foto vira `MediaAsset` com `provider: 'article'`, `licenseName: '© veículo (uso editorial a confirmar)'`, `attributionText` e `pageUrl` da matéria; fica em `pauta.dossier.articleMedia`.
4. **Prioridade na montagem**: `auto-fill` recebe `articleAssets` e os coloca **antes** de qualquer busca de acervo, ocupando a primeira cena (o gancho).
5. **Composição 9:16 sem cortar o rosto**: imagens paradas passam a entrar **inteiras sobre um fundo desfocado delas mesmas** (`split` + `gblur` + `overlay`), em vez de recorte direto. Foto de retrato era cortada no nariz.
6. **Transparência**: novo item de QC *"Foto da matéria (direito do veículo)"* como **aviso**, e a foto também aparece em **Mídia e Voz** com botão para anexar a qualquer cena.

### 14.3 Evidências

| Teste | Antes | Depois |
|---|---|---|
| Extração da URL do UOL | `limited`, título vazio, sem imagem | **`ok`**, título correto com acentos, `og:image` do CDN do UOL |
| Cena 1 do auto-fill | só acervo (comitê de direitos humanos) | **foto da matéria**, `provider: article` |
| Render da cena | recorte fechado no rosto | foto inteira sobre fundo desfocado |
| Download da imagem do CDN | — | HTTP 200 no render (UA de navegador) |

Amostra: `C:\CanalDark\teste-foto-materia.mp4`.

### 14.4 Aviso que fica registrado no produto

A foto da matéria é **material de terceiro**: o crédito e o link vão para o manifesto, mas o direito de uso é do veículo. O QC marca como **aviso** (não bloqueia) e o texto na interface diz isso explicitamente. Uso jornalístico com atribuição é prática comum, mas a decisão — e o risco — são do canal. Se preferir, o filtro de QC pode ser promovido a **bloqueante** com uma linha de código.

---

## 15. Filtro de virais e fontes de celebridades (25/11/2026)

### 15.1 Choquei: testada e descartada (com motivo)

O pedido era adicionar a Choquei. Teste:

| Verificação | Resultado |
|---|---|
| `choquei.com.br` | certificado TLS de **haute.one** → `ERR_TLS_CERT_ALTNAME_INVALID` |
| `www.choquei.com.br` | `*.relay.prd.lvt.services`, `/feed/` → **404** |
| `choquei.com/feed/` | 200, 10 itens, **mas o mais recente é de 31/08** (3 meses) e são posts de SEO genéricos ("Como escolher um streaming de música") |

Ou seja: o domínio antigo agora é outra plataforma e o novo é um WordPress parado. O conteúdo real da Choquei vive em X/Instagram, que o projeto **não raspa** (decisão da spec §21 e barreira técnica: exige login).

**No lugar entraram três fontes de celebridades que publicam de verdade**, testadas com item do dia:

| Fonte | Feed | Itens | Mais recente |
|---|---|---|---|
| **OFuxico** | `ofuxico.com.br/feed/` | 10 | hoje, 23:00 |
| **Capricho** | `capricho.abril.com.br/feed/` | 20 | hoje, 23:00 |
| **Terra Diversão** | `terra.com.br/diversao/rss.xml` | 10 | hoje, 22:44 |

Descartadas por estarem mortas: Hugo Gloss (certificado expirado), Em Off (DNS), Área VIP (403), Quem (DNS), Caras (403), Léo Dias (parado desde 2023), Na Telinha (0 itens), Contigo (DNS), Purepeople (404).

### 15.2 Filtro de virais

O ranking **não é opinião**: soma sinais verificáveis no próprio feed.

| Sinal | Peso |
|---|---|
| "viralizou", "bombou", "repercutiu" | 3 |
| "morre", "acidente", "internado", "câncer" | 3 |
| internautas/redes sociais/TikTok/Instagram | 2 |
| treta, detonou, alfinetou, indireta | 2 |
| flagra, assume, confessa, revela, desabafa | 2 |
| namoro, affair, termina, traição | 2 |
| influencer, famosos, BBB, sertanejo, funk | 2 |
| chocante, inacreditável, absurdo | 2 |
| **mesmo assunto em N outros veículos** | +1 a +3 |
| veículo de celebridades | +2 |
| últimas 6h / 24h | +2 / +1 |

O sinal mais forte é a **repetição entre veículos**: título repetido em 20+ portais indica assunto quente (ex.: morte do guitarrista do Duran Duran apareceu em 25 veículos). A contagem usa um índice invertido de termos, não comparação par a par.

- Endpoint: `GET /api/discovery/rss?viral=1&minViral=4`
- Cada item devolve `viralScore`, `viralReasons` e `sourceCount`, exibidos como selo 🔥 no cartão.
- **Padrão da interface: "🔥 Virais"** (era a lista completa antes); o botão "Tudo" volta ao comportamento antigo.

### 15.3 Detecção de feed parado

Um feed pode responder 200 e não publicar nada há meses — foi exatamente o caso da Choquei, e antes disso passaria silencioso como "ok". Agora a coleta compara o item mais recente com 7 dias e marca `stale`, com aviso na interface: *"Fontes sem publicação recente (respondem, mas estão paradas): g1 (g1-ciencia)"*.

### 15.4 Resultado medido

| Métrica | Antes | Depois |
|---|---|---|
| Feeds configurados | 51 | **54** |
| Feeds respondendo | 51 | **54** |
| Itens na lista | 400 (todos) | **120 virais** (nota ≥ 4) |
| Celebridades/Entretenimento nos virais | 12 | **25** |
| Fontes paradas visíveis | 0 (silencioso) | **1** (`g1-ciencia`) |

---

## 16. O apresentador sai da frente da foto, e as imagens passam a casar (25/11/2026)

Três queixas do usuário, duas causas reais.

### 16.1 "O narrador aparece em todas as cenas e as fotos não aparecem"

A inspeção da pauta renderizada mostrou: **as 6 cenas tinham foto** (todas baixando 200) e **as 6 estavam com `avatarMode: 'full'`** — ou seja, o apresentador cobria o centro da foto em todas.

**Nova regra do render** (decidida no servidor, olhando o que realmente carregou):

| Situação da cena | Apresentador |
|---|---|
| tem imagem que baixou | **não aparece** |
| não tem imagem (ou o download falhou) | **tela cheia** |
| é a última cena e tem imagem | **PiP** (fechamento) |
| `avatarMode: 'hidden'` explícito | nunca aparece |

A decisão usa `sceneVisuals[]`, preenchido durante a montagem: se o download da imagem falhar, a cena conta como "sem imagem" e o apresentador entra — o vídeo nunca fica com tela vazia.

A **prévia do app** passou a usar a mesma regra (`effectiveAvatarMode`), então o que se vê antes de renderizar é o que sai no arquivo.

### 16.2 "As fotos não fazem sentido" — a causa era o match por palavra solta

Reproduzindo o auto-fill da pauta *Duran Duran*:

| Cena | Antes | Depois |
|---|---|---|
| "Andy Taylor" | **Taylor & Kent tea set** (jogo de chá do Andy Mabbett) | `Andy Taylor - Duran Duran 1983.jpg` |
| "Duran Duran" | **Dolores Duran, 1955** / **Carolus-Duran, Mrs. Astor** (pintura) | `Duran Duran 1983.jpg` |

Duas correções:

1. **Expressão, não palavras soltas**: nome composto ("Andy Taylor", "Duran Duran") só é aceito se aparecer **como expressão** no título/descrição do ativo. Antes bastava conter cada palavra em qualquer lugar.
2. **Verbo de manchete não é nome**: "Morre Andy Taylor" deixou de virar termo de busca — 60 verbos de manchete (morre, revela, confessa, detona, posa…) são removidos do início do nome próprio, tanto no servidor quanto no cliente.

### 16.3 Transições

- **Troca de imagem**: fade de **0,18 s** no início de cada segmento (menos o primeiro, que viria de preto sem motivo).
- **Apresentador**: entra e sai com fade de **0,25 s** de alfa, por janela — nada de aparecer/sumir de estalo.

### 16.4 Evidências

| Verificação | Resultado |
|---|---|
| Render 3 cenas (foto / sem foto / foto final) | 12,5 s, 1080×1920 |
| Cena 1 (com foto) | **sem apresentador**, foto inteira sobre fundo desfocado |
| Cena 2 (sem foto) | **apresentador em tela cheia** |
| Cena 3 (última, com foto) | **apresentador em PiP** |
| Fade no corte t=5 s | brilho **21 → 29 → 37 → 39** (subindo do preto) |
| Fade no corte t=10 s | brilho **50 → 81 → 94** |
| Auto-fill "Andy Taylor" / "Duran Duran" | jogo de chá e pintura **rejeitados**; fotos certas aceitas |

Amostra: `C:\CanalDark\teste-avatar-regra.mp4`.

### 16.5 O que o usuário precisa refazer

As fotos **já anexadas** na pauta antiga continuam sendo as erradas (tea set, Dolores Duran): a correção vale para novas buscas. Basta limpar as cenas e rodar de novo "Buscar nomes citados e adicionar".

---

## 17. Botão "Refazer mídia das cenas" (25/11/2026)

Para não exigir limpeza manual cena a cena: um botão em **Mídia e Voz** descarta a mídia de todas as cenas e refaz a busca com as regras atuais.

- Store: `refillAllScenesMedia()` roda `autoFillMediaFromNames` com `replaceExisting: true` (o merge descarta o que existia) e reporta quantos ativos entraram e quantas cenas ficaram sem imagem coerente.
- A foto da matéria continua tendo prioridade (nova busca inclui `articleAssets`).
- Feedback ao final: *"Mídia refeita: N ativo(s) em M cena(s). X cena(s) ficaram sem imagem coerente e usam o cenário do estúdio."*

**Teste numa cópia da pauta do Duran Duran** (a original não foi tocada):

| Cena | Antes | Depois |
|---|---|---|
| 1 | foto da matéria | **foto da matéria** (mantida) |
| 2 | Duran Duran 1983 | **Andy Taylor – Duran Duran 1983** |
| 3 | Dolores Duran, 1955 | **Duran Duran 1983** |
| 4 | Duran duran pelo 1984 | Andy Taylor SUFC (homônimo — ver nota) |
| 5 | **Taylor & Kent tea set** | **Duran duran pelo 1984** |
| 6 | **Carolus-Duran, Mrs. Astor** | **Duran Duran 1986** |

Tempo: **1,0 s** (cache quente). 6/6 cenas com mídia; 5/6 com a imagem correta.

**Limite conhecido:** a cena 4 pegou outro "Andy Taylor" (jogador, imagem do Sheffield United). O casamento é lexical — não distingue homônimos. A foto está no acervo com o nome exato; trocar manualmente pela busca é o caminho (ou aceitar o cenário do estúdio para essa cena).

---

## 18. Publicação no YouTube (implementada em 25/11/2026)

> **Muda o escopo do produto.** A spec (§12 e critério 8) declara publicação fora do MVP. O app agora publica, **sempre com aprovação humana explícita**.

### 18.1 O que existe

| Módulo | Função |
|---|---|
| `src/server/youtube-auth.ts` | OAuth 2.0 sem SDK: consentimento, troca de código, refresh com cache, `youtubeFetch` autenticado, info do canal |
| `src/server/publish-metadata.ts` | Título/descrição/tags — base **determinística** (fontes, créditos, aviso de IA) + enriquecimento opcional por Gemini, com validação de limites |
| `src/server/youtube-upload.ts` | Upload **resumable** em chunks de 8 MB, espera de processamento, `thumbnails.set`, `captions.insert` (SRT pt-BR) |
| `src/server/youtube-insights.ts` | Analytics do vídeo e comentários/respostas/moderação |
| `src/server/publish-quota.ts` | Contabilidade de cota (dia do Pacífico, bloqueio em 90%) e limites de post |
| `src/server/publish-service.ts` | Gate + orquestração + `publish.json` + estágio `PUBLISHED` |
| `src/server/tiktok.ts` / `instagram.ts` | Adaptadores condicionados a auditoria/app review, com motivo explícito de bloqueio |
| `src/server/scheduler.ts` | Agendamento + autopilot (com `requireApproval` travado em `true`) |
| `src/app/components/publish-panel.ts` | Painel: conexão, metadados editáveis, privacidade, agendamento, resultado, desempenho e comentários |

### 18.2 Guardrails verificados

| Teste | Resultado |
|---|---|
| Publicar sem aprovação | **409** (gate lê o `project.json` no disco) |
| Publicar sem `video.mp4` | **409** "Renderize o pacote final antes" |
| YouTube sem credenciais | **409** "defina YOUTUBE_CLIENT_ID…" |
| Público com foto de veículo sem confirmação | **409** (direitos avaliados antes de conexão) |
| Título com 120 caracteres | **422** com a lista de problemas |
| Só TikTok, sem audit | job roda e falha com "Defina TIKTOK_ACCESS_TOKEN…" |
| Autopilot pedindo `requireApproval: false` | resposta mantém **`true`** |

### 18.3 Metadados gerados (medido)

- **Determinístico**: título 32/100, categoria 25 (News & Politics), 6 tags (70/500), descrição com fontes, crédito de cada mídia, ressalva de apuração, aviso de IA/avatar e hashtags.
- **Com Gemini** (3,2 s): título 58/100, **3 alternativas**, 15 tags (154/500), abertura de descrição; se falhar ou vier inválido, cai no determinístico.

### 18.4 Pré-requisitos para funcionar de verdade (ação do usuário)

1. Google Cloud: ativar **YouTube Data API v3** e criar credencial **OAuth client** com redirect `http://127.0.0.1:3000/api/youtube/auth/callback`.
2. **Cole Client ID e Secret no próprio painel** ("Configurar YouTube"): o servidor grava no `.env`, aplica em memória (sem reiniciar) e abre a autorização — `POST /api/youtube/config`.
3. Manter o app OAuth **"Em produção"** — em "Em teste" o refresh token expira em **7 dias**.
4. Canal verificado por telefone para **thumbnail personalizada**.
5. TikTok: só após o **audit** (antes disso todo post sai privado/SELF_ONLY — o app recusa).
6. Instagram: conta **profissional** + app Meta com `instagram_content_publish` + `CANAL_DARK_PUBLIC_BASE_URL` (a API baixa o vídeo de URL pública; o app roda em 127.0.0.1).

> Nenhuma credencial OAuth pode ser criada por código: o Google exige que o dono da conta crie o cliente no Console. O app removeu todo o resto do atrito (edição de arquivo, reinício, colagem de token). Para trocar de conta/projeto: `DELETE /api/youtube/config`.

### 18.5 Cota

`videos.insert` = **1.600 unidades**; thumbnail 50; legenda 400; canal 1 → **~2.050 por publicação**, ou **4–5 por dia** na cota padrão de 10.000. O app bloqueia em 9.000 e informa o horário de reset.

### 18.6 O que **não** foi testado

O envio real ao YouTube depende das credenciais acima — não há conta conectada nesta máquina. Todo o caminho até o upload (gate, metadados, fila, agendamento, autopilot, `publish.json`) foi exercitado; o `videos.insert` em si só pode ser validado pelo usuário após conectar.

**A/B de thumbnail:** não existe API. O app oferece "Trocar capa" (manual) e o teste real fica no **YouTube Studio → Test & Compare**.

---

## 20. Ritmo, gancho e dinâmica visual (implementado em 26/11/2026)

Motivo: os dois primeiros Shorts ficaram com **25–28 s de visualização média** (37–45%) e **47–50% de "stayed to watch"**. Diagnóstico medido no MP4 publicado: **6 pausas de 1,30 s** (5 entre cenas + 1 no fim) — **7,7 s de silêncio em 69,7 s (11%)**.

### 20.1 Causas encontradas

| Causa | Onde |
|---|---|
| Respiro fixo de 0,25 s por cena | `narration.ts` |
| ~1 s de silêncio que o TTS devolve nas pontas e não era aparado | idem |
| ~0,9 s de pausa **interna** no ponto final de cada frase (o TTS respira) | idem — só descoberto na medição |
| Cena nunca encolhia: `max(planned, fala + 0,25)` segurava 10 s com 8 s de fala | idem |
| Piso de 62 s distribuído como silêncio em todas as cenas | idem |
| Visual: 1 imagem por cena, Ken Burns só com zoom central, "transição" = fade de preto 0,18 s | `export-video.ts` |

### 20.2 O que mudou

**Áudio**
- `trimSilence()` apara as pontas (RMS 10 ms, margem 60 ms).
- `compressInternalSilence()` encurta pausas internas para **0,30 s** (`NARRATION_MAX_PAUSE_SEC`).
- Respiro entre cenas: **0,15 s** (`NARRATION_BREATH_SEC`).
- A cena encolhe para a fala (`max(1,2 s, fala + respiro)`).
- Sobra de piso: micro-pausas de até 0,35 s + resto no fim (o card de fechamento cobre).

**Roteiro**
- Novo modo **`rapido`** (padrão): 4 cenas, 100–125 palavras, **38–48 s**. `short` e `expanded` (piso 62 s) continuam.
- Gancho obrigatório ≤ 14 palavras, começando a primeira cena.
- `closing` vira **pergunta ao público**.

**Visual**
- Shots de ~2,8 s por cena (até 4), com **recortes virtuais** da mesma foto quando falta mídia.
- 6 variantes de câmera (zoom in/out, pan L→R, R→L, duas diagonais).
- Transições: corte seco, **zoom-punch** e **flash branco** (sem fade de preto).
- **Legenda karaokê** (ASS, palavra a palavra em âmbar) — SRT/VTT continuam no pacote.
- **Card de gancho** nos primeiros 2 s com a manchete.
- **Card de fechamento** com a pergunta + "COMENTE AQUI EMBAIXO".
- Barra de progresso âmbar e vinheta leve.

**Contrato**
- `render.json` grava `dynamics`, `cuts`, `avgShotSec`, `firstCutSec`.
- QC novo **`qc-pacing`**: palavras vs. alvo do modo e presença de pergunta no fechamento.
- Estúdio e QC: toggles de **dinâmica alta** e **legenda karaokê**.

### 20.3 Medições depois (render de validação, 4 cenas)

| Métrica | Antes | Depois |
|---|---|---|
| Maior pausa | 1,30 s | **0,31 s** |
| Total de silêncio | 7,7 s / 69,7 s | **~1,8 s / 26,1 s** (a cada 0,3 s é o limite configurado) |
| Cortes | 6 (1 por cena) | **11** |
| Shot médio | ~11,6 s | **2,38 s** |
| Primeiro corte | ~11 s | **1,49 s** |
| Duração | 69,7 s | 26,1 s (roteiro de teste) |

### 20.4 Limitações e riscos observados

- **Cota do Gemini TTS**: durante os testes a API entrou em 429 e o render caiu para o Edge no meio do vídeo (`tts: "mixed"`). O fallback funcionou; a próxima renderização volta ao Gemini quando a pausa expira.
- **Tempo de render**: ~26 s para 4 cenas/11 shots (antes ~28 s para 6 cenas/6 shots). Shots a mais não encareceram na proporção esperada.
- **Card vs. legenda**: o card de fechamento teve de ir para o topo (10%) porque a legenda ocupa a faixa inferior; o CTA passou a ser a última linha do mesmo texto para não sobrepor.
- `drawbox` não aceita `t` na largura: a barra de progresso é desenhada em passos com `enable`.

---

## 21. Modo documento: o formato "print da fonte" (implementado em 26/11/2026)

Referência analisada: um Short de 38 s do canal **Burro News**. Medições do arquivo:

| Característica | Referência |
|---|---|
| Cortes | **3** (shots de 7 a 19 s) |
| Visual | páginas/documentos com texto denso, rolagem contínua |
| Pessoa em cena | não (pele ≈ 2,7%) |
| Legenda | bloco **pequeno** no rodapé |
| Áudio | RMS **−17,6 dB**, pico −1,0 dB, com trilha de fundo |

Ou seja: o vídeo não é montagem de fotos — é **a fonte na tela**.

### 21.1 O que foi implementado

**`src/server/document-page.ts`** — "página" sintética em SVG → PNG (resvg):
- cabeçalho com o **veículo** em âmbar (domínio longo vai truncado; a data migra para o rodapé);
- manchete em Arial Bold;
- parágrafos do trecho da matéria, com **trecho destacado** (marca-texto âmbar);
- **pull quote** com barra âmbar preenchendo a sobra da folha;
- rodapé com URL e data;
- altura dinâmica (texto longo → página mais alta → rolagem).

**`export-video.ts`** — modo `videoMode: 'documento'`:
- cada cena vira uma **página com rolagem vertical** (`crop` com `y` animado por `t` — ~40 px/s);
- sem fotos, sem avatar, **sem tarja** (o cabeçalho da página já identifica o veículo);
- legenda **compacta** (FontSize 7, MarginV 22) no rodapé;
- cortes só na troca de documento.

**Áudio** — `loudnorm=I=-14:TP=-1.5:LRA=11` no passe final (padrão de Shorts).

**Contrato** — `RenderRequest.videoMode` e `sources[]`; `NarrationState.videoMode`; `render.json` grava `videoMode`.

**UI** — seletor **Formato: Fotos / Documento** no Estúdio e QC.

### 21.2 Medições do render de validação (4 cenas, 2 fontes)

| Métrica | Referência | Nosso modo documento |
|---|---|---|
| Duração | 38,3 s | 22,8 s (roteiro de teste) |
| Cortes | 3 | **3** |
| Rolagem | contínua | **confirmada** (frames de 8 s e 14 s diferentes) |
| Áudio | −17,6 dB RMS / −1,0 pico | **−13,8 dB / −1,4** |
| Pessoa em cena | não | não |

### 21.3 Limites

- O print é **sintético**, não uma captura do site: capturar a página real exigiria navegador headless, lida com paywall e layout que muda. O efeito visual é o mesmo e o texto vem do dossiê (fonte citada).
- A página usa o `excerpt` do RSS; artigos com trecho muito curto geram folha mais vazia (o pull quote mitiga).
- A **trilha de fundo** da referência não foi adicionada: você pediu sem música. Fica como fase opcional.
- O modo documento **não substitui** o de fotos: é escolha por pauta.

---

## 22. Modo cartões: tipografia cinética na identidade da Brasa (implementado em 26/11/2026)

Referência visual: Shorts de canal de notícias com **cartões tipográficos** sobre fundo escuro, cartão da matéria e faixa de fonte. A cópia é estrutural; a identidade é a da Brasa.

### 22.1 Como o frame é montado (`src/server/news-card.ts`)

1. Fundo `#0a0d12` com **brilho de brasa** (gradiente âmbar) no terço inferior.
2. **Chip do canal** no topo esquerdo, âmbar — usa `CHANNEL_LABEL` sem o sufixo.
3. **Bloco tipográfico** com até 4 elementos: `pill` âmbar (ex.: "SEGUNDO AGENDADOPODER.COM.BR"), linha fina cinza-azulada (editoria), **palavra gigante** branca (até 118 px) e `pill` de ação.
4. **Cartão da matéria**: papel `#f7f5ef`, `rx 26`, crédito do veículo, título, **trecho marcado em âmbar** e corpo.
5. **Faixa inferior**: barra preta 80%, borda âmbar, manchete em caixa alta e `FONTE · veículo · veículo`.

Todo texto é **medido antes de desenhar** (Arial Bold ≈ 0,68 em/caractere) e a fonte é reduzida até caber — nada é cortado na borda.

### 22.2 Beats e render

- `buildSceneBeats()` (determinístico): `pill` = "SEGUNDO \<veículo\>", `line` = editoria, `word` = entidade detectada, `action` = abertura da segunda frase. Cena com mais de uma frase gera **2 beats** (o segundo é só o cartão ampliado).
- Cada beat → **um segmento PNG** com duração `cena / beats`; cortes secos, sem avatar, sem tarja (o chip é a marca), sem Ken Burns.
- Legenda do transcript em estilo `cards` (menor, acima da faixa inferior).
- `render.json` grava `videoMode: 'cards'`.

### 22.3 Contrato e UI

- `videoMode: 'fotos' | 'documento' | 'cards'` no render e no `NarrationState`.
- Seletor **Formato** no Estúdio e QC com as três opções.
- `editorial` no payload vira a linha fina dos cartões.

### 22.4 Validação

- Render de 3 cenas / 17,6 s: **6 beats**, chip, cartão e faixa corretos.
- Três correções feitas no caminho: chip sem truncar no meio da frase, legenda deixando de cobrir a faixa inferior (MarginV 40) e medição de largura recalibrada (0,62 → 0,68 + letter-spacing).

### 22.5 Limites

- Cartão **sintético** a partir do trecho do dossiê — não é captura do site.
- A "ação" do pill é heurística (abertura da segunda frase); sem Gemini, pode sair genérica.
- Sem trilha sonora nesta versão.

---

## 23. Voz offline com Kokoro + console Streamlit (implementado em 26/11/2026)

Pedido: voz própria, offline, sem CUDA/PyTorch, com mistura de vozes, e uma interface local de 3 abas.

### 23.1 Ambiente verificado

| Item | Resultado |
|---|---|
| Python | 3.12.10 · pip 25.0.1 |
| `kokoro-onnx` | **0.6.1** (+ `onnxruntime` 1.32, `phonemizer`, `espeakng-loader`) |
| Modelos | `kokoro-v1.0.onnx` (310 MB) + `voices-v1.0.bin` (27 MB) na raiz |
| espeak-ng | resolvido pelo `espeakng-loader` (não precisou instalar binário) |
| Desempenho | **2,8 s** para 5,8 s de fala (~2× tempo real em CPU Ryzen) |
| Vozes pt-BR | `pm_alex`, `pf_dora`, `pm_santa` |

### 23.2 Como ficou

**Python** (`python/`): `voices.py` (mistura de vetores + config), `tts.py` (CLI texto→WAV), `voice_studio.py` (prévia/salvar), `download_models.py`, `smoke_test.py`.

**Node**: `src/server/kokoro.ts` spawna o CLI (processo separado, não prende o Express), resolve a raiz do projeto de forma robusta (o SSR pode rodar com cwd diferente) e devolve WAV 24 kHz que o pipeline reamostra para 16 kHz — igual aos outros motores.

**Motor**: `TtsEngine = 'kokoro' | 'gemini' | 'edge'`. Kokoro é o padrão quando os modelos existem (`TTS_ENGINE=kokoro`); se o Python falhar, cai no Edge sem deixar cena muda — e o motivo fica em `ttsFallback`.

**Identidade da voz**: mistura é média ponderada dos vetores de estilo (510×1×256). 70% `pm_alex` + 30% `pf_dora` → `voz_canal.npy`; preferências em `config.json`. O vetor misto fica 70% mais próximo da voz A (distância 6,4 contra 15,0), confirmando a matemática.

**Console** (`studio_app.py`, Streamlit em **http://localhost:8501**):
- **Gerar vídeo** — lista pautas, edita a narração de cada cena, salva e dispara `POST /api/studio/render/:id` (endpoint novo: monta cenas, SRT e opções do `project.json`), com barra de progresso, player e download.
- **Estúdio de voz** — duas vozes, slider de mistura e velocidade, frase de teste com prévia imediata, e botão para salvar a voz padrão.
- **Histórico** — vídeos renderizados com player/download e configuração da URL da API.

### 23.3 Prova de execução

- `smoke_test.py`: 5,78 s de áudio em 2,8 s (pt-BR, mistura 70/30).
- Render real pelo console: `engine: kokoro`, `voice: blend`, 13,03 s, áudio **−15,2 dB RMS / −1,4 dB pico**, **0 pausas ≥0,35 s**.

### 23.4 Limites

- Modelos somam ~354 MB e ficam **fora do git** (`*.onnx`, `*.bin`, `voz_canal.npy`).
- O console é uma **casca**: o render, os formatos e a publicação continuam no app Angular/Node.
- Kokoro não tem controle de estilo (âncora/urgente); o `style` do Gemini é ignorado nesse motor.





---

## 19. Voz: Gemini TTS no lugar da voz genérica (implementado em 26/11/2026)

### 19.1 O que mudou

A narração deixou de ser só Edge (`pt-BR-AntonioNeural`) e passou a ter **motor plugável**, com **Gemini TTS como padrão**, usando a mesma chave Gemini e a faixa gratuita.

| Arquivo | Mudança |
|---|---|
| `src/server/gemini.ts` | `synthesizeSpeechWithGemini()`: `responseModalities: [AUDIO]`, `speechConfig` com voz e `languageCode: pt-BR`; pausa de cota **separada** da geração de texto; cadeia de modelos TTS |
| `src/server/narration.ts` | Motores `gemini`/`edge`, catálogo `TTS_VOICES`, presets de estilo, **cache de PCM**, fallback automático e `engineUsed`/`ttsModel` no resultado |
| `src/server/export-video.ts` | `narration.engine`/`style`/`fallbackToEdge`; o resultado leva motor, voz e modelo |
| `src/server/projects.ts` | `render.json` grava `tts: { engine, voice, model }` |
| `src/server.ts` | `POST /api/tts/preview` (WAV para ouvir), `tts` em `/api/config/status`, parse do motor/estilo |
| `src/app/components/narration-voice-picker.ts` | Seletor único (motor · voz · estilo · **Ouvir amostra**) usado no QC e em Mídia e Voz |
| Modelo | `NarrationState.engine` e `.style` (opcionais: pautas antigas seguem válidas) |

### 19.2 Vozes disponíveis (Gemini)

Kore (firme, feminina) · Charon (grave, masculina) · Puck (jovem, masculina) · Aoede (leve, feminina) · Fenrir (intensa, masculina).
**Reserva:** Antonio e Francisca (Edge). Estilos: âncora · explicativo · urgente · leve · neutro.

### 19.3 Medições reais nesta máquina

| Teste | Resultado |
|---|---|
| Preview (Kore, WAV) | **10,61 s** de áudio, 24 kHz mono, gerado em **7,1 s** |
| Render E2E com Gemini | 62 s de vídeo (piso respeitado), `tts.engine=gemini`, voz Kore, `gemini-2.5-flash-preview-tts` |
| Render E2E com Edge | 62 s de vídeo, `rate=0.8` (desaceleração do piso) |
| Áudio do MP4 — Gemini | média **−24,2 dB** · pico **−1,4 dB** |
| Áudio do MP4 — Edge | média **−29,0 dB** · pico **−4,4 dB** |
| Cache de TTS | segunda síntese do mesmo texto: **0,0 s** (sem chamada à API) |
| Fallback | chave inválida → cenas caem no Edge e a faixa é gerada (nunca fica muda) |

### 19.4 Como usar

1. Aba **Estúdio e QC** (ou **Mídia e Voz**) → seção de narração.
2. Escolha motor **Gemini TTS**, a voz e o estilo.
3. Clique **Ouvir amostra** (toca a voz real, não a do navegador).
4. Renderize: o MP4 sai com essa voz; `render.json` registra motor/voz/modelo.

### 19.5 Limites conhecidos

- **Latência:** 6–20 s por cena (6 cenas ≈ 1–2 min de TTS). O render total mediu ~55 s para 2 cenas, incluindo ffmpeg.
- **Cota gratuita diária:** a API não informa o saldo; 4 chamadas seguidas passaram sem 429. Se estourar, o vídeo continua com o Edge e o job informa o motivo.
- **Sem controle de velocidade no Gemini:** o piso de 62 s é garantido por respiro distribuído (o Edge ainda usa desaceleração).
- **Estilo:** a instrução vai no prompt; se o modelo começar a lê-la em voz alta, `TTS_STYLE_INSTRUCTIONS=0` desliga.
- **Amostras para escolher:** `C:\CanalDark\amostras\amostra-gemini-*.wav` e `amostra-edge-*.wav` (mesma frase, mesmo estilo).
















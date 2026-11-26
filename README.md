# Canal Dark — estúdio de Shorts jornalísticos

Aplicativo Angular 22 + SSR (Express 5) que transforma uma notícia em **Short vertical de 1080×1920** com
narração neural, avatar sincronizado à fala, legendas, capa e **publicação automática no YouTube**.

Funciona local: nada de assinatura de vídeo, nada de nuvem. O estado de cada pauta vive em `projects/`.

---

## Requisitos

| Item | Versão / observação |
|---|---|
| **Node.js** | 22 ou superior (testado em 26) |
| **ffmpeg** | no `PATH` — obrigatório (narração, render, capa, cortes) |
| **Chave Gemini** | cota gratuita serve (`GEMINI_API_KEY`) |
| **Windows** | o projeto roda em Windows, macOS e Linux; os caminhos do `.env` são relativos |

Confira o ffmpeg antes de qualquer coisa:

```bash
ffmpeg -version
```

---

## Instalação

```bash
git clone https://github.com/brandao3901/noticias-dark.git
cd noticias-dark
npm install
cp .env.example .env      # Windows: copy .env.example .env
```

Depois edite o `.env`:

```ini
GEMINI_API_KEY=sua-chave-aqui
GEMINI_MODEL=gemini-flash-lite-latest
TTS_ENGINE=gemini
CHANNEL_LABEL=NOTÍCIAS NA BRASA · APRESENTADOR VIRTUAL
```

O `.env` **nunca** entra no git (está no `.gitignore`).

---

## Iniciar em desenvolvimento

```bash
npm run dev
```

Abre em **http://localhost:3000** com hot reload. Para expor só na máquina local:

```bash
npx ng serve --host 127.0.0.1 --port 3000
```

**No Windows, sem terminal:** dê duplo clique em **`iniciar.cmd`** (desenvolvimento) ou
**`iniciar-producao.cmd`** (compila e serve). Os dois detectam se o servidor já está no ar e, nesse caso,
apenas abrem o navegador.

## Iniciar em produção (build servido pelo Express)

```bash
npm run build     # gera dist/canal-dark
npm start         # sobe o SSR na porta 3000
```

Porta diferente: `PORT=4000 npm start`. O servidor escuta em `0.0.0.0`.

> Rode o `npm run build` **depois** de qualquer alteração — o `npm start` serve o que está em `dist/`.

## Parar / reiniciar

- Dev: `Ctrl + C` no terminal que roda o `npm run dev`.
- Porta ocupada: `npx kill-port 3000` (ou feche o processo pelo Gerenciador de Tarefas).

---

## Primeiro uso (5 minutos)

1. **Descoberta** → cole um link de notícia ou escolha uma manchete; o app extrai fontes, fotos e apuração.
2. **Dossiê** → confira fontes (RSS, GDELT, Wikimedia) e o contexto.
3. **Roteiro** → escolha a duração (**Rápido ~42 s** é o padrão, melhor retenção; *Monetizável* força 60–75 s), gere com Gemini e edite cenas.
4. **Mídia e Voz** → escolha a voz (**Gemini TTS** · Kore/Charon/Puck/Aoede), o estilo e clique **Ouvir amostra**.
5. **Estúdio e QC** → escolha o **Formato** (*Fotos* para Ken Burns, *Documento* para o print da fonte com rolagem, *Cartões* para tipografia de impacto + cartão da matéria), resolva os itens de QC, **Aprove** a pauta e clique em **Baixar vídeo 9:16 (.MP4)**.
6. **Publicar no YouTube** → conecte a conta, revise título/descrição/tags, escolha a privacidade e publique.

---

## Publicação no YouTube

### Conectar a conta (uma vez)

1. **Google Cloud** → crie um projeto e ative a **YouTube Data API v3**.
2. **Tela de consentimento** → tipo **Externo**, preencha nome/e-mail e coloque seu e-mail em **Usuários de teste**.
3. **Credenciais** → **Criar credenciais** → **ID do cliente OAuth** → tipo **Aplicativo para computador** (não pede URI)
   ou **Aplicativo da Web** com redirect `http://127.0.0.1:3000/api/youtube/auth/callback`.
4. No painel do app: cole **Client ID** e **Client Secret** → **Salvar e conectar** → aprove no Google.

### Trava de canal (importante)

O token OAuth pertence à **conta Google**, não ao canal. Se a conta tiver mais de um canal, a API pode
publicar no canal errado. Para evitar:

1. Conecte a conta dona do canal desejado (o nome aparece no painel).
2. Clique em **Fixar este canal** — a partir daí o app **recusa** publicar em qualquer outra conta/canal.
3. Cada envio confere o `channelId` que o YouTube devolve e grava em `publish.json`.

### Cota e limites

- `videos.insert` custa **1.600** unidades; com thumbnail (50) e legenda (400) cada publicação gasta ~**2.050**.
- Cota gratuita padrão: **10.000/dia** → **4 a 5 publicações**. O app bloqueia em 9.000 e avisa.
- App OAuth em **"Em teste"** expira o token em **7 dias**; use **"Publicar app"** para evitar.

---

## Onde ficam os dados

```
projects/<pautaId>/
├── project.json            # pauta completa (roteiro, fontes, QC, estágio)
├── video.mp4               # Short renderizado (1080×1920)
├── thumbnail.jpg
├── legendas.srt / .vtt
├── roteiro.txt
├── manifesto-direitos.json # fontes + licenças das mídias
├── qc-report.json
├── render.json             # duração, motor de voz, modelo
└── publish.json            # vídeo publicado, metadados, channelId
```

`projects/`, `.env` e `.youtube-token.json` são locais e não vão para o git.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | Dev server com hot reload (porta 3000) |
| `npm run build` | Build de produção em `dist/` |
| `npm start` | Serve o build (SSR/Express) |
| `npm run lint` | `tsc --noEmit` (tipos) |
| `npm test` | Vitest |

---

## Problemas comuns

| Sintoma | Causa / solução |
|---|---|
| `Fontconfig error: Cannot load default config file` | fonte ausente na renderização da tarja; o app usa `label-font.ttf` local — reinstale as fontes do sistema |
| `ffmpeg: command not found` | instale o ffmpeg e reinicie o terminal |
| `403: access_denied` ao conectar | e-mail fora de **Usuários de teste** na tela de consentimento |
| `redirect_uri_mismatch` | URI de redirecionamento não cadastrada no cliente Web |
| `invalid_client` | Client Secret errado/incompleto |
| `429` do Gemini | cota gratuita momentânea; o app pausa e cai na voz reserva (Edge) |
| Token do YouTube expira toda semana | app OAuth em "Em teste" → clique em **Publicar app** |
| Porta 3000 ocupada | `PORT=4000 npm start` ou `npx kill-port 3000` |
| Vídeo sem áudio | confira se a narração está ligada e se há cenas com texto |

---

## Estrutura

```
src/
├── app/                      # cliente Angular (zoneless, signals)
│   ├── components/           # discovery, dossier, script, media-voice, studio-qc, publish-panel…
│   ├── services/             # studio-store (estado), render-queue (SSE), speech-preview
│   └── models/               # tipos compartilhados
└── server/                   # servidor (Express + SSR)
    ├── feeds.ts research.ts  # descoberta, apuração, extração de mídia
    ├── gemini.ts             # roteiro, metadados e TTS (Gemini)
    ├── narration.ts          # Gemini TTS + Edge reserva, cache, envelope da boca
    ├── export-video.ts       # FFmpeg: Ken Burns, avatar, legendas, tarja
    ├── youtube-*.ts          # OAuth, upload resumable, analytics, comentários
    ├── publish-*.ts          # metadados, cota, serviço de publicação
    └── render-jobs.ts        # fila de jobs com progresso via SSE
```

---

## Licença e direitos de mídia

O código é do projeto. **As imagens não**: cada mídia entra com autor, licença e URL de origem no
`manifesto-direitos.json`. Fotos de matéria (`provider: article`) são material do veículo — publicar como
**público** exige confirmação explícita no painel.

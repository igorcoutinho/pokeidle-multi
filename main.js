// PokeIdle Multi — processo principal.
//
// Abre uma janela com 4 <webview>, cada uma numa partição própria (`persist:contaN`): cookies,
// localStorage e login totalmente separados, como 4 navegadores diferentes.
//
// O PokeBot entra em duas partes (mesma arquitetura da extensão):
//   - NÚCLEO (bot/core.js): injetado antes do jogo carregar, escuta o WebSocket.
//   - LÓGICA (bot/logica.js): injetada depois e TROCADA A QUENTE quando o arquivo muda no disco,
//     sem recarregar o jogo (recarregar no meio de uma hunt conta como derrota).
const { app, BrowserWindow, ipcMain, shell, dialog, session, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { spawn } = require('child_process');

const URL_JOGO = 'https://pokeidle.io/app';
// A variante do .exe (o `npm run build:lite` grava "lite" no package.json empacotado): a Lite não
// mostra os botões de PvP e Shiny. Tem outro nome de produto, então outra pasta de dados e trava.
const VARIANTE = (() => { try { return require('./package.json').variante ?? ''; } catch { return ''; } })();
const N_CONTAS = 4;

// Electron se anuncia como "Electron/x.y" no User-Agent; aqui fica igual ao Chrome da mesma
// versão, que é o navegador que ele de fato é.
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = UA;

// ------------------------------------------------------------------ a pasta do bot
// Rodando pelo código (INICIAR.bat / npm start) o bot é lido direto de ./bot do repositório:
// editar ali já chega nas 4 contas. No .exe ele fica em Documentos\PokeIdleMulti\bot, semeada
// na primeira execução com a cópia embutida e mantida em dia pelo GitHub (ver atualizarDoGitHub).
const EM_DESENVOLVIMENTO = !app.isPackaged;
const PASTA_BOT_EMBUTIDA = path.join(__dirname, 'bot');
const PASTA_BOT = EM_DESENVOLVIMENTO
  ? PASTA_BOT_EMBUTIDA
  : path.join(app.getPath('documents'), 'PokeIdleMulti', 'bot');
const URL_BOT_GITHUB = 'https://raw.githubusercontent.com/igorcoutinho/pokeidle-multi/main/bot/';
const INTERVALO_GITHUB_MS = 5 * 60 * 1000;

function semearPastaDoBot() {
  if (EM_DESENVOLVIMENTO) return;
  fs.mkdirSync(PASTA_BOT, { recursive: true });
  for (const f of ARQUIVOS_BOT) {
    const destino = path.join(PASTA_BOT, f);
    if (!fs.existsSync(destino)) fs.copyFileSync(path.join(PASTA_BOT_EMBUTIDA, f), destino);
  }
}
// core.js entra antes do jogo; o resto é a parte trocada a quente, injetada como um bloco só.
const ARQUIVOS_BOT = ['core.js', 'logica.js', 'analise.js', 'pvp.js', 'shiny.js', 'vendas.js', 'itens.js'];
const lerLogica = () => ARQUIVOS_BOT.slice(1).map(lerBot).join('\n;\n');
const lerBot = (f) => {
  try { return fs.readFileSync(path.join(PASTA_BOT, f), 'utf8'); }
  catch { return fs.readFileSync(path.join(PASTA_BOT_EMBUTIDA, f), 'utf8'); }
};

// ------------------------------------------------------------------ configuração do app
const ARQ_CFG = () => path.join(app.getPath('userData'), 'multi.json');
function lerCfg() {
  try { return JSON.parse(fs.readFileSync(ARQ_CFG(), 'utf8')); } catch { return {}; }
}
function salvarCfg(c) {
  try { fs.writeFileSync(ARQ_CFG(), JSON.stringify(c, null, 2)); } catch {}
}

let janela = null;

// No Windows, focus() numa janela minimizada não a traz de volta — precisa restaurar antes.
function trazerParaFrente(w) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// Uma instância só: abrir o .exe de novo com o app já aberto (ex.: minimizado) traz a janela de
// volta, em vez de subir uma segunda cópia brigando pelas mesmas sessões das contas.
// POKEIDLE_PERFIL=teste roda um app separado (outras sessões, outra trava) ao lado do de uso.
if (process.env.POKEIDLE_PERFIL) {
  app.setPath('userData', path.join(app.getPath('appData'), `PokeIdle Multi (${process.env.POKEIDLE_PERFIL})`));
}
const instanciaUnica = app.requestSingleInstanceLock();
if (!instanciaUnica) app.quit();
app.on('second-instance', () => { if (janela && !janela.isDestroyed()) trazerParaFrente(janela); });

function criarJanela() {
  const cfg = lerCfg();
  janela = new BrowserWindow({
    width: cfg.largura ?? 1600,
    height: cfg.altura ?? 950,
    backgroundColor: '#1d1010',
    title: 'PokeIdle Multi',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload-janela.js'),
      webviewTag: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  if (cfg.maximizada) janela.maximize();
  janela.loadFile('index.html');

  // Fechar o app = fechar as 4 abas. No meio de uma luta isso derruba o time e custa XP.
  let podeFechar = false;
  janela.on('close', (ev) => {
    const [l, a] = janela.getSize();
    salvarCfg({ ...lerCfg(), largura: l, altura: a, maximizada: janela.isMaximized() });
    if (podeFechar) return;
    const r = dialog.showMessageBoxSync(janela, {
      type: 'warning',
      buttons: ['Fechar mesmo assim', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Fechar o PokeIdle Multi?',
      message: 'Fechar desconecta as 4 contas.',
      detail: 'Se alguma estiver no meio de uma luta, o jogo trata como derrota (time ao chão e perda de XP). O ideal é levar todas ao Centro Pokémon antes.',
    });
    if (r === 0) podeFechar = true;
    else ev.preventDefault();
  });
}

// ------------------------------------------------------------------ Rotom Sniper (extensão)
// A extensão não vem no app nem no repositório (o código é do autor dela): é carregada de onde
// ela já está instalada — Documentos\PokeIdleMulti\extensoes\rotom-sniper se existir, senão a
// versão mais nova instalada no Chrome. Cada conta carrega a sua cópia, então regras, config e
// log ficam separados por conta. O Cockpit (que no Chrome abre pelo ícone) abre pelo botão 🎯.
const ID_ROTOM = 'olccbpdjdkbfgondiiaicmlifhbcggmk';
let rotom = null; // { id, versao, pasta }
const cockpits = new Map();

function acharRotom() {
  const manual = path.join(app.getPath('documents'), 'PokeIdleMulti', 'extensoes', 'rotom-sniper');
  if (fs.existsSync(path.join(manual, 'manifest.json'))) return manual;
  const dadosChrome = path.join(app.getPath('appData'), '..', 'Local', 'Google', 'Chrome', 'User Data');
  let perfis = [];
  try { perfis = fs.readdirSync(dadosChrome); } catch { return null; }
  const candidatos = [];
  for (const perfil of perfis) {
    const base = path.join(dadosChrome, perfil, 'Extensions', ID_ROTOM);
    let versoes = [];
    try { versoes = fs.readdirSync(base); } catch { continue; }
    for (const v of versoes) {
      if (fs.existsSync(path.join(base, v, 'manifest.json'))) candidatos.push({ v, pasta: path.join(base, v) });
    }
  }
  candidatos.sort((a, b) => b.v.localeCompare(a.v, undefined, { numeric: true }));
  return candidatos[0]?.pasta ?? null;
}

async function carregarRotom() {
  const pasta = acharRotom();
  if (!pasta) return;
  for (let n = 1; n <= N_CONTAS; n++) {
    const ses = session.fromPartition(`persist:conta${n}`);
    try {
      const ext = await (ses.extensions ?? ses).loadExtension(pasta);
      rotom = { id: ext.id, versao: ext.version, pasta };
    } catch (e) {
      console.warn('[PokeIdle Multi] Rotom Sniper não carregou na conta', n, e.message);
    }
  }
}

/**
 * As regras de compra do Rotom Sniper de uma conta (item → preço máximo). Elas moram no
 * `chrome.storage` da extensão, que a página do jogo não lê: abre o Cockpit escondido na partição
 * da conta, pergunta e fecha. `null` = sem Rotom.
 */
async function lerRegrasRotom(n) {
  if (!rotom) return null;
  const w = new BrowserWindow({ show: false, webPreferences: { partition: `persist:conta${n}`, contextIsolation: true, nodeIntegration: false } });
  try {
    await w.loadURL(`chrome-extension://${rotom.id}/cockpit.html`);
    return await w.webContents.executeJavaScript(
      "new Promise((r) => chrome.storage.local.get(['rotom_sniper_rules'], (x) => r(x.rotom_sniper_rules || [])))",
    );
  } catch (e) {
    console.warn('[PokeIdle Multi] regras do Rotom não lidas na conta', n, e.message);
    return null;
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
}

function abrirCockpit(n) {
  if (!rotom) return false;
  const aberta = cockpits.get(n);
  if (aberta && !aberta.isDestroyed()) { trazerParaFrente(aberta); return true; }
  const nome = lerCfg().contas?.[n - 1]?.nome ?? `Conta ${n}`;
  const w = new BrowserWindow({
    width: 1160,
    height: 760,
    title: `Rotom Sniper — ${nome}`,
    backgroundColor: '#1d1010',
    autoHideMenuBar: true,
    webPreferences: { partition: `persist:conta${n}`, contextIsolation: true, nodeIntegration: false },
  });
  w.on('page-title-updated', (ev) => ev.preventDefault());
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  w.loadURL(`chrome-extension://${rotom.id}/cockpit.html`);
  cockpits.set(n, w);
  return true;
}

// ------------------------------------------------------------------ webviews
const HOSTS_LOGIN = /(^|\.)(google\.com|discord\.com)$/;
function navegacaoPermitida(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.host === 'pokeidle.io' || HOSTS_LOGIN.test(u.hostname));
  } catch { return false; }
}

app.on('web-contents-created', (_ev, wc) => {
  if (wc.getType() !== 'webview') return;
  // Links que tentam abrir janela nova (Discord, termos…) vão para o navegador padrão.
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // O jogo segura a saída (beforeunload) quando a conta está em hunt, boss ou Arena — o Chrome
  // perguntaria "Sair do site?", mas o Electron só cancela em silêncio, e aí nem o ⟳ nem o
  // "Recarregar agora" do jogo fazem nada. Aqui a pergunta volta.
  wc.on('will-prevent-unload', (ev) => {
    const n = [...Array(N_CONTAS).keys()].map((i) => i + 1)
      .find((i) => session.fromPartition(`persist:conta${i}`) === wc.session);
    const nome = (n && lerCfg().contas?.[n - 1]?.nome) || (n ? `Conta ${n}` : 'Esta conta');
    const r = dialog.showMessageBoxSync(janela, {
      type: 'warning',
      buttons: ['Recarregar mesmo assim', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Conta fora do Centro Pokémon',
      message: `"${nome}" está caçando ou em luta.`,
      detail: 'Recarregar agora conta como derrota no jogo (time ao chão e perda de XP). O ideal é levar a conta ao Centro Pokémon antes.',
    });
    if (r === 0) ev.preventDefault(); // no Electron, preventDefault aqui = ignorar o beforeunload e seguir
  });
  // Não deixar uma conta navegar para fora do jogo por engano — exceto o login com Google/Discord,
  // que sai para o provedor e volta para o jogo com a sessão; ele precisa acontecer ali dentro.
  wc.on('will-navigate', (ev, url) => {
    if (!navegacaoPermitida(url)) { ev.preventDefault(); shell.openExternal(url); }
  });
});

// Garante o preload e os ajustes certos em toda webview, seja qual for o HTML que a criou.
app.on('web-contents-created', (_ev, wc) => {
  wc.on('will-attach-webview', (_e, prefs, params) => {
    prefs.preload = path.join(__dirname, 'preload-conta.js');
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.backgroundThrottling = false;
    if (!/^persist:conta[1-9]$/.test(params.partition ?? '')) params.partition = 'persist:conta1';
  });
});

// ------------------------------------------------------------------ IPC
ipcMain.on('pb:core', (ev) => { ev.returnValue = lerBot('core.js'); });
ipcMain.handle('pb:logica', () => lerLogica());
ipcMain.handle('multi:cfg', () => ({ ...lerCfg(), ia: iaConfig(), nContas: N_CONTAS, urlJogo: URL_JOGO, pastaBot: PASTA_BOT, rotom, variante: VARIANTE }));
ipcMain.handle('multi:iaConfig', (_e, novo) => { try { return novo ? iaSalvar(novo) : iaConfig(); } catch (e) { return { erro: e.message, ...iaConfig() }; } });
ipcMain.handle('multi:iaTestar', () => iaPerguntar({ sistema: 'Responda só JSON.', usuario: 'Responda {"ok": true, "msg": "<uma frase curta em português>"}', maxTokens: 60, timeoutMs: 20_000 }));
ipcMain.handle('pb:ia', (_e, pedido) => iaPerguntar(pedido ?? {}));
ipcMain.handle('multi:abrirCockpit', (_e, n) => abrirCockpit(n));
ipcMain.handle('multi:rotomRegras', (_e, n) => lerRegrasRotom(n));
ipcMain.handle('multi:twitchLives', (_e, lives) => abrirLivesNovas(lives));

// ---------------------------------------------------------------- agente de IA (OpenAI / Anthropic)
// A chave fica SÓ aqui no processo principal, criptografada pelo Windows (safeStorage) no
// multi.json — nunca vai para as páginas do jogo nem para o GitHub. As contas pedem uma decisão
// por `pb:ia` (via preload) e recebem só a resposta.
function iaConfig() {
  const c = lerCfg().ia ?? {};
  return { provedor: c.provedor ?? 'openai', modelo: c.modelo ?? '', temChave: !!c.chaveEnc, ligado: !!c.ligado };
}
function iaChave() {
  const enc = lerCfg().ia?.chaveEnc;
  if (!enc) return null;
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { return null; }
}
function iaSalvar({ provedor, modelo, chave, ligado, apagarChave }) {
  const cfg = lerCfg();
  const ia = { ...(cfg.ia ?? {}) };
  if (provedor) ia.provedor = provedor === 'anthropic' ? 'anthropic' : 'openai';
  if (modelo != null) ia.modelo = String(modelo).trim();
  if (ligado != null) ia.ligado = !!ligado;
  if (apagarChave) delete ia.chaveEnc;
  if (chave) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('o Windows não liberou a criptografia para guardar a chave');
    ia.chaveEnc = safeStorage.encryptString(String(chave).trim()).toString('base64');
  }
  salvarCfg({ ...cfg, ia });
  return iaConfig();
}
const MODELO_PADRAO = { openai: 'gpt-4.1-mini', anthropic: 'claude-sonnet-5-5' };

/** Uma pergunta ao modelo; devolve o JSON que ele responder. `pedido` = { sistema, usuario, maxTokens }. */
async function iaPerguntar(pedido) {
  const c = iaConfig();
  if (!c.ligado) return { ok: false, erro: 'agente desligado (🤖 Agente IA na barra de cima)' };
  const chave = iaChave();
  if (!chave) return { ok: false, erro: 'sem chave de API configurada' };
  const modelo = c.modelo || MODELO_PADRAO[c.provedor];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.min(30_000, pedido.timeoutMs ?? 15_000));
  try {
    let texto;
    if (c.provedor === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': chave, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: modelo, max_tokens: pedido.maxTokens ?? 600, system: pedido.sistema, messages: [{ role: 'user', content: pedido.usuario }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      texto = (j.content ?? []).map((b) => b.text ?? '').join('');
    } else {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${chave}` },
        body: JSON.stringify({ model: modelo, temperature: 0.3, response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: pedido.sistema }, { role: 'user', content: pedido.usuario }] }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error?.message ?? `HTTP ${r.status}`);
      texto = j.choices?.[0]?.message?.content ?? '';
    }
    const m = texto.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('a IA não respondeu em JSON');
    return { ok: true, modelo, resposta: JSON.parse(m[0]) };
  } catch (e) {
    return { ok: false, erro: e.name === 'AbortError' ? 'a IA demorou demais' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

ipcMain.handle('multi:guiaHunts', (_e, ficha) => guiaHunts(ficha).catch((e) => ({ erro: e.message })));
ipcMain.handle('multi:guiaRankingXp', (_e, nicks) => guiaRankingXp(nicks).catch((e) => ({ erro: e.message })));

// ---------------------------------------------------------------- Guia HardToCapture
// "Onde caçar": o site calcula as melhores hunts no navegador. Uma janela ESCONDIDA abre o site
// (partição própria), recebe a ficha do pokémon ativo, preenche os campos, clica em importar e
// devolve a tabela. "Ranking XP": o `xp-historico.json` público do site (XP total por jogador e
// por dia, coletado 2× ao dia) — o ganho do dia é a diferença para o dia anterior.
const URL_GUIA = 'https://guiapokeidlehardtocapture.site/';
let janelaGuia = null;
let guiaPronto = null;

function abrirGuia() {
  if (janelaGuia && !janelaGuia.isDestroyed() && guiaPronto) return guiaPronto;
  janelaGuia = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { partition: 'persist:guia', contextIsolation: true, nodeIntegration: false } });
  janelaGuia.webContents.setUserAgent(UA);
  guiaPronto = janelaGuia.loadURL(URL_GUIA).then(() => true).catch((e) => { guiaPronto = null; throw e; });
  janelaGuia.on('closed', () => { janelaGuia = null; guiaPronto = null; });
  return guiaPronto;
}

async function guiaHunts(ficha) {
  await abrirGuia();
  const js = `(async (f) => {
    const $ = (s) => document.querySelector(s);
    const espera = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 40 && !$('#in-colar'); i++) await espera(250);
    if (!$('#in-colar')) return { erro: 'o site não carregou a aba Onde caçar' };
    const txt = [f.nome, 'Nv ' + f.nivel, 'Potência P' + f.pot, 'qualidade ' + f.q.toFixed(3).replace('.', ','), f.shiny ? 'Shiny' : '',
      'STATS ATUAIS', ...['hp', 'atk', 'def', 'spAtk', 'spDef', 'speed'].map((k) => k + ' 0 IV ' + (f.ivs[k] ?? 1)), 'STATS-BASE'].join('\\n');
    $('#in-colar').value = txt;
    $('#btn-colar').click();
    await espera(300);
    // Refino e extras direto nos campos (o refino do texto dependeria da base da espécie).
    const por = (sel, v) => { const el = $(sel); if (!el) return; if (el.type === 'checkbox') el.checked = !!v; else el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
    for (const k of ['hp', 'atk', 'def', 'spAtk', 'spDef']) por('#card-pokemon [data-ref="' + k + '"]', f.refino?.[k] ?? 0);
    por('#in-tm', f.tm); por('#in-aoe', f.aoe); por('#in-vip', f.vip);
    if (f.area != null) por('#f-area', f.area);
    if (f.ordem) por('#f-ordem', f.ordem);
    if (f.min) por('#f-min', f.min);
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Onde caçar')?.click();
    await espera(1500);
    const tab = [...document.querySelectorAll('table')].find((t) => t.textContent.includes('Kills/vida'));
    const cab = [...(tab?.querySelectorAll('thead th') ?? [])].map((t) => t.textContent.trim());
    const linhas = [...(tab?.querySelectorAll('tbody tr') ?? [])].slice(0, 40).map((r) => [...r.cells].map((c) => c.textContent.trim().replace(/\\s+/g, ' ')));
    return { cab, linhas, veredito: ($('#veredito') ?? document.querySelector('[id*=veredito]'))?.textContent.trim().replace(/\\s+/g, ' ').slice(0, 400) ?? '',
      msg: $('#colar-msg')?.textContent.trim() ?? '', coleta: [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /Última coleta/.test(e.textContent))?.textContent.trim() ?? '' };
  })(${JSON.stringify(ficha)})`;
  return janelaGuia.webContents.executeJavaScript(js);
}

let xpCache = null;
async function guiaRankingXp(nicks = []) {
  if (!xpCache || Date.now() - xpCache.em > 10 * 60 * 1000) {
    const r = await fetch(new URL('xp-historico.json', URL_GUIA), { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`xp-historico.json: HTTP ${r.status}`);
    xpCache = { em: Date.now(), j: await r.json() };
  }
  const j = xpCache.j;
  const dias = Object.keys(j.dias ?? {}).sort();
  if (dias.length < 2) return { erro: 'o guia ainda não tem dois dias de coleta' };
  const meus = new Set(nicks.map((n) => String(n).toLowerCase()));
  const rankingDo = (dia, ant) => {
    const x = j.dias[dia]?.x ?? {}, xa = j.dias[ant]?.x ?? {};
    return Object.keys(x).filter((n) => n in xa).map((n) => ({ nick: n, ganho: x[n] - xa[n], total: x[n] }))
      .sort((a, b) => b.ganho - a.ganho).map((l, i) => ({ ...l, pos: i + 1 }));
  };
  const hoje = dias.at(-1), ontem = dias.at(-2);
  const rk = rankingDo(hoje, ontem);
  const totais = Object.entries(j.dias[hoje].x).sort((a, b) => b[1] - a[1]);
  const posTotal = new Map(totais.map(([n], i) => [n.toLowerCase(), i + 1]));
  // Histórico dos seus nicks: posição e ganho em cada dia.
  const historico = {};
  for (let i = 1; i < dias.length; i++) {
    const r = rankingDo(dias[i], dias[i - 1]);
    for (const l of r) if (meus.has(l.nick.toLowerCase())) (historico[l.nick] ??= []).push({ dia: dias[i], pos: l.pos, ganho: l.ganho });
  }
  return {
    dia: hoje, diaAnt: ontem, geradoEm: j.geradoEm ?? null, jogadores: rk.length,
    top: rk.slice(0, 10).map((l) => ({ ...l, posTotal: posTotal.get(l.nick.toLowerCase()) })),
    meus: rk.filter((l) => meus.has(l.nick.toLowerCase())).map((l) => ({ ...l, posTotal: posTotal.get(l.nick.toLowerCase()) })),
    historico,
  };
}


// ---------------------------------------------------------------- lives da Twitch → Chrome
// O jogo dá bônus de XP a quem assiste as lives oficiais (o vigia acha o login da Twitch no chat).
// A janela manda, a cada minuto, as lives no ar que nenhuma conta está assistindo; cada uma abre
// UMA vez no Chrome principal. Se você fechar a aba, ela só volta a abrir numa live nova (o canal
// precisa ficar 15 min fora do ar para contar como live nova).
const twitchAbertas = new Map(); // login → { abertaEm, vistaEm }
const FORA_DO_AR_MS = 15 * 60 * 1000;

function acharChrome() {
  const bases = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  for (const b of bases) {
    const exe = path.join(b, 'Google', 'Chrome', 'Application', 'chrome.exe');
    if (fs.existsSync(exe)) return exe;
  }
  return null;
}

function abrirNoChrome(url) {
  const exe = acharChrome();
  if (!exe) { shell.openExternal(url); return 'navegador padrão'; }
  spawn(exe, [url], { detached: true, stdio: 'ignore' }).unref();
  return 'Chrome';
}

function abrirLivesNovas(lives) {
  const agora = Date.now();
  const abertas = [];
  for (const l of Array.isArray(lives) ? lives : []) {
    const login = String(l?.login ?? '').toLowerCase();
    if (!/^[a-z0-9_]{2,40}$/.test(login)) continue;
    const ja = twitchAbertas.get(login);
    if (ja && agora - ja.vistaEm < FORA_DO_AR_MS) { ja.vistaEm = agora; continue; }
    const onde = abrirNoChrome(`https://www.twitch.tv/${login}`);
    twitchAbertas.set(login, { abertaEm: agora, vistaEm: agora });
    abertas.push({ login, nome: l.nome ?? login, onde });
  }
  return abertas;
}
ipcMain.handle('multi:salvar', (_e, parcial) => { salvarCfg({ ...lerCfg(), ...parcial }); return true; });
ipcMain.handle('multi:abrirPastaBot', () => shell.openPath(PASTA_BOT));
ipcMain.handle('multi:sairDaConta', async (_e, n) => {
  // Limpa só a partição daquela conta (cookies + localStorage): equivale a "deslogar" ali.
  await session.fromPartition(`persist:conta${n}`).clearStorageData();
  return true;
});

// Vigia a pasta do bot: lógica nova é empurrada para as 4 contas na hora.
function vigiarBot() {
  let espera = null;
  let ultimo = { logica: lerLogica(), core: lerBot('core.js') };
  fs.watch(PASTA_BOT, () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      const agora = { logica: lerLogica(), core: lerBot('core.js') };
      if (agora.logica !== ultimo.logica) janela?.webContents.send('pb:logicaMudou', agora.logica);
      if (agora.core !== ultimo.core) janela?.webContents.send('pb:coreMudou');
      ultimo = agora;
    }, 400);
  });
}

// No .exe: baixa core.js/logica.js do GitHub e, se mudaram, grava na pasta do bot — o vigia
// acima cuida de empurrar para as contas. Código que nem compila é descartado, e qualquer
// falha de rede só adia para a próxima rodada. Desligável com "autoAtualizar": false no multi.json.
async function atualizarDoGitHub() {
  if (lerCfg().autoAtualizar === false) return;
  for (const f of ARQUIVOS_BOT) {
    try {
      const r = await fetch(URL_BOT_GITHUB + f, { cache: 'no-store' });
      if (!r.ok) continue;
      const codigo = await r.text();
      if (!codigo.trim() || codigo === lerBot(f)) continue;
      new vm.Script(codigo, { filename: f });
      fs.writeFileSync(path.join(PASTA_BOT, f), codigo);
    } catch (e) {
      console.warn('[PokeIdle Multi] atualização do GitHub falhou para', f, e.message);
    }
  }
}

app.whenReady().then(async () => {
  if (!instanciaUnica) return;
  semearPastaDoBot();
  await carregarRotom(); // antes das webviews: o content script precisa estar lá quando o jogo abrir
  criarJanela();
  vigiarBot();
  if (!EM_DESENVOLVIMENTO) {
    atualizarDoGitHub();
    setInterval(atualizarDoGitHub, INTERVALO_GITHUB_MS);
  }
});
app.on('window-all-closed', () => app.quit());

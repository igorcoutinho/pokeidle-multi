// PokeIdle Multi — processo principal.
//
// Abre uma janela com 4 <webview>, cada uma numa partição própria (`persist:contaN`): cookies,
// localStorage e login totalmente separados, como 4 navegadores diferentes.
//
// O PokeBot entra em duas partes (mesma arquitetura da extensão):
//   - NÚCLEO (bot/core.js): injetado antes do jogo carregar, escuta o WebSocket.
//   - LÓGICA (bot/logica.js): injetada depois e TROCADA A QUENTE quando o arquivo muda no disco,
//     sem recarregar o jogo (recarregar no meio de uma hunt conta como derrota).
const { app, BrowserWindow, ipcMain, shell, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const URL_JOGO = 'https://pokeidle.io/app';
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
  for (const f of ['core.js', 'logica.js']) {
    const destino = path.join(PASTA_BOT, f);
    if (!fs.existsSync(destino)) fs.copyFileSync(path.join(PASTA_BOT_EMBUTIDA, f), destino);
  }
}
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
ipcMain.handle('pb:logica', () => lerBot('logica.js'));
ipcMain.handle('multi:cfg', () => ({ ...lerCfg(), nContas: N_CONTAS, urlJogo: URL_JOGO, pastaBot: PASTA_BOT, rotom }));
ipcMain.handle('multi:abrirCockpit', (_e, n) => abrirCockpit(n));
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
  let ultimo = { logica: lerBot('logica.js'), core: lerBot('core.js') };
  fs.watch(PASTA_BOT, () => {
    clearTimeout(espera);
    espera = setTimeout(() => {
      const agora = { logica: lerBot('logica.js'), core: lerBot('core.js') };
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
  for (const f of ['core.js', 'logica.js']) {
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

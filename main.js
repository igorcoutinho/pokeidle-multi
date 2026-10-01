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

const URL_JOGO = 'https://pokeidle.io/app';
const N_CONTAS = 4;

// Electron se anuncia como "Electron/x.y" no User-Agent; aqui fica igual ao Chrome da mesma
// versão, que é o navegador que ele de fato é.
const UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
app.userAgentFallback = UA;

// ------------------------------------------------------------------ a pasta do bot
// Fica em Documentos\PokeIdleMulti\bot — fácil de achar e de conectar ao Claude para receber
// atualizações. Na primeira execução é semeada com a cópia que vem dentro do app.
const PASTA_BOT = path.join(app.getPath('documents'), 'PokeIdleMulti', 'bot');
const PASTA_BOT_EMBUTIDA = path.join(__dirname, 'bot');

function semearPastaDoBot() {
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

// ------------------------------------------------------------------ webviews
app.on('web-contents-created', (_ev, wc) => {
  if (wc.getType() !== 'webview') return;
  // Links que tentam abrir janela nova (Discord, termos…) vão para o navegador padrão.
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Não deixar uma conta navegar para fora do jogo por engano.
  wc.on('will-navigate', (ev, url) => {
    if (!url.startsWith('https://pokeidle.io/')) { ev.preventDefault(); shell.openExternal(url); }
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
ipcMain.handle('multi:cfg', () => ({ ...lerCfg(), nContas: N_CONTAS, urlJogo: URL_JOGO, pastaBot: PASTA_BOT }));
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

app.whenReady().then(() => {
  semearPastaDoBot();
  criarJanela();
  vigiarBot();
});
app.on('window-all-closed', () => app.quit());

// Preload da janela principal: a ponte mínima entre o index.html e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multi', {
  cfg: () => ipcRenderer.invoke('multi:cfg'),
  salvar: (parcial) => ipcRenderer.invoke('multi:salvar', parcial),
  logica: () => ipcRenderer.invoke('pb:logica'),
  abrirPastaBot: () => ipcRenderer.invoke('multi:abrirPastaBot'),
  sairDaConta: (n) => ipcRenderer.invoke('multi:sairDaConta', n),
  abrirCockpit: (n) => ipcRenderer.invoke('multi:abrirCockpit', n),
  rotomRegras: (n) => ipcRenderer.invoke('multi:rotomRegras', n),
  twitchLives: (lives) => ipcRenderer.invoke('multi:twitchLives', lives),
  guiaHunts: (ficha) => ipcRenderer.invoke('multi:guiaHunts', ficha),
  iaConfig: (novo) => ipcRenderer.invoke('multi:iaConfig', novo),
  iaTestar: () => ipcRenderer.invoke('multi:iaTestar'),
  guiaRankingXp: (nicks) => ipcRenderer.invoke('multi:guiaRankingXp', nicks),
  aoMudarLogica: (fn) => ipcRenderer.on('pb:logicaMudou', (_e, codigo) => fn(codigo)),
  aoMudarCore: (fn) => ipcRenderer.on('pb:coreMudou', () => fn()),
});

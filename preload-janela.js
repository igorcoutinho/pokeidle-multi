// Preload da janela principal: a ponte mínima entre o index.html e o processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('multi', {
  cfg: () => ipcRenderer.invoke('multi:cfg'),
  salvar: (parcial) => ipcRenderer.invoke('multi:salvar', parcial),
  logica: () => ipcRenderer.invoke('pb:logica'),
  abrirPastaBot: () => ipcRenderer.invoke('multi:abrirPastaBot'),
  sairDaConta: (n) => ipcRenderer.invoke('multi:sairDaConta', n),
  aoMudarLogica: (fn) => ipcRenderer.on('pb:logicaMudou', (_e, codigo) => fn(codigo)),
  aoMudarCore: (fn) => ipcRenderer.on('pb:coreMudou', () => fn()),
});

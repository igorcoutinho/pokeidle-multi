// Preload de cada conta (roda dentro da webview, antes do jogo).
// Põe o NÚCLEO do PokeBot no contexto da página — ele precisa estar lá antes de o jogo abrir
// o WebSocket. A lógica vem depois, injetada pela janela.
const { ipcRenderer, webFrame } = require('electron');

try {
  const core = ipcRenderer.sendSync('pb:core');
  if (core) webFrame.executeJavaScript(core);
} catch (e) {
  console.error('[PokeIdle Multi] núcleo do bot não carregou', e);
}

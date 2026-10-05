// Preload de cada conta (roda dentro da webview, antes do jogo).
// Põe o NÚCLEO do PokeBot no contexto da página — ele precisa estar lá antes de o jogo abrir
// o WebSocket. A lógica vem depois, injetada pela janela.
const { ipcRenderer, webFrame } = require('electron');

// Captcha do login (Cloudflare Turnstile). O <script> da API chama `window.onTurnstilePronto`
// assim que carrega, mas quem define essa função é o app.js do jogo — um módulo grande que
// costuma chegar depois. Aí o Turnstile desiste, o widget nunca aparece e o login falha.
// Aqui a chamada fica guardada e é repassada ao jogo quando ele definir a função.
const ESPERA_TURNSTILE = `(() => {
  let apiPronta = false;
  let real = null;
  Object.defineProperty(window, 'onTurnstilePronto', {
    configurable: true,
    get() { return real ?? (() => { apiPronta = true; }); },
    set(fn) { real = fn; if (apiPronta && typeof fn === 'function') setTimeout(fn, 0); },
  });

  // Depois do login o jogo não remove o widget: cada conta ficava com um iframe do Cloudflare
  // vivo para sempre, num processo próprio de ~200-350 MB. Logou, sai. (Deslogar recarrega a
  // página, e aí o captcha volta normalmente.)
  const faxina = setInterval(() => {
    if (!window.__pokebotCore?.logado || !window.turnstile) return;
    for (const id of ['#turnstile-entrar', '#turnstile-criar', '#turnstile-esqueci']) {
      try { if (document.querySelector(id)?.childElementCount) window.turnstile.remove(id); } catch {}
    }
    clearInterval(faxina);
  }, 5000);
})();`;

try {
  webFrame.executeJavaScript(ESPERA_TURNSTILE);
} catch (e) {
  console.error('[PokeIdle Multi] ajuste do captcha não entrou', e);
}

// Ponte do agente de IA: a página pede com postMessage({ __pbIA: { id, pedido } }) e recebe
// { __pbIAResp: { id, ... } }. A chave nunca entra na página — quem chama a API é o processo principal.
window.addEventListener('message', async (ev) => {
  if (ev.source !== window || !ev.data?.__pbIA) return;
  const { id, pedido } = ev.data.__pbIA;
  let r;
  try { r = await ipcRenderer.invoke('pb:ia', pedido); } catch (e) { r = { ok: false, erro: e.message }; }
  window.postMessage({ __pbIAResp: { id, ...r } }, '*');
});

try {
  const core = ipcRenderer.sendSync('pb:core');
  if (core) webFrame.executeJavaScript(core);
} catch (e) {
  console.error('[PokeIdle Multi] núcleo do bot não carregou', e);
}

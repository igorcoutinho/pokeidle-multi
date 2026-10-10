// PokéIdle Bot — o CAÇADOR DE SHINY saiu da ferramenta.
// Este arquivo só existe para as versões antigas do app, que ainda o carregam: ele desmonta o
// caçador que estiver rodando (intervalos, ouvintes, botão e painel) e não faz mais nada.
(() => {
  'use strict';
  try { window.__pokeShiny?.desmontar?.(); } catch {}
  for (const id of ['pbsh-fundo', 'pbsh-toast', 'pbsh-estilo']) document.getElementById(id)?.remove();
  window.__pokeShiny = null;
})();

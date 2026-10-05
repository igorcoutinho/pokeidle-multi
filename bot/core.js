// PokéIdle Bot — NÚCLEO.
//
// Roda no contexto da página (world MAIN) antes do jogo carregar, e fica vivo enquanto a aba
// estiver aberta. Ele só escuta o WebSocket do jogo, remonta o estado da conta e oferece uma
// API para a LÓGICA (logica.js). A lógica pode ser trocada a quente; o núcleo não — mudar este
// arquivo exige recarregar a página (o que no meio de uma hunt conta como derrota, então ele é
// mantido pequeno e estável de propósito).
(() => {
  'use strict';
  if (window.__pokebotCore) return;

  const VERSAO_CORE = 2;

  // Mesma remontagem de `/shared/estado-delta.mjs` do jogo: chave ausente = não mudou;
  // coleção de pokémon chega por pkMud/pkFora; `cheio` recomeça do zero.
  function criarMesclador() {
    let campos = null;
    let pokemons = new Map();
    const montar = () => ({ ...campos, pokemons: [...pokemons.values()] });
    return function mesclar(parcial) {
      if (!parcial) return campos ? montar() : null;
      const { cheio, pokemons: lista, pkMud, pkFora, dexMud, dexFora, ...resto } = parcial;
      if (cheio || !campos) {
        campos = resto;
        pokemons = new Map((lista ?? []).map((k) => [k.id, k]));
        return montar();
      }
      Object.assign(campos, resto);
      if (lista) pokemons = new Map(lista.map((k) => [k.id, k]));
      for (const k of pkMud ?? []) pokemons.set(k.id, k);
      for (const id of pkFora ?? []) pokemons.delete(id);
      return montar();
    };
  }

  const core = {
    versao: VERSAO_CORE,
    eu: null,
    catalogoBolas: [],
    tabelaTipos: null,  // a grade 18×18 de efetividade do jogo (vem no welcome)
    hunts: null,        // os mapas de caça (slug, nome, nível, espécies) — também só no welcome
    itens: new Map(),
    ws: null,
    logado: false,
    log: [],            // sobrevive às trocas da lógica
    memoria: {},        // idem — a lógica guarda aqui o que não pode esquecer (ex.: última compra)
    ouvintes: new Set(),
    on(fn) { core.ouvintes.add(fn); return () => core.ouvintes.delete(fn); },
    send(obj) {
      if (!core.ws || core.ws.readyState !== 1) return false;
      core.ws.send(JSON.stringify(obj));
      return true;
    },
  };
  window.__pokebotCore = core;
  const emitir = (m) => { for (const fn of core.ouvintes) { try { fn(m); } catch (e) { console.error('[PokeBot]', e); } } };

  fetch('/assets/items.json')
    .then((r) => r.json())
    .then((j) => {
      for (const i of j.items ?? []) {
        if (core.itens.has(i.id)) continue;
        core.itens.set(i.id, i.id === 206 ? { ...i, npcPrice: 5000 } : i); // Max Revive: ajuste do jogo
      }
      emitir({ t: 'pb.itens' });
    })
    .catch(() => {});

  const Nativo = window.WebSocket;
  class WSComBot extends Nativo {
    constructor(...args) {
      super(...args);
      try {
        if (new URL(String(args[0]), location.href).host === location.host) ligar(this);
      } catch {}
    }
  }
  window.WebSocket = WSComBot;

  function ligar(sock) {
    core.ws = sock;
    core.logado = false;
    const mesclar = criarMesclador();
    sock.addEventListener('close', () => {
      if (core.ws === sock) { core.ws = null; core.logado = false; emitir({ t: 'pb.desconectou' }); }
    });
    sock.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') return;
      if (!ev.data.includes('"welcome"') && !ev.data.includes('"estado"') && !ev.data.includes('"erro"')) return;
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.t === 'welcome') {
        core.logado = true;
        core.catalogoBolas = m.catalogoBolas ?? core.catalogoBolas;
        if (m.tabelaTipos && Object.keys(m.tabelaTipos).length) core.tabelaTipos = m.tabelaTipos;
        if (Array.isArray(m.hunts)) core.hunts = m.hunts;
        if (Array.isArray(m.bossesJogaveis)) core.bossesJogaveis = m.bossesJogaveis; // a entrada de cada boss (item × qtd)
        for (const i of m.itensNossos ?? []) core.itens.set(i.id, i);
        core.eu = mesclar(m.estado);
      } else if (m.t === 'estado') {
        core.eu = mesclar(m.estado);
      }
      emitir(m);
    });
  }
})();

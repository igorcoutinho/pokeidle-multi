// PokéIdle Bot — PvP: ORDEM DOS RIVAIS e TRAVA DA FILA AUTOMÁTICA. Trocado a quente.
//
// 1) Ordem do rival. A ficha da partida que o jogo mostra traz a equipe na ordem da Pokédex —
//    o servidor esconde a ordem de entrada de propósito. Mas, quando um duelo termina, chega a
//    FITA inteira (`pvp` → `partida.replay`): os atores (cada pokémon com dono, nome, nível) e,
//    quadro a quadro, as trocas (`q.c`: o próximo entra no slot de quem caiu). Dali sai a ordem
//    em que cada lado entrou — só de quem chegou a lutar. Para fechar os 5, o app pede a ficha
//    da partida (`pvp.partida.ficha`), que traz a equipe do rival: quem não entrou completa as
//    últimas posições, marcado como "não entrou" (essa parte da ordem o servidor não revela).
//    A sua ordem completa vem da sua equipe de PvP salva (`pvp` → `time`). Histórico por conta.
//
// 2) Trava da fila. Com a fila automática ligada (`automation.pvpAutoFila`), N derrotas seguidas
//    (2 por padrão) desligam a fila com o mesmo `auto.set` que o interruptor do jogo manda. O
//    servidor só puxa a próxima partida 20 s depois do fim, então dá tempo.
(() => {
  'use strict';
  const VERSAO_PVP = '1.2.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('ppvp-fundo')?.classList.contains('aberto');
  window.__pokePvp?.desmontar?.();

  const limpezas = [];
  const P = {
    versao: VERSAO_PVP,
    get trava() { return cfg.trava; },
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokePvp = P;

  // ---------------------------------------------------------------- estado salvo (por conta)
  const CHAVE_CFG = 'pokepvp.v1';
  const CHAVE_HIST = 'pokepvp.hist.v1';
  const HIST_MAX = 300;
  const POR_PAGINA = 10;
  const TIME_PVP = 5;
  const ESPERA_FICHA_MS = 1500;

  function lerCfg() {
    const padrao = { trava: true, derrotas: 2, seguidas: 0, log: [] };
    try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; } catch { return padrao; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };
  let hist = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_HIST)) ?? []; } catch { return []; } })();
  const salvarHist = () => { try { localStorage.setItem(CHAVE_HIST, JSON.stringify(hist.slice(0, HIST_MAX))); } catch {} };
  let busca = '';
  let pagina = 0;
  let aba = 'historico';      // 'historico' | 'stats'
  const st = { porOrdem: false, minimo: 1, periodo: 'tudo' }; // filtros da aba Estatísticas
  let meuTimeIds = null; // a ordem salva da sua equipe de PvP (ids), do último `pvp` com `time`

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const quando = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const meuNick = () => String(core.eu?.nick ?? '');
  const auto = () => core.eu?.automation ?? {};

  function registrar(txt) {
    cfg.log.unshift(`${new Date().toLocaleTimeString('pt-BR')} · ${txt}`);
    cfg.log = cfg.log.slice(0, 30);
    salvarCfg();
    console.log('[PvP]', txt);
  }

  function avisar(txt) {
    let el = document.getElementById('ppvp-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'ppvp-toast';
      document.body.appendChild(el);
      limpezas.push(() => el.remove());
    }
    el.textContent = txt;
    el.style.opacity = '1';
    clearTimeout(avisar.t);
    avisar.t = setTimeout(() => (el.style.opacity = '0'), 8000);
  }

  // ---------------------------------------------------------------- a ordem, tirada da fita
  /**
   * Monta, para cada lado da fita, a sequência em que os pokémon entraram.
   * Um ator entra quando aparece pela primeira vez num quadro (passo, HP ou troca); uma troca
   * (`q.c`) põe o próximo no mesmo slot. Agrupa por dono (ou pelo lado `g`, se não houver dono).
   */
  function ladosDaFita(rep) {
    const atores = (rep?.atores ?? []).filter((a) => !a.tr);
    const primeiraVez = new Map();
    const trocas = [];
    for (const q of rep?.quadros ?? []) {
      const ver = (slot) => { if (!primeiraVez.has(slot)) primeiraVez.set(slot, q.t ?? 0); };
      for (let i = 0; q.p && i < q.p.length; i += 3) ver(q.p[i]);
      for (let i = 0; q.h && i < q.h.length; i += 2) ver(q.h[i]);
      for (const c of q.c ?? []) trocas.push({ s: c.s, t: q.t ?? 0, nome: c.n, nivel: c.nv, shiny: !!c.sh });
    }
    const lados = new Map();
    const ladoDe = (a) => {
      const chave = a.dono != null ? `d:${a.dono}` : `g:${a.g ?? 0}`;
      if (!lados.has(chave)) lados.set(chave, { dono: a.dono ?? null, g: a.g ?? 0, entradas: [] });
      return lados.get(chave);
    };
    const porSlot = new Map(atores.map((a) => [a.s, a]));
    for (const a of atores) ladoDe(a).entradas.push({ t: primeiraVez.get(a.s) ?? 0, nome: a.n, nivel: a.nv, shiny: !!a.sh });
    for (const c of trocas) {
      const a = porSlot.get(c.s);
      if (a) ladoDe(a).entradas.push({ t: c.t, nome: c.nome, nivel: c.nivel, shiny: c.shiny });
    }
    for (const l of lados.values()) {
      l.entradas.sort((x, y) => x.t - y.t);
      l.ordem = l.entradas.map(({ nome, nivel, shiny }) => ({ nome, nivel, shiny }));
    }
    return [...lados.values()];
  }

  /** Qual lado sou eu: pelo dono; senão, pelo lado com mais nomes da minha equipe. */
  function separarLados(lados, nickRival) {
    const eu = meuNick().toLowerCase();
    const rival = String(nickRival ?? '').toLowerCase();
    let meu = lados.find((l) => l.dono && String(l.dono).toLowerCase() === eu);
    let dele = lados.find((l) => l.dono && rival && String(l.dono).toLowerCase() === rival);
    if (!meu || !dele) {
      const meus = new Set((core.eu?.pokemons ?? []).map((p) => String(p.nome ?? p.nick ?? '').toLowerCase()));
      const pontos = (l) => l.ordem.filter((x) => meus.has(String(x.nome).toLowerCase())).length;
      const ordenados = [...lados].sort((a, b) => pontos(b) - pontos(a));
      meu ??= ordenados[0];
      dele ??= ordenados.find((l) => l !== meu);
    }
    return { meu: meu?.ordem ?? [], dele: dele?.ordem ?? [] };
  }

  function guardarPartida(p, fonte) {
    if (p?.id != null && hist.some((h) => h.id === p.id)) return null;
    const nick = p.oponente?.nick ?? p.oponente ?? '?';
    let ordens = { meu: [], dele: [] };
    let aviso = '';
    if (p.replay) {
      try { ordens = separarLados(ladosDaFita(p.replay), nick); }
      catch (e) { aviso = `não deu para ler a fita: ${e.message}`; }
      if (!ordens.dele.length && !aviso) aviso = 'a fita não trouxe os pokémon do rival';
    } else aviso = fonte === 'fora' ? 'partida enquanto você estava fora — sem fita' : 'sem fita';
    const minha = minhaOrdemSalva();
    const reg = {
      id: p.id ?? null, em: Date.now(), nick, venci: !!p.venci, delta: Number(p.delta) || 0,
      dele: ordens.dele, naoEntrou: [], meu: minha.length ? minha : ordens.meu, meuCompleto: minha.length > 0, aviso,
    };
    hist.unshift(reg);
    hist = hist.slice(0, HIST_MAX);
    salvarHist();
    pedirFicha(reg.id);
    return reg;
  }

  // ---------------------------------------------------------------- completar os 5
  /** A sua equipe de PvP salva, na ordem de entrada, com os nomes da bolsa. */
  function minhaOrdemSalva() {
    if (!meuTimeIds?.length) return [];
    const porId = new Map((core.eu?.pokemons ?? []).map((p) => [p.id, p]));
    return meuTimeIds.map((id) => porId.get(id)).filter(Boolean)
      .map((p) => ({ nome: p.nome, nivel: p.level, shiny: !!p.shiny })); // espécie, não apelido: é o que define a comp
  }

  /** Quem está em `todos` e não em `entrou` (por nome, respeitando repetidos). */
  function faltantes(todos, entrou) {
    const conta = new Map();
    for (const x of entrou) conta.set(x.nome, (conta.get(x.nome) ?? 0) + 1);
    return todos.filter((x) => {
      const n = conta.get(x.nome) ?? 0;
      if (n > 0) { conta.set(x.nome, n - 1); return false; }
      return true;
    });
  }

  function aplicarFicha(f) {
    const reg = hist.find((h) => h.id === Number(f.id));
    if (!reg) return;
    const equipe = (f.equipeAtual ?? []).map((pk) => ({ nome: pk.nome, nivel: pk.level ?? pk.nivel, shiny: !!pk.shiny }));
    // Sem fita (partida enquanto estava fora): pelo menos quem entrou, na ordem da Pokédex.
    if (!reg.dele.length && f.ele?.pks?.length) {
      reg.dele = f.ele.pks.map((pk) => ({ nome: pk.nome, nivel: pk.nivel, shiny: !!pk.shiny }));
      reg.deleSemOrdem = true;
    }
    reg.naoEntrou = faltantes(equipe, reg.dele).slice(0, Math.max(0, TIME_PVP - reg.dele.length));
    reg.fichaOk = true;
    salvarHist();
    pintar();
  }

  function pedirFicha(id) {
    if (id == null) return;
    setTimeout(() => core.send({ t: 'pvp.partida.ficha', id }), ESPERA_FICHA_MS);
  }

  // ---------------------------------------------------------------- trava da fila automática
  function contarResultado(reg) {
    if (reg.venci) { cfg.seguidas = 0; salvarCfg(); return; }
    cfg.seguidas = (cfg.seguidas ?? 0) + 1;
    registrar(`derrota para ${reg.nick} — ${cfg.seguidas} seguida(s)`);
    const limite = Math.max(1, Number(cfg.derrotas) || 2);
    if (cfg.trava && cfg.seguidas >= limite && auto().pvpAutoFila) {
      const nova = { ...auto(), pvpAutoFila: false };
      if (core.eu) core.eu.automation = nova;
      core.send({ t: 'auto.set', ...nova });
      registrar(`⛔ fila automática DESLIGADA após ${cfg.seguidas} derrotas seguidas`);
      avisar(`⛔ ${cfg.seguidas} derrotas seguidas no PvP — fila automática desligada`);
      cfg.seguidas = 0;
    }
    salvarCfg();
  }

  // ---------------------------------------------------------------- escuta do jogo
  function aoMensagem(ev) {
    if (typeof ev.data !== 'string' || !ev.data.includes('"t":"pvp"')) return;
    if (!/"(partida|naoVistas|ficha|time|timeSalvo)"/.test(ev.data)) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t !== 'pvp') return;
    const ids = (x) => (x ?? []).map((v) => (typeof v === 'object' ? v?.id : v)).filter((v) => v != null);
    if (m.time !== undefined) meuTimeIds = ids(m.time);
    if (m.timeSalvo !== undefined) meuTimeIds = ids(m.timeSalvo);
    // A sua ordem pode chegar depois da partida (o jogo pede `pvp.info` logo após): completa a última.
    if (meuTimeIds?.length && hist[0] && !hist[0].meuCompleto && Date.now() - hist[0].em < 60_000) {
      const minha = minhaOrdemSalva();
      if (minha.length) { hist[0].meu = minha; hist[0].meuCompleto = true; salvarHist(); }
    }
    if (m.ficha?.id != null) aplicarFicha(m.ficha);
    for (const p of m.naoVistas ?? []) {
      const reg = guardarPartida(p, 'fora');
      if (reg) contarResultado(reg);
    }
    if (m.partida) {
      const reg = guardarPartida(m.partida, 'ao vivo');
      if (reg) {
        contarResultado(reg);
        if (reg.dele.length) registrar(`${reg.venci ? 'vitória' : 'derrota'} vs ${reg.nick}: ${reg.dele.map((x) => x.nome).join(' → ')}`);
      }
    }
    pintar();
  }

  let wsOuvido = null;
  function ligarWs() {
    if (core.ws === wsOuvido) return;
    wsOuvido?.removeEventListener('message', aoMensagem);
    wsOuvido = core.ws;
    wsOuvido?.addEventListener('message', aoMensagem);
  }
  ligarWs();
  const vigia = setInterval(() => { ligarWs(); if (estaAberto()) pintarStatus(); }, 1000);
  limpezas.push(() => { clearInterval(vigia); wsOuvido?.removeEventListener('message', aoMensagem); });

  // ---------------------------------------------------------------- UI
  const CSS = `
  #ppvp-toast{position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:100003;padding:8px 14px;border-radius:10px;
    background:#2a1515;color:#ff8a8a;border:2px solid #ff8a8a;font:700 14px system-ui;box-shadow:0 6px 18px rgba(0,0,0,.5);
    transition:opacity .5s;pointer-events:none}
  #ppvp-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #ppvp-fundo.aberto{display:flex}
  #ppvp-modal{width:min(980px,96vw);max-height:92vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #ppvp-modal header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #ppvp-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #ppvp-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  #ppvp-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a}
  .ppvp-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
  .ppvp-sw{position:relative;width:44px;height:24px;border-radius:12px;background:#6a4a4a;cursor:pointer;border:none;flex:none}
  .ppvp-sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
  .ppvp-sw.on{background:#2f9a4a}.ppvp-sw.on::after{left:23px}
  .ppvp-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit}
  .ppvp-in[type=number]{width:56px}
  .ppvp-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:3px 8px;cursor:pointer;font:inherit}
  .ppvp-tab{width:100%;border-collapse:collapse;font-size:12px}
  .ppvp-tab th{text-align:left;color:#f3c77a;padding:4px 6px;font-weight:700}
  .ppvp-tab td{padding:5px 6px;border-top:1px solid #4a2a2a;vertical-align:top}
  .ppvp-v{color:#7fdc8f;font-weight:800}.ppvp-d{color:#ff8a8a;font-weight:800}
  .ppvp-ordem{display:flex;flex-wrap:wrap;gap:3px}
  .ppvp-ordem span{background:#2a1515;border-radius:5px;padding:1px 6px;white-space:nowrap}
  .ppvp-ordem b{color:#f3c77a;margin-right:3px}
  .ppvp-ordem .ppvp-fora{opacity:.6;font-style:italic}
  .ppvp-pags{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px}
  .ppvp-bt.ppvp-on{background:#b04ad0;border-color:#f3c77a;color:#fff}
  #ppvp-modal header .ppvp-x{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  .ppvp-aviso{color:#f3c77a;font-size:11px}
  .ppvp-log{font:11px ui-monospace,monospace;white-space:pre-wrap;max-height:110px;overflow:auto;background:#2a1515;border-radius:8px;padding:6px 8px;margin:0}`;

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'ppvp-fundo';
    fundo.innerHTML = '<div id="ppvp-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('input', (e) => {
      if (e.target.dataset.c === 'busca') { busca = e.target.value; pagina = 0; pintarTabela(); }
    });
    fundo.addEventListener('change', (e) => {
      if (e.target.dataset.c === 'derrotas') { cfg.derrotas = Math.max(1, Math.min(10, Number(e.target.value) || 2)); salvarCfg(); pintar(); }
      if (e.target.dataset.c === 'stMinimo') { st.minimo = Math.max(1, Math.min(50, Number(e.target.value) || 1)); pintar(); }
    });
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => { css.remove(); fundo.remove(); document.removeEventListener('keydown', aoEsc); });
  }

  const estaAberto = () => document.getElementById('ppvp-fundo')?.classList.contains('aberto');
  const pkHtml = (x) => `${x.shiny ? '✨' : ''}${esc(x.nome)}${x.nivel ? ` <small>Nv ${esc(x.nivel)}</small>` : ''}`;
  /** As 5 posições: quem entrou, na ordem; depois quem não entrou; e "?" para o que não se sabe. */
  function ordemHtml(lista, naoEntrou = [], semOrdem = false) {
    const cel = [];
    (lista ?? []).forEach((x, i) => cel.push(`<span><b>${semOrdem ? '•' : i + 1}</b>${pkHtml(x)}</span>`));
    for (const x of naoEntrou ?? []) {
      cel.push(`<span class="ppvp-fora" title="não chegou a lutar — a posição exata não é revelada"><b>${cel.length + 1}?</b>${pkHtml(x)}</span>`);
    }
    while (cel.length && cel.length < TIME_PVP) cel.push(`<span class="ppvp-fora"><b>${cel.length + 1}</b>?</span>`);
    return cel.length ? `<div class="ppvp-ordem">${cel.join('')}</div>` : '—';
  }

  // ---------------------------------------------------------------- estatísticas
  const DIAS = { tudo: null, '30d': 30, '7d': 7, hoje: 1 };
  const nomes = (lista) => (lista ?? []).map((x) => String(x.nome ?? '?'));
  /** A comp do rival: o CONJUNTO dos 5 (a ordem completa dele nem sempre é conhecida). */
  function compRival(h) {
    const n = [...nomes(h.dele), ...nomes(h.naoEntrou)];
    if (!n.length) return null;
    const ord = [...n].sort((a, b) => a.localeCompare(b));
    return { chave: ord.join(' · '), rotulo: ord.join(' · '), parcial: n.length < TIME_PVP };
  }
  /** A sua comp: pelo conjunto ou, se pedido, pela ordem exata de entrada. */
  function compMinha(h) {
    const n = nomes(h.meu);
    if (!n.length) return null;
    const rotulo = st.porOrdem ? n.join(' → ') : [...n].sort((a, b) => a.localeCompare(b)).join(' · ');
    return { chave: rotulo, rotulo, parcial: n.length < TIME_PVP };
  }

  function estatisticas() {
    const dias = DIAS[st.periodo];
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    const desde = dias ? hoje.getTime() - (dias - 1) * 24 * 3600 * 1000 : 0;
    const duelos = hist.filter((h) => h.em >= desde);
    const minhas = new Map(), rivais = new Map(), meusPk = new Map(), delesPk = new Map();
    const soma = (mapa, chave, base) => { const r = mapa.get(chave) ?? { ...base, n: 0, v: 0, delta: 0, x: new Map() }; mapa.set(chave, r); return r; };
    const somaX = (r, chave, rotulo, venci) => { const x = r.x.get(chave) ?? { rotulo, n: 0, v: 0 }; x.n++; if (venci) x.v++; r.x.set(chave, x); };
    for (const h of duelos) {
      const cm = compMinha(h), cr = compRival(h);
      if (cm) {
        const r = soma(minhas, cm.chave, { rotulo: cm.rotulo, parcial: cm.parcial });
        r.n++; if (h.venci) r.v++; r.delta += h.delta || 0;
        if (cr) somaX(r, cr.chave, cr.rotulo, h.venci);
      }
      if (cr) {
        const r = soma(rivais, cr.chave, { rotulo: cr.rotulo, parcial: cr.parcial, nicks: new Set() });
        r.n++; if (h.venci) r.v++; r.delta += h.delta || 0; r.nicks.add(h.nick);
        if (cm) somaX(r, cm.chave, cm.rotulo, h.venci);
      }
      for (const n of new Set(nomes(h.meu))) { const p = meusPk.get(n) ?? { n: 0, v: 0 }; p.n++; if (h.venci) p.v++; meusPk.set(n, p); }
      for (const n of new Set([...nomes(h.dele), ...nomes(h.naoEntrou)])) { const p = delesPk.get(n) ?? { n: 0, v: 0 }; p.n++; if (h.venci) p.v++; delesPk.set(n, p); }
    }
    return { duelos, minhas, rivais, meusPk, delesPk };
  }

  const pct = (v, n) => (n ? Math.round((v / n) * 100) : 0);
  const pctHtml = (v, n) => { const p = pct(v, n); return `<b class="${p >= 60 ? 'ppvp-v' : p < 45 ? 'ppvp-d' : ''}">${p}%</b>`; };
  /** O melhor e o pior confronto de uma comp (por % de vitória; empate decide quem tem mais jogos). */
  function extremos(x) {
    const lista = [...x.values()];
    if (!lista.length) return { melhor: null, pior: null };
    const ord = [...lista].sort((a, b) => pct(b.v, b.n) - pct(a.v, a.n) || b.n - a.n);
    return { melhor: ord[0], pior: ord.length > 1 ? ord[ord.length - 1] : null };
  }
  const confronto = (c) => (c ? `${esc(c.rotulo)} <small>(${c.v}V ${c.n - c.v}D)</small>` : '—');

  function htmlStats() {
    const s = estatisticas();
    const ordenar = (m) => [...m.values()].filter((r) => r.n >= st.minimo).sort((a, b) => b.n - a.n || pct(b.v, b.n) - pct(a.v, a.n));
    const minhas = ordenar(s.minhas), rivais = ordenar(s.rivais);
    const v = s.duelos.filter((h) => h.venci).length;
    const tabMinhas = minhas.map((r) => { const e = extremos(r.x); return `<tr>
        <td style="white-space:normal"><b>${esc(r.rotulo)}</b>${r.parcial ? ' <small class="ppvp-aviso">(incompleta)</small>' : ''}</td>
        <td>${r.n}</td><td><span class="ppvp-v">${r.v}</span>-<span class="ppvp-d">${r.n - r.v}</span></td><td>${pctHtml(r.v, r.n)}</td>
        <td class="${r.delta >= 0 ? 'ppvp-v' : 'ppvp-d'}">${r.delta >= 0 ? '+' : ''}${r.delta}</td>
        <td style="white-space:normal">${confronto(e.melhor)}</td><td style="white-space:normal">${confronto(e.pior)}</td></tr>`; }).join('');
    const tabRivais = rivais.map((r) => { const e = extremos(r.x); return `<tr>
        <td style="white-space:normal"><b>${esc(r.rotulo)}</b>${r.parcial ? ' <small class="ppvp-aviso">(incompleta)</small>' : ''}<br><small>${[...r.nicks].slice(0, 4).map(esc).join(', ')}${r.nicks.size > 4 ? '…' : ''}</small></td>
        <td>${r.n}</td><td><span class="ppvp-v">${r.v}</span>-<span class="ppvp-d">${r.n - r.v}</span></td><td>${pctHtml(r.v, r.n)}</td>
        <td style="white-space:normal">${confronto(e.melhor)}</td></tr>`; }).join('');
    const pks = (m, titulo, dica, ordem) => {
      const lista = [...m.entries()].filter(([, p]) => p.n >= st.minimo).sort(ordem).slice(0, 15);
      return `<div style="flex:1;min-width:260px"><h4>${titulo} <span class="ppvp-aviso" style="text-transform:none">${dica}</span></h4>
        ${lista.length ? `<table class="ppvp-tab"><tr><th>Pokémon</th><th>Duelos</th><th>Sua % de vitória</th></tr>
          ${lista.map(([n, p]) => `<tr><td><b>${esc(n)}</b></td><td>${p.n}</td><td>${pctHtml(p.v, p.n)} <small>(${p.v}V ${p.n - p.v}D)</small></td></tr>`).join('')}</table>`
          : '<span class="ppvp-aviso">Sem dados.</span>'}</div>`;
    };
    return `
      <section>
        <div class="ppvp-linha">
          <b style="color:#f3c77a;font-size:11px;text-transform:uppercase">Período</b>
          ${Object.entries({ tudo: 'Tudo', '30d': '30 dias', '7d': '7 dias', hoje: 'Hoje' }).map(([k, n]) => `<button class="ppvp-bt ${st.periodo === k ? 'ppvp-on' : ''}" data-a="stPeriodo" data-v="${k}">${n}</button>`).join('')}
          <span style="width:12px"></span>
          <label><input type="checkbox" data-a="stOrdem" ${st.porOrdem ? 'checked' : ''}> separar suas comps pela ordem de entrada</label>
          <span style="width:12px"></span>
          mínimo de duelos: <input type="number" class="ppvp-in" data-c="stMinimo" min="1" max="50" value="${st.minimo}">
        </div>
        <div class="ppvp-linha"><b>${s.duelos.length}</b> duelos no período · <span class="ppvp-v">${v}V</span> <span class="ppvp-d">${s.duelos.length - v}D</span> · ${pctHtml(v, s.duelos.length)} de vitória</div>
      </section>
      <section>
        <h4>Suas composições</h4>
        ${tabMinhas ? `<table class="ppvp-tab"><tr><th>Comp</th><th>Duelos</th><th>V-D</th><th>%</th><th>Pontos</th><th>Vai melhor contra</th><th>Vai pior contra</th></tr>${tabMinhas}</table>`
          : '<span class="ppvp-aviso">Sem duelos com a sua comp registrada ainda.</span>'}
      </section>
      <section>
        <h4>Composições rivais</h4>
        ${tabRivais ? `<table class="ppvp-tab"><tr><th>Comp do rival</th><th>Enfrentou</th><th>Sua V-D</th><th>%</th><th>Sua comp que mais vence ela</th></tr>${tabRivais}</table>`
          : '<span class="ppvp-aviso">Sem comps rivais registradas ainda.</span>'}
      </section>
      <section class="ppvp-linha" style="align-items:flex-start;gap:16px">
        ${pks(s.meusPk, 'Seus pokémon', 'sua % de vitória quando ele está no time', (a, b) => pct(b[1].v, b[1].n) - pct(a[1].v, a[1].n) || b[1].n - a[1].n)}
        ${pks(s.delesPk, 'Pokémon rivais que mais te derrotam', 'sua % de vitória quando ele está no time do rival', (a, b) => pct(a[1].v, a[1].n) - pct(b[1].v, b[1].n) || b[1].n - a[1].n)}
      </section>`;
  }

  function pintar() {
    const modal = document.getElementById('ppvp-modal');
    if (!modal || !estaAberto()) return;
    const abas = `<span class="ppvp-linha" style="margin:0">
        <button class="ppvp-bt ${aba === 'historico' ? 'ppvp-on' : ''}" data-a="aba" data-v="historico">Histórico</button>
        <button class="ppvp-bt ${aba === 'stats' ? 'ppvp-on' : ''}" data-a="aba" data-v="stats">Estatísticas</button>
        <button class="ppvp-x" data-a="fechar" title="Fechar">×</button></span>`;
    if (aba === 'stats') {
      modal.innerHTML = `<header><span>⚔ PvP — estatísticas<small>v${VERSAO_PVP}</small></span>${abas}</header>${htmlStats()}`;
      return;
    }
    modal.innerHTML = `
      <header><span>⚔ PvP — ordem dos rivais<small>v${VERSAO_PVP}</small></span>${abas}</header>
      <section>
        <div class="ppvp-linha">
          <button class="ppvp-sw ${cfg.trava ? 'on' : ''}" data-a="trava"></button>
          <b>Desligar a fila automática depois de</b>
          <input type="number" class="ppvp-in" data-c="derrotas" min="1" max="10" value="${esc(cfg.derrotas)}">
          <b>derrotas seguidas</b>
        </div>
        <p id="ppvp-status" style="margin:4px 0 0"></p>
      </section>
      <section>
        <h4>Histórico de duelos</h4>
        <div class="ppvp-linha">
          <input class="ppvp-in" data-c="busca" placeholder="filtrar por nick…" value="${esc(busca)}" spellcheck="false" style="width:220px">
          <span class="ppvp-aviso">Números = ordem real de entrada (da fita). "4?" = não chegou a lutar: está na equipe, mas a posição não é revelada.</span>
          <span style="flex:1"></span>
          ${hist.length ? '<button class="ppvp-bt" data-a="limpar">limpar histórico</button>' : ''}
        </div>
        <div id="ppvp-tabela"></div>
      </section>
      <section>
        <h4>Registro</h4>
        <pre class="ppvp-log">${esc(cfg.log.join('\n') || 'Nada ainda.')}</pre>
      </section>`;
    pintarTabela();
    pintarStatus();
  }

  function pintarTabela() {
    const host = document.getElementById('ppvp-tabela');
    if (!host) return;
    const q = busca.trim().toLowerCase();
    const todas = hist.filter((h) => !q || String(h.nick).toLowerCase().includes(q));
    const paginas = Math.max(1, Math.ceil(todas.length / POR_PAGINA));
    pagina = Math.min(pagina, paginas - 1);
    const linhas = todas.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
    host.innerHTML = linhas.length
      ? `<table class="ppvp-tab"><tr><th>Quando</th><th>Rival</th><th></th><th>Ordem do rival</th><th>Sua ordem</th></tr>
        ${linhas.map((h) => `<tr>
          <td>${quando(h.em)}</td>
          <td><b>${esc(h.nick)}</b></td>
          <td class="${h.venci ? 'ppvp-v' : 'ppvp-d'}">${h.venci ? 'V' : 'D'} <small>${h.delta >= 0 ? '+' : ''}${h.delta}</small></td>
          <td>${ordemHtml(h.dele, h.naoEntrou, h.deleSemOrdem)}${h.deleSemOrdem ? '<div class="ppvp-aviso">sem fita: quem entrou, fora de ordem</div>' : h.aviso ? `<div class="ppvp-aviso">${esc(h.aviso)}</div>` : ''}</td>
          <td>${ordemHtml(h.meu)}</td></tr>`).join('')}</table>
        ${paginas > 1 ? `<div class="ppvp-pags">
          <button class="ppvp-bt" data-a="pag" data-v="-1" ${pagina === 0 ? 'disabled' : ''}>‹</button>
          <span>página ${pagina + 1} de ${paginas} · ${todas.length} duelos</span>
          <button class="ppvp-bt" data-a="pag" data-v="1" ${pagina >= paginas - 1 ? 'disabled' : ''}>›</button></div>` : ''}`
      : '<span class="ppvp-aviso">Nenhum duelo registrado ainda — os próximos entram aqui sozinhos.</span>';
  }

  function pintarStatus() {
    const el = document.getElementById('ppvp-status');
    if (!el) return;
    el.innerHTML = [
      `Fila automática do jogo: <b>${auto().pvpAutoFila ? 'ligada' : 'desligada'}</b>`,
      `derrotas seguidas agora: <b>${cfg.seguidas ?? 0}</b>`,
      cfg.trava ? `desliga ao chegar em <b>${cfg.derrotas}</b>` : '<span class="ppvp-aviso">trava desligada</span>',
    ].join(' · ');
  }

  function aoClicar(e) {
    if (e.target.id === 'ppvp-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'fechar') return fechar();
    if (a === 'trava') { cfg.trava = !cfg.trava; registrar(cfg.trava ? 'trava da fila ligada' : 'trava da fila desligada'); }
    else if (a === 'limpar') { hist = []; salvarHist(); }
    else if (a === 'pag') { pagina = Math.max(0, pagina + Number(b.dataset.v)); return pintarTabela(); }
    else if (a === 'aba') aba = b.dataset.v;
    else if (a === 'stPeriodo') st.periodo = b.dataset.v;
    else if (a === 'stOrdem') st.porOrdem = b.checked;
    salvarCfg();
    pintar();
  }

  function abrir() {
    document.getElementById('ppvp-fundo').classList.add('aberto');
    if (!meuTimeIds) core.send({ t: 'pvp.info' });
    pintar();
  }
  function fechar() { document.getElementById('ppvp-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

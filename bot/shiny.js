// PokéIdle Bot — CAÇADOR DE SHINY. Trocado a quente junto com a lógica.
//
// Grava os selvagens que aparecem no mapa (pelas mensagens `campo`: cada bicho vem com nome,
// nível e `sh` = shiny) e, quando um SHINY cai, arremessa a bola escolhida (Great Ball por
// padrão) no corpo dele com `ball.throw` — o mesmo pedido do painel "caídos" do jogo — até
// capturar, ele fugir, o corpo sumir (30 s no chão) ou acabar a bola.
//
// Precisa da cena: no Modo Economia o servidor não manda `campo`, e não há como saber quem é
// shiny. A rotação de mapas espera enquanto há um shiny no chão (`ocupado`).
(() => {
  'use strict';
  const VERSAO_SHINY = '1.0.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pbsh-fundo')?.classList.contains('aberto');
  window.__pokeShiny?.desmontar?.();

  const limpezas = [];
  const S = {
    versao: VERSAO_SHINY,
    get ativo() { return cfg.ativo; },
    /** Há shiny no chão sendo capturado — a rotação de mapas espera. */
    get ocupado() { return cfg.ativo && alvos.size > 0; },
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokeShiny = S;

  // ---------------------------------------------------------------- constantes
  const CHAVE_CFG = 'pokeshiny.v1';
  const CHAVE_HIST = 'pokeshiny.hist.v1';
  const TEMPO_CHAO_MS = 30_000;    // o corpo fica 30 s no chão (TEMPO_CHAO_MS do jogo)
  const PAUSA_ENTRE_MS = 600;      // entre um arremesso e o próximo
  const SEM_RESPOSTA_MS = 3000;    // sem evento `bola` nesse tempo, tenta de novo
  const HIST_MAX = 200;

  function lerCfg() {
    const padrao = { ativo: false, bola: 'Great Ball', reserva: 'Ultra Ball', maxBolas: 0, aviso: true };
    try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; } catch { return padrao; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };
  let hist = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_HIST)) ?? []; } catch { return []; } })();
  const salvarHist = () => { try { localStorage.setItem(CHAVE_HIST, JSON.stringify(hist.slice(0, HIST_MAX))); } catch {} };

  // Os selvagens do mapa e a contagem do que já apareceu (sobrevivem à troca a quente).
  const mem = (core.memoria.shiny ??= { mobs: new Map(), vistos: new Map(), mapa: null, ultimoCampo: 0 });
  const alvos = new Map(); // slot -> { nome, nivel, desde, tentativas, aguardando, registro }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hora = (ms = Date.now()) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const nomeBola = (b) => b?.nome ?? b?.name ?? '';
  const idBola = (nome) => (core.catalogoBolas ?? []).find((b) => nomeBola(b) === nome)?.id ?? null;
  const qtd = (id) => Number(core.eu?.balls?.[id] ?? 0);
  /** A bola da vez: a escolhida, ou a reserva se a escolhida acabou. */
  function bolaDaVez() {
    for (const nome of [cfg.bola, cfg.reserva]) {
      const id = idBola(nome);
      if (id != null && qtd(id) > 0) return { id, nome };
    }
    return null;
  }

  function avisar(txt) {
    if (!cfg.aviso) return;
    let el = document.getElementById('pbsh-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pbsh-toast';
      document.body.appendChild(el);
      limpezas.push(() => el.remove());
    }
    el.textContent = txt;
    el.style.opacity = '1';
    clearTimeout(avisar.t);
    avisar.t = setTimeout(() => (el.style.opacity = '0'), 6000);
  }

  function registrarHist(reg) {
    hist.unshift(reg);
    hist = hist.slice(0, HIST_MAX);
    salvarHist();
    pintar();
  }

  // ---------------------------------------------------------------- captura
  function arremessar(slot) {
    const a = alvos.get(slot);
    if (!a || !cfg.ativo) return;
    if (Date.now() - a.desde > TEMPO_CHAO_MS) return encerrar(slot, 'sumiu do chão');
    if (cfg.maxBolas > 0 && a.tentativas >= cfg.maxBolas) return encerrar(slot, `parou após ${a.tentativas} bolas`);
    const bola = bolaDaVez();
    if (!bola) return encerrar(slot, `sem ${cfg.bola}${cfg.reserva ? ` nem ${cfg.reserva}` : ''}`);
    if (!core.send({ t: 'ball.throw', ballId: bola.id, slot })) return;
    a.tentativas++;
    a.registro.bolas = a.tentativas;
    a.registro.bola = bola.nome;
    a.aguardando = setTimeout(() => arremessar(slot), SEM_RESPOSTA_MS);
    pintar();
  }

  function encerrar(slot, resultado) {
    const a = alvos.get(slot);
    if (!a) return;
    clearTimeout(a.aguardando);
    alvos.delete(slot);
    a.registro.resultado = resultado;
    salvarHist();
    avisar(`✨ ${a.nome}: ${resultado}`);
    pintar();
  }

  function shinyCaiu(slot, m) {
    if (alvos.has(slot)) return;
    const registro = { em: Date.now(), mapa: core.eu?.huntSlug ?? '', nome: m.nome, nivel: m.nivel, resultado: 'capturando…', bolas: 0, bola: '' };
    registrarHist(registro);
    if (!cfg.ativo) { registro.resultado = 'caçador desligado'; salvarHist(); return; }
    alvos.set(slot, { nome: m.nome, nivel: m.nivel, desde: Date.now(), tentativas: 0, aguardando: null, registro });
    avisar(`✨ Shiny caído: ${m.nome} Nv ${m.nivel} — arremessando ${cfg.bola}!`);
    arremessar(slot);
  }

  // ---------------------------------------------------------------- escuta do jogo
  function contarVisto(m) {
    const k = m.nome ?? '?';
    const v = mem.vistos.get(k) ?? { nome: k, total: 0, shiny: 0 };
    v.total++;
    if (m.shiny) v.shiny++;
    mem.vistos.set(k, v);
  }

  function aplicarMob(b, novo) {
    let m = mem.mobs.get(b.s);
    const nasceu = !m || novo;
    if (!m) { m = { nome: '?', nivel: 0, shiny: false, morto: false }; mem.mobs.set(b.s, m); }
    const eraMorto = m.morto;
    if (b.n !== undefined) m.nome = b.n;
    if (b.nv !== undefined) m.nivel = b.nv;
    if (b.sh !== undefined) m.shiny = !!b.sh;
    if (b.x !== undefined) m.morto = !!b.x;
    if (b.tr || b.dn !== undefined || b.tn !== undefined) m.ignorar = true; // treinador/boneco, não selvagem
    if (!core.eu?.huntSlug || core.eu.noCentro) m.ignorar = true;          // Centro, PvP: não são selvagens
    if (m.ignorar) return;
    if (nasceu || (eraMorto && !m.morto)) {
      contarVisto(m);
      if (m.shiny && !m.morto) avisar(`✨ SHINY no mapa: ${m.nome} Nv ${m.nivel}!`);
    }
    if (m.shiny && m.morto && !eraMorto) shinyCaiu(b.s, m);
  }

  function aoMensagem(ev) {
    if (typeof ev.data !== 'string') return;
    const d = ev.data;
    if (!d.includes('"t":"campo') && !d.includes('"t":"batalha"')) return;
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'campo.init') {
      for (const slot of alvos.keys()) encerrar(slot, 'mudou de mapa');
      mem.mobs.clear();
      if (mem.mapa !== core.eu?.huntSlug) { mem.vistos.clear(); mem.mapa = core.eu?.huntSlug ?? null; }
      for (const b of m.mobs ?? []) aplicarMob(b, true);
      mem.ultimoCampo = Date.now();
      pintar();
    } else if (m.t === 'campo') {
      for (const b of m.mobs ?? []) aplicarMob(b, false);
      for (const s of m.fora ?? []) {
        mem.mobs.delete(s);
        if (alvos.has(s)) encerrar(s, 'sumiu do chão');
      }
      mem.ultimoCampo = Date.now();
    } else if (m.t === 'batalha') {
      for (const e of m.ev ?? []) {
        if (e.k === 'bola' && alvos.has(e.slot)) {
          const a = alvos.get(e.slot);
          clearTimeout(a.aguardando);
          if (e.sucesso) encerrar(e.slot, `capturado com ${a.registro.bola} (${a.tentativas} bola${a.tentativas > 1 ? 's' : ''})`);
          else a.aguardando = setTimeout(() => arremessar(e.slot), PAUSA_ENTRE_MS);
        } else if (e.k === 'fugiu') {
          for (const [slot, a] of alvos) if (a.nome === e.nome) encerrar(slot, `fugiu após ${a.tentativas} bola(s)`);
        }
      }
    }
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
  limpezas.push(() => {
    clearInterval(vigia);
    for (const a of alvos.values()) clearTimeout(a.aguardando);
    wsOuvido?.removeEventListener('message', aoMensagem);
  });

  // ---------------------------------------------------------------- UI
  const CSS = `
  #pbsh-toast{position:fixed;left:50%;top:70px;transform:translateX(-50%);z-index:100003;padding:8px 14px;border-radius:10px;
    background:#2a1515;color:#ffd166;border:2px solid #ffd166;font:700 14px system-ui;box-shadow:0 6px 18px rgba(0,0,0,.5);
    transition:opacity .5s;pointer-events:none}
  #pbsh-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #pbsh-fundo.aberto{display:flex}
  #pbsh-modal{width:min(820px,96vw);max-height:92vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pbsh-modal header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pbsh-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pbsh-modal header button{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pbsh-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  #pbsh-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a}
  .pbsh-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
  .pbsh-sw{position:relative;width:44px;height:24px;border-radius:12px;background:#6a4a4a;cursor:pointer;border:none;flex:none}
  .pbsh-sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
  .pbsh-sw.on{background:#2f9a4a}.pbsh-sw.on::after{left:23px}
  .pbsh-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit}
  .pbsh-in[type=number]{width:60px}
  .pbsh-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pbsh-tab{width:100%;border-collapse:collapse;font-size:12px}
  .pbsh-tab th{text-align:left;color:#f3c77a;padding:4px 6px;font-weight:700}
  .pbsh-tab td{padding:4px 6px;border-top:1px solid #4a2a2a}
  .pbsh-sh{color:#ffd166;font-weight:700}.pbsh-ok{color:#7fdc8f}.pbsh-ruim{color:#ff8a8a}.pbsh-aviso{color:#f3c77a}
  .pbsh-vistos{display:flex;flex-wrap:wrap;gap:4px}
  .pbsh-vistos span{background:#2a1515;border-radius:6px;padding:2px 8px;font-size:12px}`;

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pbsh-fundo';
    fundo.innerHTML = '<div id="pbsh-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('change', (e) => {
      const c = e.target.dataset.c;
      if (!c) return;
      cfg[c] = c === 'maxBolas' ? Math.max(0, Number(e.target.value) || 0) : e.target.value;
      salvarCfg();
      pintar();
    });
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => { css.remove(); fundo.remove(); document.removeEventListener('keydown', aoEsc); });
  }

  const estaAberto = () => document.getElementById('pbsh-fundo')?.classList.contains('aberto');

  function opcoesBola(sel, comNenhuma) {
    const bolas = (core.catalogoBolas ?? []).map(nomeBola).filter(Boolean);
    if (sel && !bolas.includes(sel)) bolas.unshift(sel);
    return (comNenhuma ? ['<option value="">nenhuma</option>'] : [])
      .concat(bolas.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`)).join('');
  }

  function pintar() {
    const modal = document.getElementById('pbsh-modal');
    if (!modal || !estaAberto()) return;
    const vistos = [...mem.vistos.values()].sort((a, b) => b.shiny - a.shiny || b.total - a.total);
    modal.innerHTML = `
      <header><span>✨ Caçador de shiny<small>v${VERSAO_SHINY}</small></span><button data-a="fechar" title="Fechar">×</button></header>
      <section>
        <div class="pbsh-linha">
          <button class="pbsh-sw ${cfg.ativo ? 'on' : ''}" data-a="ativo"></button>
          <b>${cfg.ativo ? 'Ligado: arremessa quando um shiny cair' : 'Desligado (só registra)'}</b>
        </div>
        <div class="pbsh-linha">
          Bola: <select class="pbsh-in" data-c="bola">${opcoesBola(cfg.bola, false)}</select>
          se acabar, usar: <select class="pbsh-in" data-c="reserva">${opcoesBola(cfg.reserva, true)}</select>
          · máximo de bolas por shiny: <input type="number" class="pbsh-in" data-c="maxBolas" min="0" value="${esc(cfg.maxBolas)}"> <small>(0 = até capturar)</small>
        </div>
        <div class="pbsh-linha">
          <label><input type="checkbox" data-a="aviso" ${cfg.aviso ? 'checked' : ''}> avisar na tela quando aparecer/cair um shiny</label>
        </div>
        <p id="pbsh-status" style="margin:4px 0 0"></p>
      </section>
      <section>
        <h4>Bichos vistos neste mapa</h4>
        <div class="pbsh-vistos">${vistos.map((v) => `<span>${v.shiny ? `<span class="pbsh-sh">✨${v.shiny}</span> · ` : ''}${esc(v.nome)} ×${v.total}</span>`).join('') || '<span class="pbsh-aviso">Nada ainda — os bichos entram aqui conforme aparecem.</span>'}</div>
      </section>
      <section>
        <h4>Shinies encontrados <button class="pbsh-bt" data-a="limparHist" style="margin-left:8px">limpar</button></h4>
        ${hist.length ? `<table class="pbsh-tab"><tr><th>Quando</th><th>Mapa</th><th>Pokémon</th><th>Bolas</th><th>Resultado</th></tr>
          ${hist.map((h) => `<tr><td>${hora(h.em)}</td><td>${esc(core.hunts?.find((x) => x.slug === h.mapa)?.nome ?? h.mapa)}</td>
            <td class="pbsh-sh">✨ ${esc(h.nome)} Nv ${h.nivel}</td><td>${h.bolas ? `${h.bolas} ${esc(h.bola)}` : '—'}</td>
            <td class="${/capturado/.test(h.resultado) ? 'pbsh-ok' : /capturando/.test(h.resultado) ? '' : 'pbsh-ruim'}">${esc(h.resultado)}</td></tr>`).join('')}</table>`
          : '<span class="pbsh-aviso">Nenhum shiny encontrado ainda.</span>'}
      </section>`;
    pintarStatus();
  }

  function pintarStatus() {
    const el = document.getElementById('pbsh-status');
    if (!el) return;
    const semCena = Date.now() - mem.ultimoCampo > 8000 && !!core.eu?.huntSlug;
    const b = idBola(cfg.bola), r = idBola(cfg.reserva);
    el.innerHTML = [
      `${esc(cfg.bola)}: <b>${b != null ? qtd(b).toLocaleString('pt-BR') : '?'}</b>`,
      cfg.reserva ? `${esc(cfg.reserva)}: <b>${r != null ? qtd(r).toLocaleString('pt-BR') : '?'}</b>` : '',
      alvos.size ? `<span class="pbsh-sh">capturando ${[...alvos.values()].map((a) => `${esc(a.nome)} (${a.tentativas} bola${a.tentativas === 1 ? '' : 's'})`).join(', ')}</span>` : '',
      semCena ? '<span class="pbsh-aviso">⚠ sem informações do mapa — no Modo Economia o jogo não mostra os bichos; desligue o 🍃 Eco nesta conta</span>' : '',
    ].filter(Boolean).join(' · ');
  }

  function aoClicar(e) {
    if (e.target.id === 'pbsh-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'fechar') return fechar();
    if (a === 'ativo') { cfg.ativo = !cfg.ativo; if (!cfg.ativo) for (const s of [...alvos.keys()]) encerrar(s, 'caçador desligado'); }
    else if (a === 'aviso') cfg.aviso = b.checked;
    else if (a === 'limparHist') { hist = []; salvarHist(); }
    salvarCfg();
    pintar();
  }

  function abrir() { document.getElementById('pbsh-fundo').classList.add('aberto'); pintar(); }
  function fechar() { document.getElementById('pbsh-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

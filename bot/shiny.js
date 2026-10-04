// PokéIdle Bot — CAÇADOR DE SHINY. Trocado a quente junto com a lógica.
//
// Grava os selvagens que aparecem no mapa (pelas mensagens `campo`: cada bicho vem com nome,
// nível e `sh` = shiny). O jogo só aceita UMA bola por pokémon caído, então a bola certa tem de
// estar escolhida antes de ele cair:
//   · com o arremesso automático (VIP) ligado, assim que o shiny APARECE o app deixa só a bola
//     escolhida (Beast Ball por padrão) ativa nos chips de bola das Automações (`auto.set` com
//     `ballIds`) — o automático a joga quando ele cai — e devolve as bolas de antes depois;
//   · com o automático desligado, o app arremessa a bola escolhida (Beast Ball) no corpo (`ball.throw`).
// O contador "shinies vistos" da sessão do jogo sobe no evento `bola` com `shiny`; se ele
// marcar um shiny que o app não viu, fica no histórico como detecção perdida.
//
// Precisa da cena: no Modo Economia o servidor não manda `campo`, e não há como saber quem é
// shiny antes da bola (o automático jogaria a bola comum). Por isso, com o caçador ligado e a
// conta caçando, o app SAI do Modo Economia sozinho.
(() => {
  'use strict';
  const VERSAO_SHINY = '1.7.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pbsh-fundo')?.classList.contains('aberto');
  window.__pokeShiny?.desmontar?.();

  const limpezas = [];
  const S = {
    versao: VERSAO_SHINY,
    get ativo() { return cfg.ativo; },
    /** Liga/desliga o caçador (a janela do app usa ao ligar o Eco). */
    definirAtivo(v) { cfg.ativo = !!v; if (!cfg.ativo) for (const s of [...alvos.keys()]) encerrar(s, 'caçador desligado'); salvarCfg(); pintar(); return cfg.ativo; },
    /** Há shiny no mapa (vivo ou no chão esperando a bola). */
    get ocupado() { return cfg.ativo && alvos.size > 0; },
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokeShiny = S;

  // ---------------------------------------------------------------- constantes
  const CHAVE_CFG = 'pokeshiny.v1';
  const CHAVE_HIST = 'pokeshiny.hist.v1';
  const ESPERA_AUTO_MS = 2500;     // automático ligado: se ele não jogar nesse tempo, o app joga
  const SEM_RESPOSTA_MS = 5000;    // sem evento `bola` depois do arremesso: desiste
  const DEVOLVER_MS = 5000;        // garantia: tantos ms depois de cair, a bola ativa volta de qualquer jeito
  const VIVO_MAX_MS = 60_000;      // "shiny" vivo há mais que isso não é selvagem de onda: desiste e devolve as bolas
  const HIST_MAX = 200;
  // A bola padrão é a Beast Ball (a de melhor captura). A Master pede confirmação: com o
  // arremesso automático, a bola ativa vai em TODO bicho que cair enquanto o shiny não cai.
  const BOLA_CARA = /master/i;
  const BOLA_PADRAO = 'Beast Ball';
  const VERSAO_CFG = 2;

  function lerCfg() {
    const padrao = { v: VERSAO_CFG, ativo: false, bola: BOLA_PADRAO, reserva: 'Ultra Ball', aviso: true };
    try {
      const salvo = JSON.parse(localStorage.getItem(CHAVE_CFG));
      if (!salvo) return padrao;
      // Quem ainda estava no padrão antigo (Great Ball) passa para o novo, uma vez.
      if (salvo.v !== VERSAO_CFG && salvo.bola === 'Great Ball') salvo.bola = BOLA_PADRAO;
      return { ...padrao, ...salvo, v: VERSAO_CFG };
    } catch { return padrao; }
  }
  const cfg = lerCfg();
  delete cfg.maxBolas; // sobra da versão 1.0
  try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {}
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };
  let hist = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_HIST)) ?? []; } catch { return []; } })();
  const salvarHist = () => { try { localStorage.setItem(CHAVE_HIST, JSON.stringify(hist.slice(0, HIST_MAX))); } catch {} };

  // Os selvagens do mapa e a contagem do que já apareceu (sobrevivem à troca a quente).
  const mem = (core.memoria.shiny ??= { mobs: new Map(), vistos: new Map(), mapa: null, ultimoCampo: 0, ballIdsAntes: null });
  const alvos = new Map(); // slot -> { nome, nivel, caido, jogou, timer, registro }
  const soRegistrados = new Map(); // slot -> registro dos shinies vistos com o caçador desligado
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hora = (ms = Date.now()) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const nomeBola = (b) => b?.nome ?? b?.name ?? '';
  const idBola = (nome) => (core.catalogoBolas ?? []).find((b) => nomeBola(b) === nome)?.id ?? null;
  const nomeDoId = (id) => nomeBola((core.catalogoBolas ?? []).find((b) => b.id === Number(id))) || `bola ${id}`;
  const qtd = (id) => Number(core.eu?.balls?.[id] ?? 0);
  /** A bola da vez: a escolhida, ou a reserva se a escolhida acabou. */
  function bolaDaVez() {
    for (const nome of [cfg.bola, cfg.reserva]) {
      const id = idBola(nome);
      if (id != null && qtd(id) > 0) return { id, nome };
    }
    return null;
  }
  const semBola = () => `sem ${cfg.bola}${cfg.reserva ? ` nem ${cfg.reserva}` : ''}`;

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

  /** Linha do tempo do shiny: cada etapa com o tempo desde que ele apareceu. */
  function marcar(reg, txt) {
    if (!reg) return;
    (reg.linha ??= []).push(`+${((Date.now() - reg.em) / 1000).toFixed(1)}s ${txt}`);
    salvarHist();
  }

  function registrarHist(reg) {
    hist.unshift(reg);
    hist = hist.slice(0, HIST_MAX);
    salvarHist();
    pintar();
  }

  // ---------------------------------------------------------------- bolas ativas (Automações)
  const auto = () => core.eu?.automation ?? {};
  const autoBallLigado = () => !!(auto().autoBallAteCapturar || auto().autoBallSemParar || auto().autoBall);
  const mesmaLista = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

  /**
   * Manda a lista de bolas ativas e já a anota na cópia local das Automações: a confirmação do
   * servidor chega depois, e comparar com a cópia velha fazia a devolução nunca ser enviada.
   */
  function definirBolasAtivas(ids) {
    const nova = { ...auto(), ballIds: [...ids] };
    if (core.eu) core.eu.automation = nova;
    core.send({ t: 'auto.set', ...nova });
  }

  /** Deixa só a bola do shiny ativa no arremesso automático — guardando as de antes. */
  function ativarBolaDoShiny(bola, reg) {
    const atuais = auto().ballIds ?? [];
    if (mem.ballIdsAntes == null) mem.ballIdsAntes = [...atuais];
    if (mesmaLista(atuais, [bola.id])) return marcar(reg, `${bola.nome} já era a bola ativa`);
    definirBolasAtivas([bola.id]);
    marcar(reg, `bola ativa trocada: [${atuais.map(nomeDoId).join(', ')}] → [${bola.nome}]`);
  }

  /** Devolve as bolas ativas de antes (sempre manda — não confia na cópia local). */
  function restaurarBolas(reg) {
    if (mem.ballIdsAntes == null || alvos.size) return;
    const antes = mem.ballIdsAntes;
    mem.ballIdsAntes = null;
    definirBolasAtivas(antes);
    marcar(reg, `bolas ativas devolvidas: [${antes.map(nomeDoId).join(', ')}]`);
  }

  // ---------------------------------------------------------------- captura
  function encerrar(slot, resultado) {
    const a = alvos.get(slot);
    if (!a) return;
    clearTimeout(a.timer);
    clearTimeout(a.garantia);
    clearTimeout(a.vivoDemais);
    alvos.delete(slot);
    a.registro.resultado = resultado;
    marcar(a.registro, `fim: ${resultado}`);
    avisar(`✨ ${a.nome}: ${resultado}`);
    restaurarBolas(a.registro);
    pintar();
  }

  /** Um shiny apareceu (vivo): registra e, com o automático ligado, já troca a bola ativa. */
  function shinyApareceu(slot, m) {
    if (alvos.has(slot)) return alvos.get(slot);
    if (soRegistrados.has(slot)) return null;
    const registro = { em: Date.now(), mapa: core.eu?.huntSlug ?? '', nome: m.nome, nivel: m.nivel, resultado: 'à vista', bolas: 0, bola: '' };
    registrarHist(registro);
    if (!cfg.ativo) {
      registro.resultado = 'caçador desligado';
      soRegistrados.set(slot, registro);
      salvarHist();
      avisar(`✨ SHINY no mapa: ${m.nome} Nv ${m.nivel} (caçador desligado)`);
      return null;
    }
    const a = { nome: m.nome, nivel: m.nivel, caido: false, jogou: false, timer: null, registro };
    alvos.set(slot, a);
    marcar(registro, `apareceu (slot ${slot}, Nv ${m.nivel})`);
    // Selvagem de onda cai em segundos. Vivo há 1 min = não é selvagem (pet, treino…): desiste.
    a.vivoDemais = setTimeout(() => {
      if (alvos.get(slot) === a && !a.caido) encerrar(slot, `não caiu em ${VIVO_MAX_MS / 1000} s — não parece selvagem; bolas devolvidas`);
    }, VIVO_MAX_MS);
    const bola = bolaDaVez();
    if (!bola) { encerrar(slot, semBola()); return null; }
    if (autoBallLigado()) {
      ativarBolaDoShiny(bola, registro);
      registro.resultado = `${bola.nome} ativa — esperando ele cair`;
    } else registro.resultado = `esperando ele cair para jogar ${bola.nome}`;
    salvarHist();
    avisar(`✨ SHINY no mapa: ${m.nome} Nv ${m.nivel} — ${bola.nome} pronta!`);
    pintar();
    return a;
  }

  /** O jogo aceita UMA bola por caído: joga uma vez e espera o resultado. */
  function arremessarUmaVez(slot) {
    const a = alvos.get(slot);
    if (!a || a.jogou || !cfg.ativo) return;
    const bola = bolaDaVez();
    if (!bola) return encerrar(slot, semBola());
    if (!core.send({ t: 'ball.throw', ballId: bola.id, slot })) return;
    a.jogou = true;
    a.registro.bolas = 1;
    a.registro.bola = bola.nome;
    a.registro.resultado = `${bola.nome} arremessada…`;
    marcar(a.registro, `app arremessou ${bola.nome}`);
    clearTimeout(a.timer);
    a.timer = setTimeout(() => encerrar(slot, 'o servidor não respondeu ao arremesso'), SEM_RESPOSTA_MS);
    pintar();
  }

  function shinyCaiu(slot, m) {
    if (soRegistrados.has(slot)) return; // já registrado, e o caçador não vai pegar este
    const a = alvos.get(slot) ?? shinyApareceu(slot, m); // caiu no mesmo pacote em que apareceu
    if (!a || a.caido) return;
    a.caido = true;
    marcar(a.registro, autoBallLigado() ? 'caiu — esperando o arremesso automático do jogo' : 'caiu');
    if (autoBallLigado()) {
      // O automático joga a bola ativa (a escolhida). Se em 2,5 s nada acontecer, o app joga.
      a.timer = setTimeout(() => arremessarUmaVez(slot), ESPERA_AUTO_MS);
    } else arremessarUmaVez(slot);
    // Garantia: com 1 bola por shiny, depois de alguns segundos não há mais o que esperar —
    // encerra e devolve as bolas ativas mesmo que o resultado da bola não tenha chegado.
    a.garantia = setTimeout(() => encerrar(slot, a.jogou ? 'bola jogada (resultado não chegou)' : 'sem bola a tempo'), ESPERA_AUTO_MS + DEVOLVER_MS);
  }

  /** Resultado de uma bola (do app ou do automático do jogo). */
  function aoBola(e) {
    // Sem slot no evento (o automático pode não mandar): é do shiny caído, se houver um só.
    if (e.slot == null && e.shiny) {
      const caidos = [...alvos.entries()].filter(([, x]) => x.caido);
      if (caidos.length === 1) e = { ...e, slot: caidos[0][0] };
    }
    const a = alvos.get(e.slot);
    const nome = nomeDoId(e.ballId);
    if (!a) {
      // Um shiny que o app viu com o caçador desligado: a bola foi do automático do jogo.
      const reg = soRegistrados.get(e.slot);
      if (reg) {
        reg.bolas = 1;
        reg.bola = nome;
        reg.resultado = `${reg.resultado.split(' — ')[0]} — o arremesso automático do jogo jogou ${nome}: ${e.sucesso ? 'capturado' : 'escapou'}`;
        soRegistrados.delete(e.slot);
        salvarHist();
        pintar();
        return;
      }
      // O contador "shinies vistos" do jogo marcou um shiny que o app não viu chegar.
      if (e.shiny) {
        registrarHist({
          em: Date.now(), mapa: core.eu?.huntSlug ?? '', nome: e.nome ?? '?', nivel: e.level ?? '?', bolas: 1, bola: nome,
          resultado: emEco()
            ? `⚠ não visto: a conta estava no 🍃 Eco (o jogo não mostra os bichos) — levou ${nome}${e.sucesso ? ' e foi capturado' : ' e escapou'}`
            : `⚠ detecção perdida (o jogo contou o shiny na bola)${e.sucesso ? ' — capturado' : ''}`,
        });
      }
      return;
    }
    a.jogou = true;
    a.registro.bolas = 1;
    a.registro.bola = nome;
    marcar(a.registro, `resultado da bola: ${nome} — ${e.sucesso ? 'capturou' : 'escapou'}`);
    encerrar(e.slot, e.sucesso ? `capturado com ${nome}` : `escapou da ${nome} (o jogo só deixa 1 bola por shiny)`);
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
    // Não é selvagem: treinador (tr), pokémon com dono (dn), boneco/posto do XP Share (bn/tn/bi),
    // pokémon EM TREINO (ti — era o "Mbappé" que o caçador tomava por shiny), NPCs da praça.
    if (b.tr || b.dn !== undefined || b.tn !== undefined || b.bn || b.bi !== undefined || b.ti !== undefined || b.cura || b.tm || b.depot) m.ignorar = true;
    if (!core.eu?.huntSlug || core.eu.noCentro) m.ignorar = true;          // Centro, PvP: não são selvagens
    // Apelido de um pokémon seu (selvagem não tem apelido): também não é alvo.
    if (!m.ignorar && b.n !== undefined && (core.eu?.pokemons ?? []).some((p) => (p.apelido || p.nick) === b.n)) m.ignorar = true;
    if (m.ignorar) return;
    const reviveu = eraMorto && !m.morto; // o slot foi reaproveitado por um bicho novo
    if (nasceu || reviveu) {
      contarVisto(m);
      if (reviveu) soRegistrados.delete(b.s);
      if (reviveu && alvos.has(b.s)) encerrar(b.s, alvos.get(b.s).jogou ? 'sumiu do chão' : 'sumiu do chão sem bola');
      if (m.shiny && !m.morto) shinyApareceu(b.s, m);
    }
    if (m.shiny && m.morto && (!eraMorto || nasceu)) shinyCaiu(b.s, m);
  }

  function aoMensagem(ev) {
    if (typeof ev.data !== 'string') return;
    const d = ev.data;
    if (!d.includes('"t":"campo') && !d.includes('"t":"batalha"')) return;
    let m;
    try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'campo.init') {
      for (const slot of [...alvos.keys()]) encerrar(slot, 'mudou de mapa');
      mem.mobs.clear();
      soRegistrados.clear();
      if (mem.mapa !== core.eu?.huntSlug) { mem.vistos.clear(); mem.mapa = core.eu?.huntSlug ?? null; }
      for (const b of m.mobs ?? []) aplicarMob(b, true);
      mem.ultimoCampo = Date.now();
      pintar();
    } else if (m.t === 'campo') {
      for (const b of m.mobs ?? []) aplicarMob(b, false);
      for (const s of m.fora ?? []) {
        mem.mobs.delete(s);
        soRegistrados.delete(s);
        if (alvos.has(s)) encerrar(s, alvos.get(s).jogou ? 'sumiu do chão' : 'sumiu do chão sem bola');
      }
      mem.ultimoCampo = Date.now();
    } else if (m.t === 'batalha') {
      for (const e of m.ev ?? []) {
        if (e.k === 'bola') aoBola(e);
        else if (e.k === 'fugiu') {
          for (const [slot, a] of alvos) if (a.nome === e.nome && a.caido) encerrar(slot, 'fugiu');
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
  // Se a lógica foi recarregada no meio de uma troca, devolve as bolas de antes.
  restaurarBolas();
  // Caçador ligado + Modo Economia = cego: sai do Eco (no máximo a cada 30 s, se o jogo recolocar).
  const emEco = () => document.documentElement.classList.contains('modo-economia');
  let saiuDoEcoEm = 0;
  function vigiarEco() {
    if (!cfg.ativo || !core.logado || !emEco() || Date.now() - saiuDoEcoEm < 30_000) return;
    saiuDoEcoEm = Date.now();
    document.getElementById('eco-sair')?.click();
    avisar('🍃 Modo Economia desligado: o caçador de shiny precisa ver o mapa (no Eco o shiny levaria a bola comum)');
    console.log('[Shiny] saiu do Modo Economia — caçador ligado');
  }
  const vigia = setInterval(() => { ligarWs(); vigiarEco(); if (estaAberto()) pintarStatus(); }, 1000);
  limpezas.push(() => {
    clearInterval(vigia);
    for (const a of alvos.values()) { clearTimeout(a.timer); clearTimeout(a.garantia); }
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
  .pbsh-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pbsh-tab{width:100%;border-collapse:collapse;font-size:12px}
  .pbsh-tab th{text-align:left;color:#f3c77a;padding:4px 6px;font-weight:700}
  .pbsh-tab td{padding:4px 6px;border-top:1px solid #4a2a2a}
  .pbsh-sh{color:#ffd166;font-weight:700}.pbsh-ok{color:#7fdc8f}.pbsh-ruim{color:#ff8a8a}.pbsh-aviso{color:#f3c77a}
  .pbsh-linha-tempo{font:11px ui-monospace,monospace;color:#f6e7d4;opacity:.85;margin-top:3px}
  .pbsh-linha-tempo summary{cursor:pointer;color:#f3c77a;font:11px system-ui}
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
      const v = e.target.value;
      if ((c === 'bola' || c === 'reserva') && BOLA_CARA.test(v)
        && !confirm(`${v} é uma bola cara.\n\nCom o arremesso automático ligado, enquanto o shiny não cai a bola ativa vai em TODO bicho que cair.\n\nUsar ${v} mesmo assim?`)) {
        return pintar(); // volta o seletor para a bola de antes
      }
      cfg[c] = v;
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

  const classeResultado = (r) => (/capturado/.test(r) ? 'pbsh-ok' : /esperando|ativa|arremessada|à vista/.test(r) ? '' : 'pbsh-ruim');

  function pintar() {
    const modal = document.getElementById('pbsh-modal');
    if (!modal || !estaAberto()) return;
    const vistos = [...mem.vistos.values()].sort((a, b) => b.shiny - a.shiny || b.total - a.total);
    modal.innerHTML = `
      <header><span>✨ Caçador de shiny<small>v${VERSAO_SHINY}</small></span><button data-a="fechar" title="Fechar">×</button></header>
      <section>
        <div class="pbsh-linha">
          <button class="pbsh-sw ${cfg.ativo ? 'on' : ''}" data-a="ativo"></button>
          <b>${cfg.ativo ? 'Ligado: prepara a bola quando um shiny aparece' : 'Desligado (só registra)'}</b>
        </div>
        <div class="pbsh-linha">
          Bola para shiny: <select class="pbsh-in" data-c="bola">${opcoesBola(cfg.bola, false)}</select>
          se acabar, usar: <select class="pbsh-in" data-c="reserva">${opcoesBola(cfg.reserva, true)}</select>
          <small>(o jogo só aceita 1 bola por shiny)</small>
        </div>
        <div class="pbsh-linha">
          <label><input type="checkbox" data-a="aviso" ${cfg.aviso ? 'checked' : ''}> avisar na tela quando aparecer um shiny</label>
        </div>
        <p id="pbsh-status" style="margin:4px 0 0"></p>
      </section>
      <section>
        <h4>Bichos vistos neste mapa</h4>
        <div class="pbsh-vistos">${vistos.map((v) => `<span>${v.shiny ? `<span class="pbsh-sh">✨${v.shiny}</span> · ` : ''}${esc(v.nome)} ×${v.total}</span>`).join('') || '<span class="pbsh-aviso">Nada ainda — os bichos entram aqui conforme aparecem.</span>'}</div>
      </section>
      <section>
        <h4>Shinies encontrados <button class="pbsh-bt" data-a="limparHist" style="margin-left:8px">limpar</button></h4>
        ${hist.length ? `<table class="pbsh-tab"><tr><th>Quando</th><th>Mapa</th><th>Pokémon</th><th>Bola</th><th>Resultado</th></tr>
          ${hist.map((h) => `<tr><td>${hora(h.em)}</td><td>${esc(core.hunts?.find((x) => x.slug === h.mapa)?.nome ?? h.mapa)}</td>
            <td class="pbsh-sh">✨ ${esc(h.nome)} Nv ${esc(h.nivel)}</td><td>${h.bolas ? esc(h.bola) : '—'}</td>
            <td class="${classeResultado(h.resultado)}">${esc(h.resultado)}${h.linha?.length
              ? `<details class="pbsh-linha-tempo"><summary>linha do tempo</summary>${h.linha.map(esc).join('<br>')}</details>` : ''}</td></tr>`).join('')}</table>`
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
      autoBallLigado()
        ? 'Arremesso automático do jogo: <b>ligado</b> — quando um shiny aparece, o app deixa só a bola escolhida ativa e devolve as outras depois'
        : 'Arremesso automático do jogo: <b>desligado</b> — o app joga 1 bola quando o shiny cair',
      `${esc(cfg.bola)}: <b>${b != null ? qtd(b).toLocaleString('pt-BR') : '?'}</b>`,
      cfg.reserva ? `${esc(cfg.reserva)}: <b>${r != null ? qtd(r).toLocaleString('pt-BR') : '?'}</b>` : '',
      alvos.size ? `<span class="pbsh-sh">shiny no mapa: ${[...alvos.values()].map((a) => `${esc(a.nome)}${a.caido ? ' (caído)' : ''}`).join(', ')}</span>` : '',
      semCena ? `<span class="pbsh-aviso">⚠ sem informações do mapa${emEco() ? ' — conta no 🍃 Eco: com o caçador ligado o app sai do Eco sozinho' : ' — aguardando o mapa'}</span>` : '',
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

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
//
// 3) Auto PvP. Uma sessão: liga a fila automática e o auto-switch juntos. Pausa (desliga a fila)
//    com 3 derrotas seguidas; a cada 10 partidas da sessão, se o saldo não estiver positivo
//    (vitórias > derrotas), encerra de vez. Enquanto a sessão roda, ela substitui a trava do item 2.
(() => {
  'use strict';
  const VERSAO_PVP = '1.17.1';

  const core = window.__pokebotCore;
  if (!core) return;
  // Versão Lite do app: nada de PvP (nem auto-switch, nem agente, nem trava da fila).
  if (window.__pokeVariante === 'lite') { window.__pokePvp?.desmontar?.(); window.__pokePvp = null; return; }
  const estavaAberto = !!document.getElementById('ppvp-fundo')?.classList.contains('aberto');
  window.__pokePvp?.desmontar?.();

  const limpezas = [];
  const P = {
    versao: VERSAO_PVP,
    get trava() { return cfg.trava; },
    get autoSwitch() { return !!cfg.auto.ativo; },
    get autoPvp() { return cfg.sessao ? { ...cfg.sessao } : null; },
    /** Liga/desliga o auto-switch (o botão 🔁 Switch do cabeçalho da conta chama isto). */
    alternarAutoSwitch() { alternarAuto(); pintar(); return !!cfg.auto.ativo; },
    /** Liga/desliga o "🤖 agente de IA decide" desta conta (o painel 🤖 Agente IA do app chama isto). Ligar também liga o auto-switch. */
    definirAgente(v) { cfg.auto.agente = !!v; if (v && !cfg.auto.ativo) { cfg.auto.ativo = true; cfg.auto.seguidas = 0; } salvarCfg(); registrar(v ? '🤖 agente de IA LIGADO nesta conta' : '🤖 agente de IA desligado nesta conta'); pintar(); return cfg.auto.agente; },
    get agente() { return !!cfg.auto.agente; },
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
    // `auto` = o auto-switch de formações: troca depois de `vitorias` vitórias seguidas com a mesma
    // formação (o rival vai counterar) e, se `naDerrota`, logo após perder. `fora` = slots do
    // armário que não entram na rotação; `usoEm` = quando cada slot foi usado por último.
    // `sessao` = o Auto PvP em andamento: { inicio, v, d, seguidas, estado: rodando|pausada|encerrada, motivo }.
    const padrao = { trava: true, derrotas: 2, seguidas: 0, log: [], sessao: null, autoPvp: { maxSeguidas: 3, checarCada: 10 },
      auto: { ativo: false, modo: 'prever', vitorias: 1, naDerrota: true, focoAmeacas: true, contraCounter: true, ultimoAnti: null, abertura: true, sempreTrocar: 'zator, alan', manterSeVencer: 'erva',
        regrasRival: 'erva: Blastoise=último; Venusaur≠último', reavaliarFila: true, ia: true, agente: false, minUso: 2, foraKeys: [], seguidas: 0, usoEm: {} } };
    try {
      const s = JSON.parse(localStorage.getItem(CHAVE_CFG)) ?? {};
      return { ...padrao, ...s, auto: { ...padrao.auto, ...(s.auto ?? {}) }, autoPvp: { ...padrao.autoPvp, ...(s.autoPvp ?? {}) } };
    } catch { return padrao; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };
  let hist = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_HIST)) ?? []; } catch { return []; } })();
  const salvarHist = () => { try { localStorage.setItem(CHAVE_HIST, JSON.stringify(hist.slice(0, HIST_MAX))); } catch {} };
  // As melhores comps guardadas por jogador: { nick(minúsculo): { nick, ordem: {em, r}, bolsa: {em, r} } }
  const CHAVE_MELHORES = 'pokepvp.melhores.v1';
  let melhores = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_MELHORES)) ?? {}; } catch { return {}; } })();
  const salvarMelhores = () => { try { localStorage.setItem(CHAVE_MELHORES, JSON.stringify(melhores)); } catch {} };
  let ladder = [];             // o top do PvP (pvp.info → ladder)
  let filaInfo = null;         // { n, em }: quantos estão procurando partida (o jogo informa), você incluído
  let formacoes = null;        // o armário do jogo: [{ slot, nome, ids, v, d, cv, cd }] (pvp.info / respostas do armário)
  const calcRival = new Map(); // nick -> 'ordem' | 'bolsa' | { erro } enquanto calcula
  let busca = '';
  let pagina = 0;
  let aba = 'historico';      // 'historico' | 'stats'
  const sugestoes = new Map(); // id do duelo -> { carregando, erro, r } (a "melhor ordem" calculada)
  let abertaSug = null;        // id do duelo com a sugestão aberta
  const st = { porOrdem: true, minimo: 1, periodo: 'tudo' }; // no PvP a ordem é a decisão: por padrão, cada ordem é uma comp // filtros da aba Estatísticas
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
      .map((p) => ({ id: p.id, nome: p.nome, nivel: p.level, shiny: !!p.shiny })); // espécie, não apelido: é o que define a comp
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
  function ligarFila(ligada) {
    if (!!auto().pvpAutoFila === ligada) return;
    const nova = { ...auto(), pvpAutoFila: ligada };
    if (core.eu) core.eu.automation = nova;
    core.send({ t: 'auto.set', ...nova });
  }

  // ---------------------------------------------------------------- Auto PvP (sessão)
  const sessaoRodando = () => cfg.sessao?.estado === 'rodando';
  const placarSessao = (x = cfg.sessao) => `${x.v}V ${x.d}D`;

  /** Começa (ou retoma, se pausada) o Auto PvP: fila automática + auto-switch ligados. */
  function iniciarAutoPvp() {
    if (!core.logado) { avisar('Entre na conta antes de ligar o Auto PvP'); return; }
    const retomar = cfg.sessao?.estado === 'pausada';
    if (retomar) Object.assign(cfg.sessao, { estado: 'rodando', seguidas: 0, motivo: '' });
    else cfg.sessao = { inicio: Date.now(), v: 0, d: 0, seguidas: 0, estado: 'rodando', motivo: '' };
    if (!cfg.auto.ativo) { cfg.auto.ativo = true; cfg.auto.seguidas = 0; registrar('🔁 auto-switch LIGADO pelo Auto PvP'); }
    cfg.seguidas = 0;
    ligarFila(true);
    registrar(retomar ? `▶ Auto PvP RETOMADO (${placarSessao()})` : '▶ Auto PvP LIGADO — fila automática + auto-switch');
    avisar(retomar ? `▶ Auto PvP retomado (${placarSessao()})` : '▶ Auto PvP ligado — fila automática + auto-switch');
    salvarCfg();
  }

  /** Para o Auto PvP: desliga a fila. `estado` 'pausada' (dá para retomar) ou 'encerrada' (de vez). */
  function pararAutoPvp(estado, motivo) {
    if (!cfg.sessao) return;
    Object.assign(cfg.sessao, { estado, motivo, fim: Date.now() });
    ligarFila(false);
    const txt = `${estado === 'encerrada' ? '⛔ Auto PvP ENCERRADO' : '⏸ Auto PvP PAUSADO'} — ${motivo} (sessão: ${placarSessao()})`;
    registrar(txt);
    avisar(txt);
    salvarCfg();
  }

  /** Conta a partida na sessão e aplica as regras: N derrotas seguidas pausa; a cada M sem saldo positivo, encerra. */
  function contarSessao(reg) {
    if (!sessaoRodando()) return;
    const x = cfg.sessao;
    if (reg.venci) { x.v++; x.seguidas = 0; } else { x.d++; x.seguidas++; }
    const n = x.v + x.d;
    const cada = Math.max(1, Number(cfg.autoPvp.checarCada) || 10);
    const maxSeg = Math.max(1, Number(cfg.autoPvp.maxSeguidas) || 3);
    registrar(`Auto PvP: partida ${n} — ${reg.venci ? 'vitória' : 'derrota'} vs ${reg.nick} (${placarSessao()})`);
    if (n % cada === 0 && x.v <= x.d) pararAutoPvp('encerrada', `${n} partidas sem saldo positivo`);
    else if (x.seguidas >= maxSeg) pararAutoPvp('pausada', `${x.seguidas} derrotas seguidas`);
    else salvarCfg();
  }

  function contarResultado(reg) {
    contarSessao(reg);
    if (reg.venci) { cfg.seguidas = 0; salvarCfg(); return; }
    cfg.seguidas = (cfg.seguidas ?? 0) + 1;
    registrar(`derrota para ${reg.nick} — ${cfg.seguidas} seguida(s)`);
    const limite = Math.max(1, Number(cfg.derrotas) || 2);
    // Com o Auto PvP rodando, valem as regras dele (seguidas / saldo), não esta trava.
    if (cfg.trava && !sessaoRodando() && cfg.seguidas >= limite && auto().pvpAutoFila) {
      const nova = { ...auto(), pvpAutoFila: false };
      if (core.eu) core.eu.automation = nova;
      core.send({ t: 'auto.set', ...nova });
      registrar(`⛔ fila automática DESLIGADA após ${cfg.seguidas} derrotas seguidas`);
      avisar(`⛔ ${cfg.seguidas} derrotas seguidas no PvP — fila automática desligada`);
      cfg.seguidas = 0;
    }
    salvarCfg();
  }

  // ---------------------------------------------------------------- aplicar, armário e auto-switch
  const mesmaEscalacao = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => Number(x) === Number(b[i]));
  const partidasF = (f) => (Number(f?.v) || 0) + (Number(f?.d) || 0) + (Number(f?.cv) || 0) + (Number(f?.cd) || 0);
  const vitoriasF = (f) => (Number(f?.v) || 0) + (Number(f?.cv) || 0);

  /**
   * Os ids da sua escalação naquele duelo, na ordem. Duelo antigo sem ids: casa os nomes com a
   * bolsa (mesma espécie, nível mais perto, sem repetir). Pokémon que saiu da bolsa = null.
   */
  function idsDoDuelo(h) {
    if (!h.meu?.length) return null;
    if (h.meu.every((x) => x.id != null)) return h.meu.map((x) => x.id);
    const livres = [...(core.eu?.pokemons ?? [])];
    const ids = [];
    for (const x of h.meu) {
      const cand = livres.filter((p) => String(p.nome).toLowerCase() === String(x.nome).toLowerCase())
        .sort((a, b) => Math.abs((a.level ?? 0) - (x.nivel ?? 0)) - Math.abs((b.level ?? 0) - (x.nivel ?? 0)));
      if (!cand.length) return null;
      livres.splice(livres.indexOf(cand[0]), 1);
      ids.push(cand[0].id);
    }
    return ids;
  }

  /**
   * As SUAS formações, tiradas sozinhas do histórico: cada escalação exata (mesmos pokémon, mesma
   * ordem) que você usou, com a efetividade dela (V-D) recontada a cada duelo. As do armário do
   * jogo entram também (com o placar dele, se tiver mais jogos que o histórico).
   */
  function minhasFormacoes() {
    const naBolsa = new Set((core.eu?.pokemons ?? []).map((p) => p.id));
    const mapa = new Map();
    const pegar = (ids) => {
      const k = ids.join(',');
      if (!mapa.has(k)) mapa.set(k, { k, ids, n: 0, v: 0, ultimo: 0, armario: null });
      return mapa.get(k);
    };
    for (const h of hist) {
      const ids = idsDoDuelo(h);
      if (!ids) continue;
      const f = pegar(ids);
      f.n++;
      if (h.venci) f.v++;
      f.ultimo = Math.max(f.ultimo, h.em);
    }
    for (const a of formacoes ?? []) {
      if (!a.ids?.length) continue;
      const f = pegar(a.ids);
      f.armario = a;
      if (partidasF(a) > f.n) { f.n = partidasF(a); f.v = vitoriasF(a); }
    }
    return [...mapa.values()]
      .filter((f) => f.ids.length >= timeCheio()) // duelo gravado incompleto (4 de 5): não é formação
      .filter((f) => f.ids.every((id) => naBolsa.has(id))) // pokémon vendido/solto: a formação não existe mais
      .map((f) => ({ ...f, nome: f.armario?.nome ?? (() => { const n = nomesDosIds(f.ids); return n.length > 2 ? `${n[0]} … ${n[n.length - 1]}` : n.join(' → '); })() }));
  }
  /**
   * Equipe de PvP salva com menos de 5 (ex.: uma troca antiga aplicou só 4): volta para a formação
   * completa mais recente que tenha todos os que estão nela. Sem nenhuma, só avisa.
   */
  let consertoEm = 0;
  function consertarTimeIncompleto() {
    if (!meuTimeIds?.length || meuTimeIds.length >= timeCheio() || Date.now() - consertoEm < 60_000) return;
    consertoEm = Date.now();
    const atuais = new Set(meuTimeIds.map(Number));
    const cheia = minhasFormacoes().filter((f) => [...atuais].every((id) => f.ids.includes(id)))
      .sort((a, b) => b.ultimo - a.ultimo)[0];
    if (cheia && aplicarEquipe(cheia.ids, `equipe estava com ${atuais.size} — completada`)) {
      avisar(`⚠ Equipe de PvP estava com ${atuais.size} pokémon — completei com "${cheia.nome}"`);
    } else {
      registrar(`⚠ a equipe de PvP está com ${atuais.size} pokémon e não achei formação completa com eles — monte os 5 no jogo`);
      avisar(`⚠ Equipe de PvP com ${atuais.size} pokémon — monte os 5 no jogo`);
    }
  }
  const chaveAtual = () => (meuTimeIds?.length ? meuTimeIds.join(',') : null);
  const naRotacao = (f) => (f.n >= Math.max(1, Number(cfg.auto.minUso) || 1) || f.armario) && !cfg.auto.foraKeys.includes(f.k);
  /** Nota da formação: taxa com "prior" (1V 1D), para 1 jogo não valer 100%. */
  const notaF = (f) => (f.v + 1) / (f.n + 2);
  const NOVA_ATE = 2; // com menos partidas que isso, a formação é "nova" (do armário, nunca usada): entra antes, para ser testada
  /** Quem entra primeiro: formação nova, depois a melhor nota, depois a há mais tempo sem uso. */
  const ordemDeEscolha = (x, y) => (x.n < NOVA_ATE ? 0 : 1) - (y.n < NOVA_ATE ? 0 : 1)
    || notaF(y) - notaF(x) || (cfg.auto.usoEm[x.k] ?? x.ultimo) - (cfg.auto.usoEm[y.k] ?? y.ultimo);

  /** Troca a equipe de PvP agora (a mesma mensagem do editor de equipe do jogo). */
  /** Quantos a equipe de PvP tem de ter: 5 (ou todos da bolsa, se tiver menos). */
  const timeCheio = () => Math.min(TIME_PVP, (core.eu?.pokemons ?? []).length || TIME_PVP);

  function aplicarEquipe(ids, motivo) {
    if (!ids?.length) return false;
    ids = [...new Set(ids.map(Number))];
    if (ids.length < timeCheio()) {
      registrar(`⚠ troca CANCELADA: a equipe nova teria só ${ids.length} pokémon (${nomesDosIds(ids).join(', ')}) — o PvP usa ${timeCheio()}`);
      return false;
    }
    if (!core.send({ t: 'pvp.time.salvar', pokemonIds: ids })) { registrar('⚠ não deu para trocar a equipe: conta desconectada'); return false; }
    meuTimeIds = [...ids];
    registrar(`✅ equipe trocada${motivo ? ` (${motivo})` : ''}: ${nomesDosIds(ids).join(' → ')}`);
    return true;
  }

  /** Guarda a escalação no armário do jogo: na primeira vaga livre, ou na que o jogador escolher. */
  function salvarNoArmario(ids, nome) {
    if (!ids?.length) return;
    if (formacoes == null) { core.send({ t: 'pvp.info' }); avisar('Carregando o armário… tente de novo em um instante.'); return; }
    const usados = new Set(formacoes.map((f) => f.slot));
    let slot = [1, 2, 3, 4, 5].find((s) => !usados.has(s));
    if (!slot) {
      const r = prompt(`O armário está cheio. Substituir qual formação? (digite o número)\n\n${formacoes.map((f) => `${f.slot}: ${f.nome} — ${vitoriasF(f)}V ${partidasF(f) - vitoriasF(f)}D`).join('\n')}`);
      slot = Number(r);
      if (![1, 2, 3, 4, 5].includes(slot)) return;
    }
    const n = [...String(nome ?? 'Formação').replace(/\s+/g, ' ').trim()].slice(0, 30).join('');
    core.send({ t: 'pvp.formacao.salvar', slot, nome: n, pokemonIds: ids });
    registrar(`💾 salvando no armário (vaga ${slot}): "${n}" — ${nomesDosIds(ids).join(' → ')}`);
  }

  function nomesDosIds(ids) {
    const porId = new Map((core.eu?.pokemons ?? []).map((p) => [p.id, p]));
    return ids.map((id) => porId.get(id)?.nome ?? `#${id}`);
  }

  /**
   * Depois de cada partida (o duelo já entrou no histórico, então a efetividade já está atualizada):
   * venceu N seguidas com a mesma formação → troca (o rival vai counterar essa); perdeu → troca
   * (se ligado). Entra a melhor das suas formações, sem ser a atual, aplicada direto na equipe.
   */
  function alternarAuto() {
    cfg.auto.ativo = !cfg.auto.ativo;
    cfg.auto.seguidas = 0;
    salvarCfg();
    registrar(cfg.auto.ativo ? '🔁 auto-switch LIGADO' : 'auto-switch desligado');
    avisar(cfg.auto.ativo ? '🔁 Auto-switch LIGADO' : 'Auto-switch desligado');
  }

  // ---------------------------------------------------------------- prever o próximo adversário
  const mesmoNick = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();

  const JANELA_ATIVOS_MS = 60 * 60 * 1000; // enfrentou na última hora = está ativo na fila
  const PESO_REPETIR = 0.2;                 // quem você ACABOU de enfrentar: 20% de chance de vir de novo (os outros ativos, 80%)

  /**
   * Quem está na fila e com que chance vem agora. O jogo só diz QUANTOS estão procurando
   * (`fila.tamanho`), não quem — mas quem você enfrentou na última hora está ativo. Os candidatos
   * são esses (cortados pelo tamanho da fila, se o jogo informou). Pesos: quem acabou de lutar
   * com você pesa menos; os outros ganham peso pela sequência do histórico (depois de A costuma
   * vir B). Devolve [{ nick, p, base }] do mais provável para o menos.
   */
  function preverProximo(ultimoNick, pesoRepetir = PESO_REPETIR, t = null) {
    if (cfg.auto.ia) {
      const r = preverIA(t ?? Date.now() + 25_000);
      if (r.length) return r;
    }
    const agora = Date.now();
    const recentes = [...hist].sort((x, y) => y.em - x.em);
    const ativos = [];
    const vistos = new Set();
    for (const h of recentes) {
      if (agora - h.em > JANELA_ATIVOS_MS && ativos.length) break;
      const k = String(h.nick).toLowerCase();
      if (vistos.has(k)) continue;
      vistos.add(k);
      ativos.push(h.nick);
      if (agora - h.em > JANELA_ATIVOS_MS) break; // sem ninguém na última hora: fica só com o mais recente
    }
    let pool = ativos;
    const fila = filaInfo && agora - filaInfo.em < 10 * 60 * 1000 ? filaInfo.n : null; // inclui você
    if (fila && fila >= 2) pool = pool.slice(0, Math.max(1, fila - 1));
    if (!pool.length) return [];
    // Sequência: quantas vezes, na mesma sessão, cada um veio logo depois do último adversário.
    const seq = [...hist].sort((x, y) => x.em - y.em);
    const depois = new Map();
    for (let i = 0; i + 1 < seq.length; i++) {
      if (seq[i + 1].em - seq[i].em > 2 * 3600 * 1000 || !mesmoNick(seq[i].nick, ultimoNick)) continue;
      const k = String(seq[i + 1].nick).toLowerCase();
      depois.set(k, (depois.get(k) ?? 0) + 1);
    }
    const base = fila ? `fila com ${fila}` : 'ativos na última hora';
    if (pool.length === 1) return [{ nick: pool[0], p: 1, base }];
    // Quem você acabou de enfrentar fica com uma fatia fixa (pode voltar, mas é o menos provável);
    // os outros dividem o resto, com peso pela sequência (até 3× para quem sempre vem depois dele).
    const repete = pool.some((n) => mesmoNick(n, ultimoNick));
    const outros = pool.filter((n) => !mesmoNick(n, ultimoNick));
    const fatiaOutros = repete ? 1 - pesoRepetir : 1;
    const pesos = outros.map((nick) => [nick, 1 + Math.min(2, depois.get(String(nick).toLowerCase()) ?? 0)]);
    const soma = pesos.reduce((t, [, w]) => t + w, 0);
    const lista = pesos.map(([nick, w]) => ({ nick, p: fatiaOutros * (w / soma), base }));
    if (repete) lista.push({ nick: pool.find((n) => mesmoNick(n, ultimoNick)), p: pesoRepetir, base });
    return lista.sort((a, b) => b.p - a.p);
  }

  // ---------------------------------------------------------------- IA: quem vem agora
  // Medido no seu histórico: o jogo NUNCA repete o adversário antes de 10 min (bloqueio da fila) e,
  // quando o bloqueio acaba e os dois estão buscando, junta de novo na hora (181 revanches com 10
  // min cravados). Então quem pode vir é quem está ATIVO e LIVRE (bloqueio vencido). O modelo:
  //   peso = livre? × recência (quem jogou com você há pouco está buscando) × ativo na ladder
  //          (V/D subiu há pouco) × perto de você na ladder (±3 posições)
  // e a decisão é refeita no TEMPO: logo antes de cada bloqueio acabar. Backtest no histórico:
  // ~76% de acerto no 1º palpite (a regra antiga acertava ~19%).
  const ladderVivo = new Map(); // nick minúsculo → { pos, jogos, mudouEm, vistoEm }
  let minhaPosicao = null;       // a SUA posição no ranqueado (pvp.info → posicao) — a ladder só traz o topo
  function anotarLadder(lista) {
    const agora = Date.now();
    for (const l of lista) {
      const k = String(l.nick ?? l.nome ?? '').toLowerCase();
      if (!k) continue;
      const jogos = (Number(l.vitorias) || 0) + (Number(l.derrotas) || 0);
      const a = ladderVivo.get(k);
      ladderVivo.set(k, { pos: Number(l.pos) || null, jogos, mudouEm: a && jogos > a.jogos ? agora : (a?.mudouEm ?? 0), vistoEm: agora, desde: a?.desde ?? agora });
    }
  }
  /** O bloqueio de revanche, medido: o menor intervalo entre dois duelos seguidos contra o mesmo (5–20 min). */
  function bloqueioMs() {
    const ultimo = new Map();
    let menor = Infinity;
    for (const h of [...hist].sort((a, b) => a.em - b.em)) {
      const k = String(h.nick).toLowerCase();
      if (ultimo.has(k)) menor = Math.min(menor, h.em - ultimo.get(k));
      ultimo.set(k, h.em);
    }
    return Number.isFinite(menor) ? Math.max(5 * 60_000, Math.min(20 * 60_000, menor - 5_000)) : 10 * 60_000;
  }
  /**
   * A distribuição de quem vem num instante `t` (padrão: daqui a 25 s). Candidatos: quem jogou com
   * você na última hora e quem está mexendo na ladder perto de você.
   */
  function preverIA(t = Date.now() + 25_000) {
    const bloq = bloqueioMs();
    // A sua posição: a da ladder (se você está no topo listado) ou a que o jogo manda à parte.
    // Sem saber onde você está, ninguém da ladder entra — ela só lista o topo, e quem está longe
    // do topo nunca enfrenta aquela gente.
    const minhaPos = ladderVivo.get(meuNick().toLowerCase())?.pos ?? minhaPosicao;
    const cand = new Map(); // k → { nick, ultimoEm }
    for (const h of hist) {
      if (t - h.em > 60 * 60_000) continue;
      const k = String(h.nick).toLowerCase();
      if (!cand.has(k) || cand.get(k).ultimoEm < h.em) cand.set(k, { nick: h.nick, ultimoEm: h.em });
    }
    for (const [k, l] of ladderVivo) {
      if (cand.has(k) || k === meuNick().toLowerCase() || !l.mudouEm || t - l.mudouEm > 15 * 60_000) continue;
      if (!minhaPos || !l.pos || Math.abs(minhaPos - l.pos) > 3) continue;
      const nick = ladder.find((x) => String(x.nick ?? '').toLowerCase() === k)?.nick ?? k;
      const ultimo = [...hist].filter((h) => String(h.nick).toLowerCase() === k).sort((a, b) => b.em - a.em)[0];
      cand.set(k, { nick, ultimoEm: ultimo?.em ?? 0 });
    }
    const lista = [];
    for (const [k, c] of cand) {
      const desde = t - c.ultimoEm;
      const livre = desde >= bloq;
      let w = (livre ? 1 : 0.01) * (1 + 0.5 * Math.exp(-desde / (30 * 60_000)));
      const l = ladderVivo.get(k);
      if (l?.mudouEm && t - l.mudouEm < 15 * 60_000) w *= 1.5;          // está jogando agora
      else if (l && Date.now() - l.desde > 30 * 60_000 && !l.mudouEm) w *= 0.6; // olhamos 30 min e ele não jogou
      if (minhaPos && l?.pos) w *= Math.abs(minhaPos - l.pos) <= 3 ? 1.4 : 0.5;
      lista.push({ nick: c.nick, w, livreEm: c.ultimoEm + bloq, livre, base: livre ? 'livre' : `bloqueado até ${new Date(c.ultimoEm + bloq).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` });
    }
    const soma = lista.reduce((a, x) => a + x.w, 0);
    if (!soma) return [];
    return lista.map((x) => ({ ...x, p: x.w / soma })).sort((a, b) => b.p - a.p);
  }
  /** Backtest no seu histórico: % de acerto no 1º palpite (IA no instante da partida) e da regra antiga. */
  function backtestIA() {
    const asc = [...hist].sort((a, b) => a.em - b.em);
    const bloq = bloqueioMs();
    let n = 0, ia = 0, antiga = 0;
    for (let i = 5; i < asc.length; i++) {
      const t = asc[i].em;
      if (t - asc[i - 1].em > 30 * 60_000) continue;
      const vistos = new Map();
      for (let j = i - 1; j >= 0 && t - asc[j].em <= 60 * 60_000; j--) { const k = String(asc[j].nick).toLowerCase(); if (!vistos.has(k)) vistos.set(k, asc[j].em); }
      if (!vistos.size) continue;
      n++;
      const real = String(asc[i].nick).toLowerCase();
      const top = [...vistos].map(([k, em]) => [k, ((t - em) >= bloq ? 1 : 0.01) * (1 + 0.5 * Math.exp(-(t - em) / (30 * 60_000)))]).sort((a, b) => b[1] - a[1])[0][0];
      if (top === real) ia++;
      const ult = String(asc[i - 1].nick).toLowerCase();
      const outros = [...vistos.keys()].filter((k) => k !== ult);
      if ((outros.length ? outros[0] : ult) === real) antiga++;
    }
    return n ? { n, ia: ia / n, antiga: antiga / n, bloqMin: bloq / 60_000 } : null;
  }

  // ---------------------------------------------------------------- agente de IA externo
  // A decisão vai para um modelo (OpenAI/Anthropic) configurado em "🤖 Agente IA" na barra do app.
  // A página não tem a chave: pede pelo preload (postMessage) e o processo principal chama a API.
  const CHAVE_CADERNO = 'pokepvp.agente.caderno';
  let caderno = (() => { try { return localStorage.getItem(CHAVE_CADERNO) ?? ''; } catch { return ''; } })();
  let agenteStatus = '';
  // Os eventos do agente (aba 🤖 Agente): decisões, falhas, caderno — e, na partida seguinte, o resultado.
  const CHAVE_EVENTOS = 'pokepvp.agente.eventos.v1';
  let eventosAgente = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_EVENTOS)) ?? []; } catch { return []; } })();
  const salvarEventos = () => { try { localStorage.setItem(CHAVE_EVENTOS, JSON.stringify(eventosAgente.slice(0, 300))); } catch {} };
  function anotarAgente(ev) {
    eventosAgente.unshift({ em: Date.now(), ...ev });
    eventosAgente = eventosAgente.slice(0, 300);
    salvarEventos();
    if (estaAberto() && aba === 'agente') pintar();
  }
  /** A partida que chegou responde à última decisão do agente ainda sem resultado. */
  function conferirAgente(reg) {
    const d = eventosAgente.find((e) => (e.tipo === 'decisão' || e.tipo === 'manteve') && e.pendente);
    if (!d) return;
    d.pendente = false;
    d.veio = reg.nick;
    d.venceu = !!reg.venci;
    d.acertou = d.previstos?.length ? mesmoNick(d.previstos[0].nick, reg.nick) : null;
    const lutou = idsDoDuelo(reg)?.join(',');
    d.usou = lutou && d.k ? lutou === d.k : null;
    salvarEventos();
  }
  function perguntarAgente(pedido, ms = 14_000) {
    return new Promise((res) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const fim = (r) => { window.removeEventListener('message', ouvir); clearTimeout(t); res(r); };
      const ouvir = (ev) => { if (ev.source === window && ev.data?.__pbIAResp?.id === id) fim(ev.data.__pbIAResp); };
      const t = setTimeout(() => fim({ ok: false, erro: 'a IA demorou demais' }), ms + 2000);
      window.addEventListener('message', ouvir);
      window.postMessage({ __pbIA: { id, pedido: { ...pedido, timeoutMs: ms } } }, '*');
    });
  }
  const SISTEMA_AGENTE = `Você é o técnico de PvP de um jogador de PokéIdle. Regras do PvP do jogo: duelo 5×5 automático, os pokémon entram em SEQUÊNCIA (quem vence fica em campo com o HP que sobrou e enfrenta o próximo), então a ORDEM é a comp. Tipos e golpes decidem cada 1×1. A fila junta jogadores próximos na ladder (±3 posições); o jogo NUNCA repete o mesmo adversário antes de ~10 min e, quando esse bloqueio acaba e os dois estão buscando, junta de novo na hora. Você recebe: quem deve ser o próximo adversário (com chance e se está livre/bloqueado), o hábito de cada um (repete a comp, usa 2 comps, mesmos pokémon em ordens diferentes, com quem abre), as formações candidatas (ordem exata) com o placar REAL contra cada provável e a nota do modelo estatístico, as regras do próprio jogador (respeite-as) e o seu caderno de lições. Escolha UMA formação entre as candidatas, pensando em quem vem e no que ele costuma usar. Placar real pesa mais que a nota do modelo; poucos jogos = pouca certeza. Responda SÓ JSON: {"formacao":"<id exato da candidata>","motivo":"<1-2 frases em português>","confianca":<0 a 1>}.`;

  function estadoParaAgente(reg, previstos, notas, forcar) {
    const ultimasDele = (nick) => hist.filter((h) => mesmoNick(h.nick, nick) && h.dele?.length).sort((a, b) => b.em - a.em).slice(0, 3)
      .map((h) => `${h.venci ? 'V' : 'D'}: ${h.dele.map((x) => x.nome).join(' > ')}`);
    return {
      jogador: meuNick(),
      ultimaPartida: { rival: reg.nick, resultado: reg.venci ? 'vitória' : 'derrota', minhaOrdem: (reg.meu ?? []).map((x) => x.nome), ordemDele: (reg.dele ?? []).map((x) => x.nome) },
      proximosProvaveis: previstos.slice(0, 4).map((x) => ({ nick: x.nick, chance: `${Math.round(x.p * 100)}%`, situacao: x.base ?? '', voceGanhaDele: `${Math.round((1 - dificuldade(x.nick)) * 100)}%`,
        habito: habitoDe(x.nick)?.txt ?? 'variado', abreCom: aberturaDe(x.nick)?.nome ?? null, ultimasCompsDele: ultimasDele(x.nick), regras: regrasContra(x.nick).map((r) => `${r.poke} ${r.nao ? '≠' : '='} ${r.pos}`) })),
      formacaoAtual: chaveAtual(),
      trocaObrigatoria: !!forcar,
      candidatas: notas.slice(0, 8).map((n) => ({ id: n.f.k, ordem: nomesDosIds(n.f.ids), geral: `${n.f.v}V ${n.f.n - n.f.v}D`,
        contraProvaveis: Object.fromEntries(previstos.slice(0, 3).map((x) => { const pv = placarVs(n.f.k, x.nick); return [x.nick, pv.n ? `${pv.v}V ${pv.n - pv.v}D` : 'nunca']; })),
        notaModelo: Math.round(n.nota * 100), porqueModelo: n.det.slice(0, 3) })),
      cadernoDeLicoes: caderno || '(vazio — primeira partida com o agente)',
    };
  }

  /** Depois de cada partida: o agente reescreve o caderno de lições com o que aconteceu. */
  async function atualizarCaderno(reg) {
    if (!cfg.auto.agente) return;
    const t = trocas.find((x) => !x.pendente && x.veio && mesmoNick(x.veio, reg.nick));
    const r = await perguntarAgente({
      sistema: 'Você mantém o caderno de lições de PvP de um jogador de PokéIdle (duelo 5×5 em sequência; a ORDEM é a comp). Reescreva o caderno incorporando a partida nova: lições CONCRETAS por rival (que ordem ganhou/perdeu contra qual comp dele, quem do time dele te derruba, padrões de fila/horário). Mantenha o que continua valendo, corrija o que a partida desmentiu, no máximo 1200 caracteres, em português. Responda SÓ JSON: {"caderno":"<texto>"}.',
      usuario: JSON.stringify({ cadernoAtual: caderno || '(vazio)', partida: { rival: reg.nick, resultado: reg.venci ? 'vitória' : 'derrota', minhaOrdem: (reg.meu ?? []).map((x) => x.nome), ordemDele: (reg.dele ?? []).map((x) => x.nome), naoEntrouDele: (reg.naoEntrou ?? []).map((x) => x.nome) },
        decisaoAnterior: t ? { acao: t.acao, previsto: t.previstos?.[0]?.nick ?? null, acertouPrevisao: t.acertou, motivo: t.motivo } : null,
        placarGeralContraEle: (() => { const d = hist.filter((h) => mesmoNick(h.nick, reg.nick)); return `${d.filter((h) => h.venci).length}V ${d.filter((h) => !h.venci).length}D`; })() }),
      maxTokens: 700,
    }, 25_000);
    if (r.ok && typeof r.resposta?.caderno === 'string') {
      caderno = r.resposta.caderno.slice(0, 2000);
      try { localStorage.setItem(CHAVE_CADERNO, caderno); } catch {}
      registrar('🤖 agente: caderno de lições atualizado');
      anotarAgente({ tipo: 'caderno', motivo: `caderno reescrito depois de ${reg.venci ? 'vencer' : 'perder para'} ${reg.nick} (${caderno.length} caracteres)` });
    } else if (!r.ok) { registrar(`🤖 agente: não atualizou o caderno (${r.erro})`); anotarAgente({ tipo: 'falha', motivo: `caderno: ${r.erro}` }); }
    if (estaAberto()) pintar();
  }

  /** O placar de uma formação contra um jogador, no seu histórico. */
  function placarVs(k, nick) {
    let n = 0, v = 0;
    for (const h of hist) {
      if (!mesmoNick(h.nick, nick)) continue;
      const ids = idsDoDuelo(h);
      if (ids?.join(',') !== k) continue;
      n++; if (h.venci) v++;
    }
    return { n, v };
  }

  /**
   * Quão boa uma formação deve ser contra um jogador: o placar real contra ele (com prior); sem
   * jogo contra ele, a simulação guardada (vale no máximo 0,6 — a simulação já errou feio contra o
   * real, então nunca passa à frente de um placar real bom); sem nada, a
   * taxa geral da formação, um pouco descontada (não se sabe nada do confronto).
   */
  function notaVs(f, nick) {
    const pv = placarVs(f.k, nick);
    if (pv.n) return { nota: (pv.v + 1) / (pv.n + 2), fonte: `${pv.v}V ${pv.n - pv.v}D contra ele` };
    const salvo = melhores[String(nick).toLowerCase()];
    for (const o of [salvo?.ordem?.r, ...(salvo?.bolsa?.r ?? [])].filter(Boolean)) {
      if (idsDe(o)?.join(',') === f.k) return { nota: 0.4 + 0.2 * (o.vitorias / Math.max(1, o.total)), fonte: `simulação: vence ${o.vitorias}/${o.total}` };
    }
    for (const o of melhores.__ativos__?.r ?? []) {
      const pr = o.porRival?.find((x) => mesmoNick(x.nick, nick));
      if (pr && idsDe(o)?.join(',') === f.k) return { nota: 0.4 + 0.2 * (pr.vitorias / Math.max(1, pr.total)), fonte: `simulação: vence ${pr.vitorias}/${pr.total}` };
    }
    return { nota: notaF(f) * 0.9, fonte: `geral ${f.v}V ${f.n - f.v}D` };
  }

  /** As candidatas: suas formações na rotação + a melhor comp simulada contra o próximo provável. */
  function candidatasPara(previstos) {
    const todas = minhasFormacoes();
    const lista = todas.filter((f) => naRotacao(f));
    const naBolsa = new Set((core.eu?.pokemons ?? []).map((p) => p.id));
    for (const o of melhores.__ativos__?.r ?? []) {
      const ids = idsDe(o);
      if (!ids || ids.length < timeCheio() || !ids.every((id) => naBolsa.has(id))) continue;
      const k = ids.join(',');
      if (lista.some((f) => f.k === k)) continue;
      lista.push(todas.find((f) => f.k === k) ?? { k, ids, n: 0, v: 0, ultimo: 0, armario: null, simulada: true, nome: 'Contra os ativos' });
    }
    for (const { nick } of previstos.slice(0, 3)) {
      const salvo = melhores[String(nick).toLowerCase()];
      for (const o of [salvo?.ordem?.r, ...(salvo?.bolsa?.r ?? []).slice(0, 1)].filter(Boolean)) {
        const ids = idsDe(o);
        if (!ids || ids.length < timeCheio() || !ids.every((id) => naBolsa.has(id))) continue;
        const k = ids.join(',');
        if (lista.some((f) => f.k === k)) continue;
        const ja = todas.find((f) => f.k === k);
        lista.push(ja ?? { k, ids, n: 0, v: 0, ultimo: 0, armario: null, simulada: true, nome: `Anti ${nick}` });
      }
    }
    return lista;
  }

  /** Nota de cada candidata contra a distribuição dos próximos prováveis. */
  /**
   * Quão difícil é um adversário para você, de 0 (ganha sempre) a 1 (perde sempre), pelo placar
   * geral contra ele (com prior 1V 1D). Quem você já vence com qualquer comp pesa pouco na escolha.
   */
  function dificuldade(nick) {
    let n = 0, v = 0;
    for (const h of hist) if (mesmoNick(h.nick, nick)) { n++; if (h.venci) v++; }
    return 1 - (v + 1) / (n + 2);
  }
  /** O peso de um adversário na escolha: a chance de ele vir × (com o foco ligado) quão difícil ele é. */
  const pesoNaEscolha = (x) => (cfg.auto.focoAmeacas ? x.p * (0.3 + 1.4 * dificuldade(x.nick)) : x.p);

  function pontuar(f, previstos) {
    let soma = 0, peso = 0;
    const det = [];
    for (const x of previstos.slice(0, 4)) {
      const { nick } = x;
      const p = pesoNaEscolha(x);
      const r = notaVs(f, nick);
      soma += p * r.nota; peso += p;
      det.push(`${nick}: ${r.fonte}`);
    }
    return { nota: peso ? soma / peso : notaF(f), det };
  }

  // ---------------------------------------------------------------- histórico de trocas
  // Cada decisão do auto-switch (trocou / manteve / sem opção) e, na partida SEGUINTE, o que
  // aconteceu: quem veio, se a previsão acertou, se a formação escolhida foi a que lutou e se ganhou.
  const CHAVE_TROCAS = 'pokepvp.trocas.v1';
  let trocas = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_TROCAS)) ?? []; } catch { return []; } })();
  const salvarTrocas = () => { try { localStorage.setItem(CHAVE_TROCAS, JSON.stringify(trocas.slice(0, 200))); } catch {} };

  function anotarTroca(reg, x) {
    trocas.unshift({
      em: Date.now(), depoisDe: reg.nick, venceuAnterior: !!reg.venci, modo: cfg.auto.modo,
      previstos: (x.previstos ?? []).slice(0, 3).map((y) => ({ nick: y.nick, p: y.p })),
      acao: x.acao, de: x.de ?? null, para: x.para ?? null, paraK: x.paraK ?? chaveAtual(), motivo: x.motivo ?? '', pendente: true,
    });
    trocas = trocas.slice(0, 200);
    salvarTrocas();
  }

  /** A partida que acabou de chegar responde à última decisão pendente. */
  function conferirTroca(reg) {
    const t = trocas.find((x) => x.pendente);
    if (!t) return;
    t.pendente = false;
    t.veio = reg.nick;
    t.venceu = !!reg.venci;
    t.acertou = t.previstos?.length ? mesmoNick(t.previstos[0].nick, reg.nick) : null;
    const lutou = idsDoDuelo(reg)?.join(',');
    t.aplicada = lutou && t.paraK ? lutou === t.paraK : null;
    salvarTrocas();
  }

  function autoSwitch(reg) {
    const a = cfg.auto;
    if (!a.ativo) return;
    if (a.modo === 'prever') return autoSwitchPrevendo(reg);
    const todas = minhasFormacoes();
    const atual = todas.find((f) => f.k === chaveAtual());
    const nomeAtual = atual ? `"${atual.nome}" (${atual.v}V ${atual.n - atual.v}D)` : 'a equipe atual';
    let motivo = null;
    if (reg.venci) {
      a.seguidas = (a.seguidas ?? 0) + 1;
      if (a.seguidas >= Math.max(1, Number(a.vitorias) || 1)) motivo = `${a.seguidas} vitória(s) seguida(s) — o rival deve counterar`;
      else { registrar(`auto-switch: vitória ${a.seguidas}/${a.vitorias} com ${nomeAtual} — mantém`); anotarTroca(reg, { acao: 'manteve', de: atual?.nome, para: atual?.nome, motivo: `vitória ${a.seguidas}/${a.vitorias}` }); }
    } else {
      a.seguidas = 0;
      if (a.naDerrota) motivo = 'derrota';
    }
    if (!motivo) { salvarCfg(); return; }
    const candidatas = todas.filter((f) => naRotacao(f) && f.k !== chaveAtual()).sort(ordemDeEscolha);
    if (!candidatas.length) {
      anotarTroca(reg, { acao: 'sem opção', de: atual?.nome, motivo });
      registrar(`auto-switch: queria trocar (${motivo}), mas você ainda não tem outra formação usada ${a.minUso}+ vezes`);
      salvarCfg();
      return;
    }
    const prox = candidatas[0];
    if (aplicarEquipe(prox.ids, `auto-switch: ${motivo}`)) {
      a.usoEm[prox.k] = Date.now();
      a.seguidas = 0;
      reg.trocouDepois = true;
      salvarHist();
      registrar(`🔁 auto-switch: ${nomeAtual} → "${prox.nome}" (${prox.v}V ${prox.n - prox.v}D)`);
      anotarTroca(reg, { acao: 'trocou', de: atual?.nome, para: prox.nome, paraK: prox.k, motivo });
      avisar(`🔁 Auto-switch: agora "${prox.nome}" — ${prox.v}V ${prox.n - prox.v}D (${motivo})`);
    }
    salvarCfg();
  }

  // ---------------------------------------------------------------- counter do counter
  const PESO_ANTI = 0.6;          // na nota final: 60% "vence o counter do time que jogou", 40% placar real
  const TEMPO_ANTI_MS = 12_000;   // o jogo puxa a próxima partida ~20 s depois: a conta tem que caber antes

  /** O time do rival naquele duelo (quem entrou + quem não entrou). */
  const timeDoRival = (h) => [...(h.dele ?? []), ...(h.naoEntrou ?? [])].map((x) => ({ nome: x.nome, nivel: x.nivel }));

  /**
   * O que cada rival provável deve montar contra o time que você acabou de jogar (A), e a nota de
   * cada formação sua contra esses counters. Reais primeiro: os times que ele já usou contra o A,
   * o que usou na partida seguinte depois de enfrentar o A e, se ele acabou de te vencer, o time
   * que venceu (ele não muda o que funcionou). O resto é simulado no analise.js.
   */
  /**
   * O hábito de comp do rival nos últimos duelos com ordem conhecida: quem REPETE a mesma (60%+ a
   * mais usada — ex.: Zator, Erva) ou vive de DUAS (75%+ nas duas mais usadas — ex.: Alan). Nesses
   * casos o que ele vai usar é o que ele já usa, não um counter simulado.
   */
  function habitoDe(nick) {
    const recentes = hist.filter((h) => mesmoNick(h.nick, nick) && !h.deleSemOrdem && (h.dele?.length ?? 0) >= 3)
      .sort((a, b) => b.em - a.em).slice(0, 12);
    if (recentes.length < 3) return null;
    const conta = new Map();
    for (const h of recentes) {
      const k = h.dele.map((x) => x.nome).join('>');
      const c = conta.get(k) ?? { time: timeDoRival(h), n: 0 };
      c.n++;
      conta.set(k, c);
    }
    const tops = [...conta.values()].sort((a, b) => b.n - a.n);
    const n = recentes.length;
    if (tops[0].n / n >= 0.6) return { tipo: 'repete', comps: [tops[0].time], txt: `repete a mesma comp (${tops[0].n}/${n})` };
    if (tops[1] && (tops[0].n + tops[1].n) / n >= 0.75) return { tipo: 'duas', comps: [tops[0].time, tops[1].time], txt: `usa 2 comps (${tops[0].n + tops[1].n}/${n})` };
    // Mesmos pokémon em ordens diferentes (ex.: Zator, Alan): conta pelo CONJUNTO e prevê as 3
    // ordens mais usadas dele.
    const conj = new Map();
    for (const h of recentes) {
      const k = [...new Set(timeDoRival(h).map((x) => x.nome))].sort().join('|');
      conj.set(k, (conj.get(k) ?? 0) + 1);
    }
    const [, nConj] = [...conj.entries()].sort((a, b) => b[1] - a[1])[0];
    if (nConj / n >= 0.6) return { tipo: 'mesmos', comps: tops.slice(0, 3).map((t) => t.time), txt: `sempre os mesmos pokémon (${nConj}/${n}), ${conta.size} ordens` };
    return null;
  }

  /** "erva: Blastoise=último; Venusaur≠último" → regras da SUA ordem contra aquele rival. */
  function regrasContra(nick) {
    const out = [];
    for (const linha of String(cfg.auto.regrasRival ?? '').split(/\n|\|/)) {
      const [quem, resto] = linha.split(':');
      if (!resto || !quem.trim() || !String(nick ?? '').toLowerCase().includes(quem.trim().toLowerCase())) continue;
      for (const r of resto.split(';')) {
        const m = r.trim().match(/^(.+?)\s*(=|≠|!=)\s*(último|ultimo|primeiro|\d)$/i);
        if (m) out.push({ poke: m[1].trim().toLowerCase(), nao: m[2] !== '=', pos: m[3].toLowerCase() });
      }
    }
    return out;
  }
  /** Quantas regras a formação cumpre (+) ou quebra (−) contra o rival. */
  function placarRegras(f, nick) {
    const regras = regrasContra(nick);
    if (!regras.length) return null;
    const nomes = nomesDosIds(f.ids).map((x) => String(x).toLowerCase());
    let ok = 0, ruim = 0;
    for (const r of regras) {
      const i = nomes.findIndex((n) => n.includes(r.poke));
      if (i < 0) continue;
      const alvo = r.pos.startsWith('ult') ? nomes.length - 1 : r.pos === 'primeiro' ? 0 : Number(r.pos) - 1;
      const bate = i === alvo;
      if (bate !== r.nao) ok++; else ruim++;
    }
    return { ok, ruim, total: regras.length };
  }

  async function calcularAntiCounter(reg, previstos, cand) {
    const an = window.__pokeAnalise;
    if (!an?.contraDoCounter) return null;
    const timeA = meuTimeIds?.length ? [...meuTimeIds] : idsDoDuelo(reg); // a equipe salva = a que acabou de jogar (o switch ainda não trocou)
    if (!timeA?.length) return null;
    const kA = timeA.join(',');
    const rivais = previstos.slice(0, 3).map((x) => {
      const deles = hist.filter((h) => mesmoNick(h.nick, x.nick)).sort((a, b) => a.em - b.em);
      const vistos = [];
      for (const h of deles) for (const pk of timeDoRival(h)) if (!vistos.some((v) => v.nome === pk.nome)) vistos.push(pk);
      const conhecidos = [];
      deles.forEach((h, i) => {
        if (idsDoDuelo(h)?.join(',') !== kA) return;
        if (!h.venci) conhecidos.push(timeDoRival(h));             // ele bateu o A com este time
        if (deles[i + 1]) conhecidos.push(timeDoRival(deles[i + 1])); // a resposta dele depois de ver o A
      });
      if (mesmoNick(reg.nick, x.nick) && !reg.venci) conhecidos.unshift(timeDoRival(reg));
      // Hábito forte (repete / 2 comps): o que ele vai usar é o que ele já usa.
      const hab = habitoDe(x.nick);
      if (hab) return { nick: x.nick, peso: pesoNaEscolha(x), vistos, conhecidos: hab.comps.filter((t) => t.length >= 2), soConhecidos: true };
      return { nick: x.nick, peso: pesoNaEscolha(x), vistos, conhecidos: conhecidos.filter((t) => t.length >= 2).slice(0, 4) };
    });
    try {
      const r = await Promise.race([
        an.contraDoCounter({ timeA, rivais, candidatas: cand.map((f) => ({ k: f.k, ids: f.ids })) }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('demorou demais')), TEMPO_ANTI_MS)),
      ]);
      cfg.auto.ultimoAnti = { em: Date.now(), timeA: nomesDosIds(timeA), counters: r.counters, avisos: (r.avisos ?? []).slice(0, 4) };
      return r;
    } catch (e) {
      registrar(`counter do counter: não deu (${e.message}) — escolhendo só pelo histórico`);
      return null;
    }
  }

  /**
   * Modo "prever": depois de CADA partida, olha quem deve vir agora (pela sequência de adversários)
   * e põe a formação que mais ganha dele. Com "counter do counter" ligado, a nota principal é
   * vencer o time que ESSES rivais montariam para counterar o que você acabou de jogar.
   * Só troca se a escolhida for melhor que a atual.
   */
  let rodadaSwitch = 0;

  /**
   * Com que pokémon o rival costuma abrir: o 1º da ordem real (da fita) nos duelos contra você.
   * Só conta se for um hábito: 3+ duelos com ordem e o mesmo abridor em 60%+ deles.
   */
  function aberturaDe(nick) {
    const conta = new Map();
    let n = 0;
    for (const h of hist) {
      if (!mesmoNick(h.nick, nick) || h.deleSemOrdem || !h.dele?.length) continue;
      n++;
      const x = h.dele[0];
      const k = String(x.nome).toLowerCase();
      const c = conta.get(k) ?? { nome: x.nome, nivel: x.nivel, vezes: 0 };
      c.vezes++;
      conta.set(k, c);
    }
    const top = [...conta.values()].sort((a, b) => b.vezes - a.vezes)[0];
    return top && n >= 3 && top.vezes / n >= 0.6 ? { ...top, de: n } : null;
  }

  /**
   * Depois de escolher a formação: se o próximo provável tem abertura fixa (ex.: Zator → Venusaur),
   * põe na frente quem do time vence esse 1×1 (ex.: Camerupt); o resto fica na mesma ordem.
   */
  async function ajustarAbertura(previstos, minha) {
    const an = window.__pokeAnalise;
    const alvo = previstos[0];
    if (!cfg.auto.abertura || !an?.melhorAbertura || !alvo || alvo.p < 0.4 || !meuTimeIds?.length) return;
    const ab = aberturaDe(alvo.nick);
    if (!ab) return;
    try {
      const r = await an.melhorAbertura({ ids: [...meuTimeIds], abertura: ab, rivalNick: alvo.nick });
      if (minha !== rodadaSwitch) return;
      // O real vale mais que a simulação: quem do time já abriu contra ele e venceu 60%+ (2+ duelos) vai na frente.
      const nomesTime = nomesDosIds(meuTimeIds).map((x) => String(x).toLowerCase());
      const real = new Map();
      for (const h of hist) {
        if (!mesmoNick(h.nick, alvo.nick) || !h.meu?.length) continue;
        const k = String(h.meu[0].nome).toLowerCase();
        const c = real.get(k) ?? { n: 0, v: 0 };
        c.n++; if (h.venci) c.v++;
        real.set(k, c);
      }
      const doReal = [...real.entries()].filter(([k, c]) => c.n >= 2 && c.v / c.n >= 0.6 && nomesTime.includes(k))
        .sort((a, b) => (b[1].v + 1) / (b[1].n + 2) - (a[1].v + 1) / (a[1].n + 2))[0];
      if (doReal) {
        const i = nomesTime.indexOf(doReal[0]);
        Object.assign(r, { ids: [meuTimeIds[i], ...meuTimeIds.filter((_, j) => j !== i)], lider: nomesDosIds([meuTimeIds[i]])[0], nota: 99, notaAtual: i === 0 ? 99 : 0, real: `${doReal[1].v}V ${doReal[1].n - doReal[1].v}D abrindo contra ele` });
      }
      const txt = `${alvo.nick} abre de ${ab.nome} (${ab.vezes} de ${ab.de})`;
      if (r.ids[0] === meuTimeIds[0] || r.nota < 1 || r.nota < r.notaAtual * 1.1) {
        registrar(`abertura: ${txt} — ${r.ids[0] === meuTimeIds[0] ? `${r.lider} já abre` : `ninguém do time vence ele com folga melhor que o atual`}`);
        return;
      }
      if (aplicarEquipe(r.ids, `abertura contra ${ab.nome} de ${alvo.nick}`)) {
        registrar(`🎯 abertura: ${txt} → ${r.lider} na frente (${r.real ?? (r.nota >= 99 ? 'vence o 1×1 sem tomar dano' : `vence o 1×1 ${r.nota.toFixed(1)}× mais rápido`)})`);
        avisar(`🎯 ${alvo.nick} abre de ${ab.nome}: ${r.lider} vai na frente`);
        if (hist[0]) { hist[0].trocouDepois = true; salvarHist(); }
        const t = trocas.find((x) => x.pendente); // a decisão pendente passa a apontar para a ordem nova
        if (t) { t.paraK = r.ids.join(','); t.motivo = `${t.motivo ? `${t.motivo} · ` : ''}abertura: ${r.lider} na frente`; salvarTrocas(); }
      }
    } catch (e) { registrar(`abertura: não deu (${e.message})`); }
  }

  /** Rivais de "manter se vencer" (ex.: Erva — repete a comp): depois de VENCER dele, não troca. */
  const manterContra = (nick) => String(cfg.auto.manterSeVencer ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    .some((x) => String(nick ?? '').toLowerCase().includes(x));

  let reavaliacoes = [];
  async function autoSwitchPrevendo(reg) {
    const minha = ++rodadaSwitch;
    for (const t of reavaliacoes.splice(0)) clearTimeout(t);
    const r0 = await escolherFormacao(reg, minha);
    if (minha === rodadaSwitch && r0 !== 'manter') await ajustarAbertura(preverProximo(reg.nick), minha);
    if (!cfg.auto.reavaliarFila) return;
    const idAgora = hist[0]?.id;
    if (cfg.auto.ia) {
      // IA: refaz a escolha 25 s antes de cada bloqueio de revanche acabar (é quando aquele
      // adversário passa a poder vir — e o jogo junta na hora se os dois estiverem buscando).
      const agora = Date.now();
      const vencendo = preverIA(agora + 20 * 60_000).filter((x) => x.livreEm > agora).map((x) => x.livreEm).sort((a, b) => a - b).slice(0, 4);
      for (const em of vencendo) {
        reavaliacoes.push(setTimeout(async () => {
          if (minha !== rodadaSwitch || hist[0]?.id !== idAgora || !cfg.auto.ativo) return;
          const t = em + 5_000;
          const prev = preverProximo(reg.nick, PESO_REPETIR, t);
          registrar(`📈 previsão: bloqueio de revanche acabando — previsão para ${new Date(t).toLocaleTimeString('pt-BR')}: ${prev.slice(0, 3).map((x) => `${x.nick} ${Math.round(x.p * 100)}%`).join(', ')}`);
          const r1 = await escolherFormacao(reg, minha, { reavaliando: true, t });
          if (minha === rodadaSwitch && r1 !== 'manter') await ajustarAbertura(preverProximo(reg.nick, PESO_REPETIR, t), minha);
        }, Math.max(0, em - 25_000 - agora)));
      }
      return;
    }
    // Sem IA: a busca demorando = pouca gente na fila → reavalia em 60 s e 120 s com mais peso no último.
    for (const [ms, peso] of [[60_000, 0.5], [120_000, 0.75]]) {
      reavaliacoes.push(setTimeout(async () => {
        if (minha !== rodadaSwitch || hist[0]?.id !== idAgora || !cfg.auto.ativo) return;
        registrar(`auto-switch: a busca está demorando (${ms / 1000} s) — ${reg.nick} fica com ${Math.round(peso * 100)}% de chance de vir de novo`);
        await escolherFormacao(reg, minha, { pesoRepetir: peso, reavaliando: true });
        if (minha === rodadaSwitch) await ajustarAbertura(preverProximo(reg.nick, peso), minha);
      }, ms));
    }
  }

  /** Rivais de "sempre trocar" (lista separada por vírgula; vale parte do nick: "alan" pega "xAlanx"). */
  const sempreTrocarContra = (nick) => String(cfg.auto.sempreTrocar ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
    .some((x) => String(nick ?? '').toLowerCase().includes(x));

  async function escolherFormacao(reg, minha, opc = {}) {
    const previstos = preverProximo(reg.nick, opc.pesoRepetir ?? PESO_REPETIR, opc.t ?? null);
    if (!previstos.length) {
      registrar('auto-switch: ainda não há adversários suficientes no histórico para prever o próximo');
      anotarTroca(reg, { acao: 'sem opção', motivo: 'sem adversários ativos no histórico' });
      return;
    }
    // "Manter após vencer" (ex.: Erva, que repete a comp): se ELE é o próximo provável e a última
    // contra ele foi vitória, joga a comp que venceu — fica nela ou volta para ela.
    const topo = previstos[0];
    if (topo && topo.p >= 0.5 && manterContra(topo.nick)) {
      const ultimaVs = hist.filter((h) => mesmoNick(h.nick, topo.nick)).sort((a, b) => b.em - a.em)[0];
      const ids = ultimaVs?.venci ? idsDoDuelo(ultimaVs) : null;
      if (ids?.length >= Math.min(TIME_PVP, (core.eu?.pokemons ?? []).length)) {
        if (ids.join(',') === chaveAtual()) {
          registrar(`auto-switch: próximo deve ser ${topo.nick} (${Math.round(topo.p * 100)}%) — a equipe atual venceu ele na última, FICA`);
          anotarTroca(reg, { acao: 'manteve', previstos, motivo: `${topo.nick}: a comp que venceu ele fica` });
        } else if (aplicarEquipe(ids, `${topo.nick} vem aí — volta a comp que venceu ele`)) {
          reg.trocouDepois = true; salvarHist();
          registrar(`🔁 auto-switch: próximo deve ser ${topo.nick} — voltei para a comp que venceu ele na última: ${nomesDosIds(ids).join(' → ')}`);
          anotarTroca(reg, { acao: 'trocou', previstos, para: nomesDosIds(ids).join(' → '), paraK: ids.join(','), motivo: `${topo.nick} repete a comp: volta a que venceu` });
          avisar(`🔁 ${topo.nick} vem aí: voltei para a comp que venceu ele`);
        }
        return 'manter';
      }
    }
    const cand = candidatasPara(previstos);
    const atual = cand.find((f) => f.k === chaveAtual()) ?? minhasFormacoes().find((f) => f.k === chaveAtual());
    const anti = cfg.auto.contraCounter ? await calcularAntiCounter(reg, previstos, cand) : null;
    // Abertura: contra quem sempre abre igual, formação com resposta clara ao abridor ganha bônus.
    const bonusAb = new Map();
    const ab0 = cfg.auto.abertura && previstos[0] ? aberturaDe(previstos[0].nick) : null;
    if (ab0 && window.__pokeAnalise?.melhorAbertura) {
      for (const f of cand) {
        try {
          const r = await window.__pokeAnalise.melhorAbertura({ ids: f.ids, abertura: ab0, rivalNick: previstos[0].nick });
          const b = r.nota >= 2 ? 0.08 : r.nota >= 1 ? 0.04 : 0;
          if (b) bonusAb.set(f.k, { b: b * previstos[0].p, lider: r.lider });
        } catch {}
      }
    }
    if (minha !== rodadaSwitch) return; // chegou outra partida enquanto calculava: ela decide
    const nota = (f) => {
      const r0 = pontuar(f, previstos);
      const ba = bonusAb.get(f.k);
      let r = ba ? { nota: r0.nota + ba.b, det: [...r0.det, `${ba.lider} responde ao ${ab0.nome} de ${previstos[0].nick}`] } : r0;
      // Regras suas por rival (ex.: contra o Erva, Blastoise em último e Venusaur antes do fim).
      for (const x of previstos.slice(0, 3)) {
        const pr = placarRegras(f, x.nick);
        if (!pr) continue;
        const delta = 0.1 * x.p * (pr.ok - pr.ruim);
        if (delta) r = { nota: r.nota + delta, det: [...r.det, `regras vs ${x.nick}: ${pr.ok}/${pr.total}`] };
      }
      const a = anti?.notas?.[f.k];
      if (!a) return r;
      return { nota: PESO_ANTI * a.nota + (1 - PESO_ANTI) * r.nota,
        det: [`vence ${Math.round(a.nota * 100)}% dos counters previstos (${a.porRival.map((x) => `${x.nick} ${x.vence}%`).join(', ')})`, ...r.det] };
    };
    if (anti?.counters?.length) {
      const c0 = anti.counters[0];
      registrar(`🧠 counter previsto de ${c0.nick} contra o seu time: ${c0.x.join(' → ')} (${c0.fonte})`);
    }
    // Troca obrigatória: perdeu (com "trocar após derrota") OU jogou contra um dos rivais de
    // "sempre trocar" (Zator, Alan…), ganhando ou perdendo — ele já viu esse time e vai counterar.
    // A ORDEM que jogou sai. Outra ordem dos mesmos 5 conta como troca: no PvP a ordem é a comp, e
    // quem usa sempre os mesmos 5 pokémon (o seu caso) ficava sem nenhuma opção.
    const sempre = !opc.reavaliando && sempreTrocarContra(reg.nick);
    const forcar = !opc.reavaliando && ((!reg.venci && cfg.auto.naDerrota) || sempre);
    const notas = cand.filter((f) => !forcar || f.k !== chaveAtual())
      .map((f) => ({ f, ...nota(f) })).sort((x, y) => y.nota - x.nota);
    let melhor = notas[0];
    const notaAtual = atual ? nota(atual).nota : 0;
    // 🤖 Agente externo: escolhe entre as candidatas (as regras do jogador já foram aplicadas antes).
    let doAgente = null;
    if (cfg.auto.agente && notas.length) {
      agenteStatus = 'pensando…';
      const t0 = Date.now();
      const r = await perguntarAgente({ sistema: SISTEMA_AGENTE, usuario: JSON.stringify(estadoParaAgente(reg, previstos, notas, forcar)), maxTokens: 300 });
      const ms = Date.now() - t0;
      const prevResumo = previstos.slice(0, 3).map((x) => ({ nick: x.nick, p: Math.round(x.p * 100), base: x.base ?? '' }));
      const quando = opc.reavaliando ? 'antes do bloqueio acabar' : `depois de ${reg.venci ? 'vencer' : 'perder para'} ${reg.nick}`;
      if (minha !== rodadaSwitch) { anotarAgente({ tipo: 'descartada', quando, ms, motivo: 'chegou outra partida enquanto ele pensava' }); return; }
      const id = String(r.resposta?.formacao ?? '');
      const esc = r.ok ? notas.find((n) => n.f.k === id) : null;
      if (esc) {
        doAgente = { motivo: String(r.resposta.motivo ?? '').slice(0, 240), confianca: Number(r.resposta.confianca) || null, modelo: r.modelo };
        melhor = { ...esc, det: [`🤖 ${doAgente.motivo}`, ...esc.det] };
        agenteStatus = `${r.modelo}: escolheu ${esc.f.nome}`;
        anotarAgente({ tipo: 'decisão', quando, ms, modelo: r.modelo, previstos: prevResumo, de: atual?.nome ?? null, escolha: nomesDosIds(esc.f.ids).join(' → '), k: esc.f.k,
          doModelo: notas[0]?.f.k === esc.f.k ? 'igual à do modelo' : `modelo preferia ${notas[0]?.f.nome ?? '—'}`, motivo: doAgente.motivo, confianca: doAgente.confianca, forcada: !!forcar, pendente: true });
      } else if (r.ok && !forcar && id === chaveAtual()) {
        agenteStatus = `${r.modelo}: manter a atual`;
        anotarAgente({ tipo: 'manteve', quando, ms, modelo: r.modelo, previstos: prevResumo, escolha: atual?.nome ?? 'a atual', k: chaveAtual(), motivo: String(r.resposta.motivo ?? '').slice(0, 240), confianca: Number(r.resposta.confianca) || null, pendente: true });
        registrar(`🤖 agente: manter a equipe atual — ${String(r.resposta.motivo ?? '').slice(0, 200)}`);
        anotarTroca(reg, { acao: 'manteve', previstos, de: atual?.nome, para: atual?.nome, motivo: `🤖 agente: ${String(r.resposta.motivo ?? '').slice(0, 200)}` });
        return;
      } else {
        agenteStatus = r.ok ? `respondeu uma formação que não existe (${id}) — vale o modelo` : `falhou: ${r.erro} — vale o modelo`;
        anotarAgente({ tipo: 'falha', quando, ms, modelo: r.modelo ?? null, motivo: agenteStatus, escolha: `modelo: ${notas[0]?.f.nome ?? '—'}` });
        registrar(`🤖 agente: ${agenteStatus}`);
      }
    }
    if (cfg.auto.ultimoAnti && anti) { cfg.auto.ultimoAnti.escolhida = melhor?.f.nome ?? null; salvarCfg(); }
    const quem = previstos.slice(0, 2).map((x) => `${x.nick} (${Math.round(x.p * 100)}%)`).join(', ');
    if (forcar && !melhor) {
      registrar(`auto-switch: ${reg.venci ? 'venceu' : 'perdeu para'} ${reg.nick} e queria trocar, mas não há outra formação na rotação para entrar`);
      anotarTroca(reg, { acao: 'sem opção', previstos, de: atual?.nome, motivo: `${sempre ? `jogou contra ${reg.nick}` : 'derrota'}, mas sem outra formação` });
      return;
    }
    if (!forcar && (!melhor || melhor.f.k === chaveAtual() || (!doAgente && melhor.nota < notaAtual + 0.02))) {
      registrar(`auto-switch: próximo provável ${quem} — a equipe atual já é a melhor para ele${atual ? ` (${nota(atual).det[0] ?? ''})` : ''}`);
      anotarTroca(reg, { acao: 'manteve', previstos, de: atual?.nome, para: atual?.nome, motivo: 'a atual já é a melhor contra eles' });
      return;
    }
    if (aplicarEquipe(melhor.f.ids, forcar ? `${reg.venci ? 'vitória sobre' : 'derrota para'} ${reg.nick}` : `próximo provável: ${previstos[0].nick}`)) {
      cfg.auto.usoEm[melhor.f.k] = Date.now();
      reg.trocouDepois = true;
      salvarHist();
      salvarCfg();
      const porque = `${forcar ? `${sempre ? `jogou contra ${reg.nick} (${reg.venci ? 'venceu' : 'perdeu'}) — ele vai counterar, o time saiu` : `perdeu para ${reg.nick} — a formação que perdeu saiu`} · ` : ''}${melhor.det.join(' · ')}`;
      registrar(`🔮 auto-switch: próximo provável ${quem} → "${melhor.f.nome}" (${porque})`);
      anotarTroca(reg, { acao: 'trocou', previstos, de: atual?.nome, para: melhor.f.nome, paraK: melhor.f.k, motivo: porque });
      avisar(doAgente ? `🤖 Agente trocou para "${melhor.f.nome}" (vem ${previstos[0].nick}) — ${doAgente.motivo}` : `🔮 Próximo deve ser ${previstos[0].nick}${anti ? ' (contra o counter dele)' : ''}: troquei para "${melhor.f.nome}"`);
    }
  }

  const idsDe = (o) => (o?.ordem?.length && o.ordem.every((p) => p.id != null) ? o.ordem.map((p) => p.id) : null);
  /** Os botões "aplicar agora" e "salvar no armário" de uma ordem sugerida. */
  function botoesAplicar(o, nome) {
    const ids = idsDe(o);
    if (!ids) return '<small class="ppvp-aviso">(tem pokémon estimado — não dá para aplicar)</small>';
    const v = esc(JSON.stringify({ ids, nome }));
    return `<button class="ppvp-bt ppvp-mini" data-a="aplicar" data-v="${v}">✅ aplicar agora</button><button class="ppvp-bt ppvp-mini" data-a="armario" data-v="${v}">💾 salvar no armário</button>`;
  }

  let calcAtivos = null; // 'ordem' | 'bolsa' | { erro } enquanto calcula
  let formAberta = null;  // formação com o "contra quem" aberto

  /** O placar de uma formação por jogador: contra quem ela foi mais útil (e contra quem falhou). */
  function htmlContraQuem(f) {
    const porNick = new Map();
    for (const h of hist) {
      if (idsDoDuelo(h)?.join(',') !== f.k) continue;
      const k = String(h.nick).toLowerCase();
      const r = porNick.get(k) ?? { nick: h.nick, n: 0, v: 0, delta: 0, ultimo: 0 };
      r.n++; if (h.venci) r.v++; r.delta += h.delta || 0; r.ultimo = Math.max(r.ultimo, h.em);
      porNick.set(k, r);
    }
    const lista = [...porNick.values()].sort((a, b) => b.v - a.v || pct(b.v, b.n) - pct(a.v, a.n) || a.n - b.n);
    if (!lista.length) return '<div class="ppvp-sug ppvp-aviso">Sem duelos registrados com esta formação no histórico (o placar dela vem do armário do jogo).</div>';
    return `<div class="ppvp-sug"><b>👥 Contra quem "${esc(f.nome)}" foi mais útil</b>
      <table class="ppvp-tab" style="margin-top:4px"><tr><th>Jogador</th><th>Duelos</th><th>V-D</th><th>%</th><th>Pontos</th><th>Última vez</th></tr>
      ${lista.map((r) => `<tr><td><b>${esc(r.nick)}</b></td><td>${r.n}</td><td><span class="ppvp-v">${r.v}</span>-<span class="ppvp-d">${r.n - r.v}</span></td>
        <td>${pctHtml(r.v, r.n)}</td><td class="${r.delta >= 0 ? 'ppvp-v' : 'ppvp-d'}">${r.delta >= 0 ? '+' : ''}${r.delta}</td><td>${dataCurta(r.ultimo)}</td></tr>`).join('')}
      </table></div>`;
  }
  /** Simula as ordens (da equipe atual, ou da bolsa) contra TODOS os ativos de uma vez, com os pesos. */
  async function calcularContraAtivos(tipo) {
    if (!window.__pokeAnalise?.sugerirContraVarios) { calcAtivos = { erro: 'o módulo 📊 Time não está carregado nesta conta' }; return pintar(); }
    const ultimo = [...hist].sort((x, y) => y.em - x.em)[0];
    const previstos = ultimo ? preverProximo(ultimo.nick).slice(0, 4) : [];
    if (!previstos.length) { calcAtivos = { erro: 'ainda não há adversários ativos no histórico' }; return pintar(); }
    calcAtivos = tipo;
    pintar();
    const meus = minhaOrdemSalva().length ? minhaOrdemSalva() : (ultimo?.meu ?? []);
    try {
      const r = await window.__pokeAnalise.sugerirContraVarios({
        meus: meus.map((x) => ({ id: x.id, nome: x.nome, nivel: x.nivel })),
        rivais: previstos.map((x) => {
          const u = ultimoDuelo(x.nick);
          return { nick: x.nick, peso: pesoNaEscolha(x), ordemRival: u && !u.deleSemOrdem ? (u.dele ?? []) : [] };
        }),
        buscarNaBolsa: tipo === 'bolsa',
      });
      melhores.__ativos__ = { nick: '__ativos__', em: Date.now(), tipo, nicks: r.rivais, r: r.opcoes, avisos: r.avisos };
      salvarMelhores();
      calcAtivos = null;
      registrar(`🔬 melhor comp contra os ativos (${r.rivais.map((x) => `${x.nick} ${Math.round(x.peso * 100)}%`).join(', ')}): ${r.opcoes[0]?.ordem.map((p) => p.nome).join(' → ') ?? '—'}`);
    } catch (e) {
      calcAtivos = { erro: e.message };
    }
    pintar();
  }

  function htmlAtivosCalculado() {
    const s = melhores.__ativos__;
    if (!s?.r?.length) return '';
    return `<div style="margin-top:6px"><b>🔬 Melhor contra os ativos</b> <small class="ppvp-aviso">(${s.tipo === 'bolsa' ? 'da bolsa' : 'sua equipe'} · ${dataCurta(s.em)} · ${s.nicks.map((x) => `${esc(x.nick)} ${Math.round(x.peso * 100)}%`).join(', ')})</small>
      ${s.r.map((o, i) => `<div>${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} ${ordemCurta(o)} — ${o.porRival.map((x) => `${esc(x.nick)}: <b class="${x.vitorias === x.total ? 'ppvp-v' : x.vitorias ? '' : 'ppvp-d'}">${x.vitorias}/${x.total}</b>`).join(' · ')}
        <br>${botoesAplicar(o, `Contra ativos${i ? ` ${i + 1}` : ''}`)}</div>`).join('')}</div>`;
  }

  /** O quadro do modo "prever": quem deve vir, e qual formação vai melhor contra cada um. */
  function htmlPrevisao(todas) {
    const ultimo = [...hist].sort((x, y) => y.em - x.em)[0];
    if (!ultimo) return '<p class="ppvp-aviso">Jogue alguns duelos para o app conhecer a sequência de adversários.</p>';
    const previstos = preverProximo(ultimo.nick).slice(0, 4);
    if (!previstos.length) return `<p class="ppvp-aviso">Último adversário: <b>${esc(ultimo.nick)}</b> — ainda não há outros adversários recentes para prever o próximo.</p>`;
    const cand = candidatasPara(previstos);
    const melhorPara = (nick) => cand.map((f) => ({ f, r: notaVs(f, nick) })).sort((x, y) => y.r.nota - x.r.nota)[0];
    const geral = cand.map((f) => ({ f, ...pontuar(f, previstos) })).sort((x, y) => y.nota - x.nota)[0];
    return `<div class="ppvp-destaque" style="background:#2a2a4a;border-color:#8a8aff">
        🔮 Último adversário: <b>${esc(ultimo.nick)}</b> (${ultimo.venci ? '<span class="ppvp-v">venceu</span>' : '<span class="ppvp-d">perdeu</span>'}) · ativos na fila e chance de vir agora:
        ${previstos.map((x) => { const d = dificuldade(x.nick); return `<b>${esc(x.nick)}</b> ${Math.round(x.p * 100)}% <small class="${d > 0.55 ? 'ppvp-d' : d < 0.35 ? 'ppvp-v' : ''}">(você ganha ${Math.round((1 - d) * 100)}%${d > 0.55 ? ' · ameaça' : ''}${(() => { const ab = aberturaDe(x.nick); return ab ? ` · abre de ${esc(ab.nome)} ${ab.vezes}/${ab.de}` : ''; })()}${(() => { const h = habitoDe(x.nick); return h ? ` · ${esc(h.txt)}` : ''; })()})</small>`; }).join(' · ')}
        <small class="ppvp-aviso">(${cfg.auto.ia ? `🤖 IA: ${previstos.slice(0, 4).map((x) => `${esc(x.nick)} ${esc(x.base)}`).join(' · ')}` : `${esc(previstos[0].base)}; quem acabou de lutar com você pesa menos`})</small>
        <table class="ppvp-tab" style="margin-top:4px"><tr><th>Contra</th><th>Melhor formação</th><th>Por quê</th></tr>
        ${previstos.map((x) => { const m = melhorPara(x.nick); return `<tr><td><b>${esc(x.nick)}</b></td><td>${m ? esc(m.f.nome) + (m.f.simulada ? ' <small class="ppvp-aviso">(simulada)</small>' : '') : '—'}</td><td>${m ? esc(m.r.fonte) : '—'}</td></tr>`; }).join('')}
        </table>
        ${geral ? `<div>Melhor contra o grupo (ponderado): <b>${esc(geral.f.nome)}</b>${geral.f.k === chaveAtual() ? ' <small class="ppvp-v">(já em uso)</small>' : ''}</div>` : ''}
        ${(() => { const u = cfg.auto.ultimoAnti; if (!u) return ''; return `<div style="margin-top:4px">🧠 <b>Counter do counter</b> <small>(${quando(u.em)})</small> — você jogou ${esc(u.timeA.join(' → '))}. Counters previstos:
          ${u.counters.map((c) => `<br>· <b>${esc(c.nick)}</b>: ${esc(c.x.join(' → '))} <small class="ppvp-aviso">(${esc(c.fonte)})</small>`).join('')}
          ${u.escolhida ? `<br>➜ escolhida: <b>${esc(u.escolhida)}</b>` : ''}${u.avisos?.length ? `<br><small class="ppvp-aviso">${esc(u.avisos.join(' · '))}</small>` : ''}</div>`; })()}
        <div style="margin-top:4px">
          <button class="ppvp-bt ppvp-mini" data-a="calcAtivos" data-v="ordem" ${calcAtivos && !calcAtivos.erro ? 'disabled' : ''}>${calcAtivos === 'ordem' ? 'calculando…' : '🔬 melhor ordem do meu time contra os ativos'}</button>
          <button class="ppvp-bt ppvp-mini" data-a="calcAtivos" data-v="bolsa" ${calcAtivos && !calcAtivos.erro ? 'disabled' : ''}>${calcAtivos === 'bolsa' ? 'procurando…' : '🔬 melhor comp da bolsa contra os ativos'}</button>
          ${calcAtivos?.erro ? `<span class="ppvp-d">${esc(calcAtivos.erro)}</span>` : ''}
        </div>
        ${htmlAtivosCalculado()}
      </div>`;
  }

  let trocasVerTodas = false;
  function htmlTrocas() {
    const feitas = trocas.filter((t) => !t.pendente);
    const comPrev = feitas.filter((t) => t.acertou != null);
    const acertos = comPrev.filter((t) => t.acertou).length;
    const trocou = feitas.filter((t) => t.acao === 'trocou');
    const vTrocou = trocou.filter((t) => t.venceu).length;
    const aplicadas = trocou.filter((t) => t.aplicada === true).length;
    const naoAplic = trocou.filter((t) => t.aplicada === false).length;
    const vTudo = hist.filter((h) => h.venci).length;
    const lista = trocasVerTodas ? trocas : trocas.slice(0, 12);
    const sim = (b) => (b == null ? '—' : b ? '<span class="ppvp-v">✔</span>' : '<span class="ppvp-d">✘</span>');
    return `
      <h4>Histórico de trocas do auto-switch ${trocas.length ? '<button class="ppvp-bt ppvp-mini" data-a="limparTrocas">limpar</button>' : ''}</h4>
      ${feitas.length ? `<div class="ppvp-linha">
        Decisões conferidas: <b>${feitas.length}</b>
        · previsão do próximo acertou: <b>${comPrev.length ? `${acertos}/${comPrev.length} (${pct(acertos, comPrev.length)}%)` : '—'}</b>
        · depois de trocar, venceu: <b>${trocou.length ? `${vTrocou}/${trocou.length}` : '—'}</b> ${trocou.length ? pctHtml(vTrocou, trocou.length) : ''}
        · vitória geral: ${pctHtml(vTudo, hist.length)}
        ${naoAplic ? `· <span class="ppvp-d">⚠ ${naoAplic} troca(s) não chegaram a valer na partida seguinte</span>` : aplicadas ? `· trocas valeram na partida seguinte: <b class="ppvp-v">${aplicadas}/${trocou.length}</b>` : ''}
      </div>` : ''}
      ${lista.length ? `<table class="ppvp-tab"><tr><th>Quando</th><th>Depois de</th><th>Previu</th><th>Decisão</th><th>Veio</th><th>Previsão</th><th>Troca valeu</th><th>Resultado</th></tr>
        ${lista.map((t) => `<tr>
          <td>${dataCurta(t.em)}</td>
          <td>${esc(t.depoisDe)} <small class="${t.venceuAnterior ? 'ppvp-v' : 'ppvp-d'}">${t.venceuAnterior ? 'V' : 'D'}</small></td>
          <td>${t.previstos?.length ? t.previstos.map((y) => `${esc(y.nick)} ${Math.round(y.p * 100)}%`).join(', ') : '<small class="ppvp-aviso">rotação</small>'}</td>
          <td style="white-space:normal">${t.acao === 'trocou' ? `🔁 ${esc(t.de ?? 'equipe atual')} → <b>${esc(t.para)}</b>` : t.acao === 'manteve' ? `manteve <b>${esc(t.para ?? 'a equipe')}</b>` : '<span class="ppvp-aviso">sem opção</span>'}<br><small class="ppvp-aviso">${esc(t.motivo)}</small></td>
          <td>${t.pendente ? '<small class="ppvp-aviso">aguardando a próxima partida…</small>' : esc(t.veio)}</td>
          <td>${t.pendente ? '' : sim(t.acertou)}</td>
          <td>${t.pendente || t.acao === 'sem opção' ? '' : sim(t.aplicada)}</td>
          <td>${t.pendente ? '' : t.venceu ? '<b class="ppvp-v">venceu</b>' : '<b class="ppvp-d">perdeu</b>'}</td></tr>`).join('')}</table>
        ${trocas.length > 12 ? `<button class="ppvp-bt ppvp-mini" data-a="verTrocas">${trocasVerTodas ? 'ver menos' : `ver todas (${trocas.length})`}</button>` : ''}`
        : '<p class="ppvp-aviso">Nenhuma decisão ainda — com o auto-switch ligado, cada partida registra aqui o que ele decidiu e, na seguinte, se deu certo.</p>'}`;
  }

  let paginaAgente = 0;
  function htmlAgente() {
    const dec = eventosAgente.filter((e) => (e.tipo === 'decisão' || e.tipo === 'manteve') && !e.pendente && e.veio);
    const v = dec.filter((e) => e.venceu).length;
    const acertos = dec.filter((e) => e.acertou).length;
    const falhas = eventosAgente.filter((e) => e.tipo === 'falha').length;
    const difModelo = dec.filter((e) => e.doModelo && e.doModelo !== 'igual à do modelo');
    const vDif = difModelo.filter((e) => e.venceu).length;
    const ms = eventosAgente.filter((e) => e.ms).map((e) => e.ms);
    const msMed = ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length / 100) / 10 : null;
    const POR = 15;
    const paginas = Math.max(1, Math.ceil(eventosAgente.length / POR));
    paginaAgente = Math.min(paginaAgente, paginas - 1);
    const pag = eventosAgente.slice(paginaAgente * POR, (paginaAgente + 1) * POR);
    const icone = { 'decisão': '🔁', manteve: '⏸', falha: '⚠', caderno: '📓', descartada: '↩' };
    const resultado = (e) => (e.tipo !== 'decisão' && e.tipo !== 'manteve') ? '' : e.pendente ? '<span class="ppvp-aviso">aguardando a partida</span>'
      : `vs <b>${esc(e.veio)}</b> ${e.venceu ? '<span class="ppvp-v">venceu</span>' : '<span class="ppvp-d">perdeu</span>'}${e.acertou === true ? ' · previsão ✅' : e.acertou === false ? ' · previsão ❌' : ''}${e.usou === false ? ' · <small class="ppvp-aviso">a equipe mudou antes</small>' : ''}`;
    return `<section>
        <div class="ppvp-linha">
          <button class="ppvp-sw ${cfg.auto.agente ? 'on' : ''}" data-a="autoAgenteSw"></button>
          <b>🤖 agente de IA decide nesta conta</b>
          <span class="ppvp-aviso">${esc(agenteStatus || (cfg.auto.agente ? 'aguardando a próxima decisão' : 'desligado'))}</span>
          <span style="flex:1"></span>
          ${eventosAgente.length ? '<button class="ppvp-bt ppvp-mini" data-a="limparEventos">limpar registro</button>' : ''}
        </div>
        <div class="ppvp-linha" style="gap:14px">
          <span>Decisões com resultado: <b>${dec.length}</b></span>
          <span>Vitórias depois delas: <b class="${dec.length && v * 2 >= dec.length ? 'ppvp-v' : 'ppvp-d'}">${dec.length ? `${v}/${dec.length} (${Math.round((v / dec.length) * 100)}%)` : '—'}</b></span>
          <span>Previsão do próximo: <b>${dec.length ? `${Math.round((acertos / dec.length) * 100)}%` : '—'}</b></span>
          <span title="decisões em que o agente escolheu diferente do modelo estatístico">Quando discordou do modelo: <b>${difModelo.length ? `${vDif}/${difModelo.length} vitórias` : '—'}</b></span>
          <span>Falhas: <b>${falhas}</b></span>
          <span>Tempo médio: <b>${msMed != null ? `${msMed} s` : '—'}</b></span>
        </div>
        <details><summary class="ppvp-aviso">📓 caderno de lições (${caderno.length} caracteres)</summary><pre class="ppvp-log" style="max-height:220px">${esc(caderno || 'vazio — ele escreve depois da próxima partida')}</pre>${caderno ? '<button class="ppvp-bt ppvp-mini" data-a="limparCaderno">limpar caderno</button>' : ''}</details>
      </section>
      <section>
        ${pag.length ? `<table class="ppvp-tab"><tr><th>Quando</th><th></th><th>Situação</th><th>Previsão</th><th>Escolha</th><th>Motivo</th><th>Resultado</th></tr>
          ${pag.map((e) => `<tr>
            <td>${quando(e.em)}${e.ms ? `<small> · ${(e.ms / 1000).toFixed(1)} s</small>` : ''}</td>
            <td title="${esc(e.tipo)}">${icone[e.tipo] ?? '·'}</td>
            <td style="white-space:normal">${esc(e.quando ?? '')}${e.forcada ? ' <small class="ppvp-aviso">(troca obrigatória)</small>' : ''}</td>
            <td style="white-space:normal">${(e.previstos ?? []).map((x) => `${esc(x.nick)} ${x.p}%`).join('<br>')}</td>
            <td style="white-space:normal">${esc(e.escolha ?? '')}${e.doModelo ? `<br><small class="ppvp-aviso">${esc(e.doModelo)}</small>` : ''}${e.confianca != null ? `<br><small>confiança ${Math.round(e.confianca * 100)}%</small>` : ''}</td>
            <td style="white-space:normal;max-width:300px">${esc(e.motivo ?? '')}${e.modelo ? `<br><small class="ppvp-aviso">${esc(e.modelo)}</small>` : ''}</td>
            <td style="white-space:normal">${resultado(e)}</td></tr>`).join('')}</table>
          ${paginas > 1 ? `<div class="ppvp-linha"><button class="ppvp-bt" data-a="pagAgente" data-v="-1" ${paginaAgente === 0 ? 'disabled' : ''}>‹</button><span>página ${paginaAgente + 1} de ${paginas}</span><button class="ppvp-bt" data-a="pagAgente" data-v="1" ${paginaAgente >= paginas - 1 ? 'disabled' : ''}>›</button></div>` : ''}`
          : `<span class="ppvp-aviso">Nada ainda. ${cfg.auto.agente ? 'A primeira decisão sai depois da próxima partida (ou 25 s antes de um bloqueio de revanche acabar).' : 'Ligue o agente acima — e confira se ele está "Ligado" no 🤖 Agente IA da barra do app, com a chave salva.'}</span>`}
      </section>`;
  }

  function htmlFormacoes() {
    const a = cfg.auto;
    const todas = minhasFormacoes().sort((x, y) => y.n - x.n || notaF(y) - notaF(x));
    const atual = todas.find((f) => f.k === chaveAtual());
    const rot = todas.filter((f) => naRotacao(f));
    const prox = rot.filter((f) => f.k !== chaveAtual()).sort(ordemDeEscolha)[0];
    const linhas = todas.map((f) => {
      const elegivel = f.n >= Math.max(1, Number(a.minUso) || 1) || f.armario;
      return `<tr class="${f === atual ? 'ppvp-em-uso' : ''}">
        <td><input type="checkbox" data-a="autoFora" data-v="${esc(f.k)}" ${a.foraKeys.includes(f.k) ? '' : 'checked'} ${elegivel ? '' : 'disabled'} title="entra na rotação do auto-switch"></td>
        <td><b>${esc(f.nome)}</b>${f === atual ? ' <small class="ppvp-v">● em uso</small>' : ''}${f === prox && a.ativo && a.modo !== 'prever' ? ' <small class="ppvp-top">próxima</small>' : ''}
          <br><small class="ppvp-aviso">${f.armario ? `armário (vaga ${f.armario.slot})` : 'do seu histórico'}${elegivel ? '' : ` · poucos jogos (mín. ${a.minUso})`}</small></td>
        <td style="white-space:normal">${nomesDosIds(f.ids).map((x, i) => `<b style="color:#f3c77a">${i + 1}</b> ${esc(x)}`).join(' → ')}</td>
        <td>${f.n ? `<span class="ppvp-v">${f.v}</span>-<span class="ppvp-d">${f.n - f.v}</span> · ${pctHtml(f.v, f.n)}` : '<span class="ppvp-aviso">sem jogos</span>'}</td>
        <td>${f.ultimo || a.usoEm[f.k] ? dataCurta(Math.max(f.ultimo, a.usoEm[f.k] ?? 0)) : '—'}</td>
        <td><button class="ppvp-bt ppvp-mini" data-a="usarForm" data-v="${esc(f.k)}" ${f === atual ? 'disabled' : ''}>usar agora</button>
          <button class="ppvp-bt ppvp-mini" data-a="contraQuem" data-v="${esc(f.k)}">👥 ${formAberta === f.k ? 'fechar' : 'contra quem'}</button></td></tr>
        ${formAberta === f.k ? `<tr><td colspan="6">${htmlContraQuem(f)}</td></tr>` : ''}`;
    }).join('');
    return `
      <section>
        <div class="ppvp-linha">
          <button class="ppvp-sw ${a.ativo ? 'on' : ''}" data-a="autoAtivo"></button>
          <b>Auto-switch de formações</b>
          <span class="ppvp-aviso">troca a equipe de PvP sozinho entre as formações que você costuma usar, para antecipar o counter do rival</span>
        </div>
        <div class="ppvp-linha">
          <b style="color:#f3c77a;font-size:11px;text-transform:uppercase">Modo</b>
          <button class="ppvp-bt ${a.modo === 'prever' ? 'ppvp-on' : ''}" data-a="autoModo" data-v="prever">🔮 prever o próximo adversário</button>
          <button class="ppvp-bt ${a.modo !== 'prever' ? 'ppvp-on' : ''}" data-a="autoModo" data-v="rotacao">🔁 rotação simples</button>
        </div>
        ${a.modo === 'prever' ? htmlPrevisao(todas) : ''}
        <div class="ppvp-linha">
          <span ${a.modo === 'prever' ? 'style="display:none"' : ''}>trocar depois de <input type="number" class="ppvp-in" data-c="autoVitorias" min="1" max="10" value="${esc(a.vitorias)}"> vitória(s) seguida(s)</span>
          <label title="depois de VENCER destes, o time fica (eles repetem a comp) — só troca após derrota. Vírgula separa; vale parte do nick.">manter a equipe após vencer: <input class="ppvp-in" data-c="manterSeVencer" value="${esc(a.manterSeVencer ?? '')}" style="width:120px" spellcheck="false"></label>
          <label title="regras da SUA ordem contra um rival. Formato: rival: Pokémon=último; Pokémon≠último; Pokémon=1 — uma linha por rival">regras por rival: <textarea class="ppvp-in" data-c="regrasRival" rows="2" style="width:330px;vertical-align:middle" spellcheck="false">${esc(a.regrasRival ?? '')}</textarea></label>
          <label title="pede a decisão ao agente de IA configurado em 🤖 Agente IA (barra de cima do app); se ele falhar ou demorar, vale o modelo estatístico"><input type="checkbox" data-a="autoAgente" ${a.agente ? 'checked' : ''}> 🤖 agente de IA decide${agenteStatus ? ` <small>(${esc(agenteStatus)})</small>` : ''}</label>
          ${a.agente ? `<details style="width:100%"><summary class="ppvp-aviso">📓 caderno de lições do agente (${caderno.length} caracteres)</summary><pre class="ppvp-log" style="max-height:200px">${esc(caderno || 'vazio — ele escreve depois da próxima partida')}</pre><button class="ppvp-bt ppvp-mini" data-a="limparCaderno">limpar caderno</button></details>` : ''}
          <label title="prevê o próximo pelo bloqueio de revanche (medido), por quem está ativo e por quem está perto de você na ladder — e refaz a escolha logo antes de cada bloqueio acabar"><input type="checkbox" data-a="autoIA" ${a.ia ? 'checked' : ''}> 🤖 IA de previsão${(() => { const b = backtestIA(); return b ? ` <small>(acerta ${Math.round(b.ia * 100)}% no seu histórico · regra antiga ${Math.round(b.antiga * 100)}% · bloqueio ${b.bloqMin.toFixed(0)} min)</small>` : ''; })()}</label>
          <label title="refaz a escolha no tempo: com a IA, logo antes de cada bloqueio acabar; sem ela, em 60 s e 120 s de busca"><input type="checkbox" data-a="autoReavaliar" ${a.reavaliarFila ? 'checked' : ''}> reavaliar enquanto busca</label>
          <label title="depois de jogar contra estes (vitória OU derrota), o time sempre troca — eles já viram o seu time e vão counterar. Vírgula separa; vale parte do nick.">sempre trocar depois de jogar contra: <input class="ppvp-in" data-c="sempreTrocar" value="${esc(a.sempreTrocar ?? '')}" style="width:160px" spellcheck="false"></label>
          <label title="se o próximo provável sempre abre com o mesmo pokémon, quem vence esse 1×1 vai na frente (o resto mantém a ordem)"><input type="checkbox" data-a="autoAbertura" ${a.abertura ? 'checked' : ''}> abertura (contra quem sempre abre igual, põe na frente quem vence o abridor)</label>
          <label title="quem te enfrentar vai montar um time para bater o que você acabou de jogar; o switch escolhe a formação que vence ESSE time (o counter do counter)"><input type="checkbox" data-a="autoAnti" ${a.contraCounter ? 'checked' : ''}> counter do counter (vencer o time que vão montar contra o que você jogou)</label>
          <label title="dá mais peso aos adversários que costumam te vencer (ex.: quem você perde quase sempre), em vez de tratar todos igual"><input type="checkbox" data-a="autoFoco" ${a.focoAmeacas ? 'checked' : ''}> foco nas ameaças (priorizar comps que ganham de quem te vence)</label>
          <label><input type="checkbox" data-a="autoNaDerrota" ${a.naDerrota ? 'checked' : ''}> sempre trocar depois de uma derrota${a.modo === 'prever' ? ' (a formação que perdeu sai, mesmo que pontue bem contra o grupo)' : ''}</label>
        </div>
        <div class="ppvp-linha">formação conta depois de <input type="number" class="ppvp-in" data-c="autoMinUso" min="1" max="20" value="${esc(a.minUso)}"> duelo(s)</div>
        <p style="margin:4px 0 0">Em uso: <b>${atual ? `${esc(atual.nome)} (${atual.v}V ${atual.n - atual.v}D)` : 'uma equipe ainda sem duelos registrados'}</b>
          ${a.modo === 'prever' ? '' : `· vitórias seguidas: <b>${a.seguidas ?? 0}</b>${prox ? ` · próxima troca: <b>${esc(prox.nome)}</b>` : ''}`}</p>
        <p class="ppvp-aviso" style="margin:4px 0 0">As formações saem sozinhas do seu histórico de duelos: cada escalação exata (mesmos pokémon, mesma ordem) que você usou, com o V-D recontado a cada partida.
          A próxima é a de melhor taxa (com peso para quem tem poucos jogos), sem repetir a atual; empate = a que está há mais tempo sem uso.
          O jogo puxa a próxima partida 20 s depois do fim, então a troca entra antes dela.</p>
      </section>
      <section>
        ${htmlTrocas()}
        <h4>Suas formações (${todas.length}) · na rotação: ${rot.length}</h4>
        ${linhas ? `<table class="ppvp-tab"><tr><th title="na rotação">Rot.</th><th>Formação</th><th>Ordem</th><th>Efetividade</th><th>Último uso</th><th></th></tr>${linhas}</table>`
          : '<span class="ppvp-aviso">Nenhuma formação ainda — elas aparecem aqui conforme você joga PvP.</span>'}
        ${rot.length < 2 ? `<p class="ppvp-aviso"><b>O auto-switch precisa de pelo menos 2 formações na rotação</b> (usadas ${a.minUso}+ vezes). Jogue com outras escalações, diminua o mínimo, ou aplique uma sugestão das abas Rivais/Histórico.</p>` : ''}
      </section>`;
  }

  // ---------------------------------------------------------------- escuta do jogo
  function aoMensagem(ev) {
    if (typeof ev.data !== 'string' || !ev.data.includes('"t":"pvp"')) return;
    if (!/"(partida|naoVistas|ficha|time|timeSalvo|ladder|formacoes|formacaoOk|formacaoRecusa|recusa|fila)"/.test(ev.data)) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t !== 'pvp') return;
    const ids = (x) => (x ?? []).map((v) => (typeof v === 'object' ? v?.id : v)).filter((v) => v != null);
    if (m.time !== undefined) meuTimeIds = ids(m.time);
    if (m.posicao != null) minhaPosicao = Number(m.posicao) || null;
    if (Array.isArray(m.ladder)) { ladder = m.ladder; anotarLadder(m.ladder); if (aba === 'rivais') pintar(); }
    if (m.formacoes !== undefined) formacoes = m.formacoes ?? [];
    if (m.fila?.tamanho != null) filaInfo = { n: Number(m.fila.tamanho) || 0, em: Date.now() };
    if (m.formacaoOk) registrar(`armário: ${m.formacaoOk.acao ?? 'ok'}${m.formacaoOk.slot ? ` (formação ${m.formacaoOk.slot})` : ''}`);
    if (m.formacaoRecusa) registrar(`⚠ o armário recusou: ${m.formacaoRecusa.msg ?? 'sem motivo'}`);
    if (m.recusa) registrar(`⚠ o jogo recusou a troca de equipe: ${m.recusa.msg ?? 'sem motivo'}`);
    if (m.timeSalvo !== undefined) meuTimeIds = ids(m.timeSalvo);
    if (m.time !== undefined || m.timeSalvo !== undefined) consertarTimeIncompleto();
    // A sua ordem pode chegar depois da partida (o jogo pede `pvp.info` logo após): completa a última —
    // a não ser que o auto-switch já tenha trocado a equipe (aí a de agora não é a que lutou).
    if (meuTimeIds?.length && hist[0] && !hist[0].meuCompleto && !hist[0].trocouDepois && Date.now() - hist[0].em < 60_000) {
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
        conferirTroca(reg);
        conferirAgente(reg);
        atualizarCaderno(reg).catch(() => {});
        autoSwitch(reg);
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
  // A IA precisa da ladder fresca (quem está jogando = V/D subindo): pede a cada 2 min.
  const vigiaLadder = setInterval(() => { if (cfg.auto.ativo && cfg.auto.ia && core.logado) core.send({ t: 'pvp.info' }); }, 120_000);
  limpezas.push(() => clearInterval(vigiaLadder));
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
  .ppvp-sug-bt{display:block;margin-top:4px;font-size:11px;padding:2px 8px}
  .ppvp-mini{font-size:11px;padding:2px 7px;margin:2px 4px 0 0}
  .ppvp-tab tr.ppvp-em-uso td{background:#2f4a2a}
  .ppvp-top{background:#b04ad0;color:#fff;border-radius:5px;padding:0 5px;font-weight:700}
  .ppvp-destaque{background:#2f4a2a;border:1px solid #7fdc8f;border-radius:8px;padding:6px 10px;margin-top:6px}
  .ppvp-sug{background:#2a1515;border:1px solid #6a4040;border-radius:10px;padding:8px 10px;white-space:normal}
  .ppvp-sug h5{margin:6px 0 4px;color:#f3c77a;font-size:12px}
  .ppvp-sug ol{margin:2px 0 2px 18px;padding:0;font-size:12px}
  .ppvp-sug .ppvp-op{background:#3a2020;border-radius:8px;padding:6px 8px;margin-top:6px}
  .ppvp-bt.ppvp-on{background:#b04ad0;border-color:#f3c77a;color:#fff}
  .ppvp-auto-bt{font-weight:700}.ppvp-auto-bt.ligado{background:#2f9a4a;border-color:#7fdc8f;color:#fff}.ppvp-auto-bt.pausado{background:#9a7a2f;border-color:#f3c77a;color:#fff}
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
      if (e.target.dataset.c === 'busca') {
        busca = e.target.value; pagina = 0;
        if (aba !== 'rivais') return pintarTabela();
        pintar(); // a aba Rivais é redesenhada inteira: devolve o foco ao campo
        const c = document.querySelector('#ppvp-modal [data-c="busca"]');
        if (c) { c.focus(); c.setSelectionRange(c.value.length, c.value.length); }
      }
    });
    fundo.addEventListener('change', (e) => {
      if (e.target.dataset.c === 'cruzA' || e.target.dataset.c === 'cruzB') { cruz[e.target.dataset.c === 'cruzA' ? 'a' : 'b'] = e.target.value; cruz.calc = null; pintar(); }
      if (e.target.dataset.c === 'manterSeVencer') { cfg.auto.manterSeVencer = e.target.value; salvarCfg(); }
      if (e.target.dataset.c === 'regrasRival') { cfg.auto.regrasRival = e.target.value; salvarCfg(); }
      if (e.target.dataset.c === 'sempreTrocar') { cfg.auto.sempreTrocar = e.target.value; salvarCfg(); }
      if (e.target.dataset.c === 'apSeg') { cfg.autoPvp.maxSeguidas = Math.max(1, Math.min(10, Number(e.target.value) || 3)); salvarCfg(); pintar(); }
      if (e.target.dataset.c === 'apCada') { cfg.autoPvp.checarCada = Math.max(2, Math.min(50, Number(e.target.value) || 10)); salvarCfg(); pintar(); }
      if (e.target.dataset.c === 'derrotas') { cfg.derrotas = Math.max(1, Math.min(10, Number(e.target.value) || 2)); salvarCfg(); pintar(); }
      if (e.target.dataset.c === 'stMinimo') { st.minimo = Math.max(1, Math.min(50, Number(e.target.value) || 1)); pintar(); }
      if (e.target.dataset.c === 'autoMinUso') { cfg.auto.minUso = Math.max(1, Math.min(20, Number(e.target.value) || 2)); salvarCfg(); pintar(); }
      if (e.target.dataset.c === 'autoVitorias') { cfg.auto.vitorias = Math.max(1, Math.min(10, Number(e.target.value) || 1)); salvarCfg(); pintar(); }
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
        somaX(r, String(h.nick).toLowerCase(), h.nick, h.venci); // melhor/pior contra: pelo JOGADOR, não pela comp dele
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
        <td style="white-space:normal">${confronto(e.melhor)}</td><td style="white-space:normal">${confronto(e.pior)}</td>
        <td>${(() => { const h = s.duelos.find((x) => compMinha(x)?.rotulo === r.rotulo && x.meu?.every((p) => p.id != null)); return h ? botoesAplicar({ ordem: h.meu }, `Comp ${pct(r.v, r.n)}%`) : '<small class="ppvp-aviso">—</small>'; })()}</td></tr>`; }).join('');
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
          <label><input type="checkbox" data-a="stOrdem" ${st.porOrdem ? 'checked' : ''}> separar suas comps pela ordem de entrada <small class="ppvp-aviso">(desmarque para juntar as ordens do mesmo time)</small></label>
          <span style="width:12px"></span>
          mínimo de duelos: <input type="number" class="ppvp-in" data-c="stMinimo" min="1" max="50" value="${st.minimo}">
        </div>
        <div class="ppvp-linha"><b>${s.duelos.length}</b> duelos no período · <span class="ppvp-v">${v}V</span> <span class="ppvp-d">${s.duelos.length - v}D</span> · ${pctHtml(v, s.duelos.length)} de vitória</div>
        ${(() => {
          // A comp mais efetiva: maior % de vitória com pelo menos 3 duelos (ou o mínimo escolhido, se maior).
          const min = Math.max(3, st.minimo);
          const cand = [...s.minhas.values()].filter((r) => r.n >= min).sort((a, b) => pct(b.v, b.n) - pct(a.v, a.n) || b.n - a.n);
          return cand.length
            ? `<div class="ppvp-destaque">🏆 <b>Sua comp mais efetiva:</b> ${esc(cand[0].rotulo)} — ${pctHtml(cand[0].v, cand[0].n)} de vitória em ${cand[0].n} duelos (${cand[0].delta >= 0 ? '+' : ''}${cand[0].delta} pontos)</div>`
            : `<div class="ppvp-aviso">🏆 A comp mais efetiva aparece quando alguma tiver pelo menos ${min} duelos no período.</div>`;
        })()}
      </section>
      <section>
        <h4>Suas composições</h4>
        ${tabMinhas ? `<table class="ppvp-tab"><tr><th>Comp</th><th>Duelos</th><th>V-D</th><th>%</th><th>Pontos</th><th>Vai melhor contra (jogador)</th><th>Vai pior contra (jogador)</th><th>Aplicar</th></tr>${tabMinhas}</table>`
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
    const sx = cfg.sessao;
    const abas = `<span class="ppvp-linha" style="margin:0">
        <button class="ppvp-bt ppvp-auto-bt ${sessaoRodando() ? 'ligado' : sx?.estado === 'pausada' ? 'pausado' : ''}" data-a="autoPvp" title="Fila automática + auto-switch. Pausa com ${cfg.autoPvp.maxSeguidas} derrotas seguidas; a cada ${cfg.autoPvp.checarCada} partidas sem saldo positivo, desliga de vez.">⚔ Auto PvP: ${sessaoRodando() ? `RODANDO ${placarSessao()}` : sx?.estado === 'pausada' ? `pausado ${placarSessao()} — retomar` : sx?.estado === 'encerrada' ? `encerrado ${placarSessao()}` : 'desligado'}</button>
        <button class="ppvp-bt ppvp-auto-bt ${cfg.auto.ativo ? 'ligado' : ''}" data-a="autoAtivo" title="Liga/desliga o auto-switch de formações">🔁 Auto-switch: ${cfg.auto.ativo ? 'LIGADO' : 'desligado'}</button>
        <button class="ppvp-bt ${aba === 'historico' ? 'ppvp-on' : ''}" data-a="aba" data-v="historico">Histórico</button>
        <button class="ppvp-bt ${aba === 'stats' ? 'ppvp-on' : ''}" data-a="aba" data-v="stats">Estatísticas</button>
        <button class="ppvp-bt ${aba === 'rivais' ? 'ppvp-on' : ''}" data-a="aba" data-v="rivais">Rivais</button>
        <button class="ppvp-bt ${aba === 'formacoes' ? 'ppvp-on' : ''}" data-a="aba" data-v="formacoes">Formações${cfg.auto.ativo ? ' 🔁' : ''}</button>
        <button class="ppvp-bt ${aba === 'agente' ? 'ppvp-on' : ''}" data-a="aba" data-v="agente">🤖 Agente${cfg.auto.agente ? ' ●' : ''}</button>
        <button class="ppvp-x" data-a="fechar" title="Fechar">×</button></span>`;
    if (aba === 'agente') {
      modal.innerHTML = `<header><span>⚔ PvP — agente de IA<small>v${VERSAO_PVP}</small></span>${abas}</header>${htmlAgente()}`;
      return;
    }
    if (aba === 'formacoes') {
      modal.innerHTML = `<header><span>⚔ PvP — formações e auto-switch<small>v${VERSAO_PVP}</small></span>${abas}</header>${htmlFormacoes()}`;
      return;
    }
    if (aba === 'rivais') {
      modal.innerHTML = `<header><span>⚔ PvP — rivais<small>v${VERSAO_PVP}</small></span>${abas}</header>${htmlRivais()}`;
      return;
    }
    if (aba === 'stats') {
      modal.innerHTML = `<header><span>⚔ PvP — estatísticas<small>v${VERSAO_PVP}</small></span>${abas}</header>${htmlStats()}`;
      return;
    }
    modal.innerHTML = `
      <header><span>⚔ PvP — ordem dos rivais<small>v${VERSAO_PVP}</small></span>${abas}</header>
      <section>
        <h4>⚔ Auto PvP</h4>
        <div class="ppvp-linha">
          <button class="ppvp-sw ${sessaoRodando() ? 'on' : ''}" data-a="autoPvp"></button>
          <b>Fila automática + auto-switch</b> · pausa com
          <input type="number" class="ppvp-in" data-c="apSeg" min="1" max="10" value="${esc(cfg.autoPvp.maxSeguidas)}"> derrotas seguidas · a cada
          <input type="number" class="ppvp-in" data-c="apCada" min="2" max="50" value="${esc(cfg.autoPvp.checarCada)}"> partidas sem saldo positivo, desliga de vez
          ${cfg.sessao && cfg.sessao.estado !== 'encerrada' ? '<button class="ppvp-bt" data-a="autoPvpFim">encerrar sessão</button>' : ''}
        </div>
        <p style="margin:4px 0 0">${cfg.sessao
          ? `Sessão desde ${quando(cfg.sessao.inicio)}: <b>${placarSessao()}</b> em ${cfg.sessao.v + cfg.sessao.d} partidas · ${sessaoRodando() ? `<b>rodando</b> · derrotas seguidas: <b>${cfg.sessao.seguidas}</b> · próxima checagem de saldo na partida <b>${(Math.floor((cfg.sessao.v + cfg.sessao.d) / cfg.autoPvp.checarCada) + 1) * cfg.autoPvp.checarCada}</b>` : `<b>${cfg.sessao.estado}</b> — ${esc(cfg.sessao.motivo)}`}`
          : '<span class="ppvp-aviso">Nenhuma sessão ainda.</span>'}</p>
      </section>
      <section>
        <div class="ppvp-linha">
          <button class="ppvp-sw ${cfg.trava ? 'on' : ''}" data-a="trava"></button>
          <b>Desligar a fila automática depois de</b>
          <input type="number" class="ppvp-in" data-c="derrotas" min="1" max="10" value="${esc(cfg.derrotas)}">
          <b>derrotas seguidas</b> ${sessaoRodando() ? '<span class="ppvp-aviso">(em pausa enquanto o Auto PvP roda — valem as regras dele)</span>' : ''}
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

  // ---------------------------------------------------------------- rivais e melhores comps guardadas
  /** Guarda a melhor ordem/comp calculada contra um jogador (o que a aba Rivais mostra). */
  function guardarMelhor(nick, tipo, r) {
    if (!nick || !r) return;
    const k = String(nick).toLowerCase();
    const enxuto = (o) => ({ ordem: o.ordem, vitorias: o.vitorias, total: o.total, pior: o.pior, media: o.media });
    melhores[k] = { ...(melhores[k] ?? {}), nick, [tipo]: { em: Date.now(), r: Array.isArray(r) ? r.map(enxuto) : enxuto(r) } };
    salvarMelhores();
  }

  const nickDaLadder = (l) => l?.nick ?? l?.nome ?? null;
  const ultimoDuelo = (nick) => hist.find((h) => String(h.nick).toLowerCase() === String(nick).toLowerCase());

  /** Calcula contra um jogador: 'ordem' = a melhor ordem da sua equipe de PvP atual; 'bolsa' = a melhor comp da bolsa. */
  async function calcularRival(nick, tipo) {
    if (!window.__pokeAnalise?.sugerirOrdem) { calcRival.set(nick, { erro: 'o módulo 📊 Time não está carregado nesta conta' }); return pintar(); }
    calcRival.set(nick, tipo);
    pintar();
    const ult = ultimoDuelo(nick);
    const meus = minhaOrdemSalva().length ? minhaOrdemSalva() : (ult?.meu ?? []);
    try {
      const r = await window.__pokeAnalise.sugerirOrdem({
        meus: meus.map((x) => ({ id: x.id, nome: x.nome, nivel: x.nivel })),
        rivalNick: nick,
        // A ordem conhecida do último duelo com ele; sem duelo, todas as ordens dele são testadas.
        ordemRival: ult && !ult.deleSemOrdem ? (ult.dele ?? []) : [],
        restoRival: ult ? [...(ult.deleSemOrdem ? ult.dele ?? [] : []), ...(ult.naoEntrou ?? [])] : [],
        buscarNaBolsa: tipo === 'bolsa',
      });
      if (tipo === 'bolsa') guardarMelhor(nick, 'bolsa', r.comps);
      else if (r.melhores?.[0]) guardarMelhor(nick, 'ordem', r.melhores[0]);
      calcRival.delete(nick);
    } catch (e) {
      calcRival.set(nick, { erro: e.message });
    }
    pintar();
  }

  const ordemCurta = (o) => o.ordem.map((p, i) => `<b style="color:#f3c77a">${i + 1}</b> ${esc(p.nome)}`).join(' → ');
  const resultadoCurto = (o) => (o.vitorias === o.total
    ? `<span class="ppvp-v">vence${o.total > 1 ? ` em todas as ${o.total} ordens dele` : ''}</span>`
    : o.vitorias ? `<span>vence ${o.vitorias} de ${o.total} ordens dele</span>` : '<span class="ppvp-d">perde</span>') + ` · margem ${margemTxt(o.pior)}`;
  const dataCurta = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  /** "Aplicar esta ordem" de um duelo do histórico (ids do duelo, ou casados pelos nomes com a bolsa). */
  function botoesDoDuelo(h, nome) {
    const ids = idsDoDuelo(h);
    if (!ids) return '<small class="ppvp-aviso">(algum pokémon desta ordem saiu da bolsa)</small>';
    const ordem = h.meu.map((x, i) => ({ ...x, id: ids[i] }));
    if (ids.join(',') === chaveAtual()) return '<small class="ppvp-v">● é a sua equipe atual</small>';
    return botoesAplicar({ ordem }, nome);
  }

  let rivalAberto = null;     // jogador com o "📜 histórico" aberto na aba Rivais
  let rivalPagina = 0;
  const ordemTxt = (lista) => (lista ?? []).map((x) => x.nome).join(' → ');

  /** O placar REAL de uma ordem (pelos nomes, na ordem) contra um jogador. */
  function realDaOrdem(nick, o) {
    const alvo = ordemTxt(o.ordem);
    const ds = hist.filter((h) => mesmoNick(h.nick, nick) && ordemTxt(h.meu) === alvo);
    return { n: ds.length, v: ds.filter((h) => h.venci).length };
  }
  const realTxt = (r) => (r.n ? ` · <b class="${pct(r.v, r.n) >= 50 ? 'ppvp-v' : 'ppvp-d'}">real: ${r.v}V ${r.n - r.v}D</b>` : ' · <small class="ppvp-aviso">real: nunca usada contra ele</small>');

  /** Tudo o que já aconteceu contra um jogador: suas comps, as dele e os duelos. */
  function htmlHistoricoRival(nick) {
    const ds = hist.filter((h) => mesmoNick(h.nick, nick)).sort((a, b) => b.em - a.em);
    if (!ds.length) return '<div class="ppvp-sug ppvp-aviso">Nenhum duelo contra ele ainda.</div>';
    const v = ds.filter((h) => h.venci).length;
    const agrupa = (chaveDe) => {
      const m = new Map();
      for (const h of ds) {
        const k = chaveDe(h);
        if (!k) continue;
        const r = m.get(k) ?? { k, n: 0, v: 0, ultimo: 0, delta: 0 };
        r.n++; if (h.venci) r.v++; r.delta += h.delta || 0; r.ultimo = Math.max(r.ultimo, h.em);
        m.set(k, r);
      }
      return [...m.values()].sort((a, b) => pct(b.v, b.n) - pct(a.v, a.n) || b.n - a.n);
    };
    const minhas = agrupa((h) => ordemTxt(h.meu) || null);
    const dueloDe = new Map(); // ordem → o duelo mais recente com ela (para o botão aplicar)
    for (const h of ds) { const k = ordemTxt(h.meu); if (k && !dueloDe.has(k)) dueloDe.set(k, h); }
    const dele = agrupa((h) => { const n = [...(h.dele ?? []), ...(h.naoEntrou ?? [])].map((x) => x.nome); return n.length ? [...n].sort((a, b) => a.localeCompare(b)).join(' · ') : null; });
    const linhasGrupo = (lista, comBotao) => lista.map((r) => `<tr><td style="white-space:normal">${esc(r.k)}${comBotao && dueloDe.get(r.k) ? `<div>${botoesDoDuelo(dueloDe.get(r.k), `Contra ${nick}`)}</div>` : ''}</td><td>${r.n}</td>
      <td><span class="ppvp-v">${r.v}</span>-<span class="ppvp-d">${r.n - r.v}</span></td><td>${pctHtml(r.v, r.n)}</td>
      <td class="${r.delta >= 0 ? 'ppvp-v' : 'ppvp-d'}">${r.delta >= 0 ? '+' : ''}${r.delta}</td><td>${dataCurta(r.ultimo)}</td></tr>`).join('');
    const POR = 10;
    const paginas = Math.max(1, Math.ceil(ds.length / POR));
    rivalPagina = Math.min(rivalPagina, paginas - 1);
    const pag = ds.slice(rivalPagina * POR, (rivalPagina + 1) * POR);
    // A simulação guardada diz "vence", mas o real contra ele está abaixo de 50%?
    const salvo = melhores[String(nick).toLowerCase()] ?? {};
    const diverge = [salvo.ordem?.r, ...(salvo.bolsa?.r ?? [])].filter(Boolean)
      .some((o) => o.vitorias === o.total && (() => { const r = realDaOrdem(nick, o); return r.n >= 3 && pct(r.v, r.n) < 50; })());
    return `<div class="ppvp-sug">
      <b>📜 Contra ${esc(nick)}:</b> ${ds.length} duelos · <span class="ppvp-v">${v}V</span> <span class="ppvp-d">${ds.length - v}D</span> · ${pctHtml(v, ds.length)}
      ${diverge ? '<p class="ppvp-d" style="margin:4px 0">⚠ A simulação guardada diz que uma ordem vence, mas com ela o seu placar REAL contra ele é negativo — confie no histórico abaixo.</p>' : ''}
      <h5>Suas comps contra ele (ordem exata)</h5>
      <table class="ppvp-tab"><tr><th>Sua ordem</th><th>Duelos</th><th>V-D</th><th>%</th><th>Pontos</th><th>Última vez</th></tr>${linhasGrupo(minhas, true)}</table>
      <h5>Comps dele contra você</h5>
      <table class="ppvp-tab"><tr><th>Time dele</th><th>Duelos</th><th>Sua V-D</th><th>%</th><th>Pontos</th><th>Última vez</th></tr>${linhasGrupo(dele)}</table>
      <h5>Duelos</h5>
      <table class="ppvp-tab"><tr><th>Quando</th><th></th><th>Ordem dele</th><th>Sua ordem</th></tr>
        ${pag.map((h) => `<tr><td>${dataCurta(h.em)}</td><td class="${h.venci ? 'ppvp-v' : 'ppvp-d'}">${h.venci ? 'V' : 'D'} <small>${h.delta >= 0 ? '+' : ''}${h.delta}</small></td>
          <td>${ordemHtml(h.dele, h.naoEntrou, h.deleSemOrdem)}</td><td>${ordemHtml(h.meu)}<div>${botoesDoDuelo(h, `Contra ${h.nick}`)}</div></td></tr>`).join('')}</table>
      ${paginas > 1 ? `<div class="ppvp-pags"><button class="ppvp-bt ppvp-mini" data-a="rivalPag" data-v="-1" ${rivalPagina === 0 ? 'disabled' : ''}>‹</button>
        <span>página ${rivalPagina + 1} de ${paginas}</span><button class="ppvp-bt ppvp-mini" data-a="rivalPag" data-v="1" ${rivalPagina >= paginas - 1 ? 'disabled' : ''}>›</button></div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------- cruzar 2 jogadores
  // Times bons contra DOIS rivais ao mesmo tempo. Real: suas formações com o placar contra cada um,
  // ordenadas pelo PIOR dos dois (uma comp que só ganha de um não serve). Simulado: o mesmo
  // `sugerirContraVarios` dos ativos, com os dois de peso igual (sua equipe ou a bolsa).
  const cruz = { a: '', b: '', calc: null };

  /** Os dois padrão: os de "sempre trocar" que existem no histórico; senão os 2 que mais te vencem. */
  function cruzPadrao(nicks) {
    if (cruz.a && cruz.b) return;
    const termos = String(cfg.auto.sempreTrocar ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const achados = termos.map((t) => nicks.find((n) => n.toLowerCase().includes(t))).filter(Boolean);
    const porDificuldade = nicks.filter((n) => hist.filter((h) => mesmoNick(h.nick, n)).length >= 2)
      .sort((x, y) => dificuldade(y) - dificuldade(x));
    const escolha = [...new Set([...achados, ...porDificuldade])];
    cruz.a ||= escolha[0] ?? '';
    cruz.b ||= escolha.find((n) => !mesmoNick(n, cruz.a)) ?? '';
  }

  function cruzReal() {
    const nota = (pv) => (pv.v + 1) / (pv.n + 2);
    return minhasFormacoes()
      .map((f) => ({ f, pa: placarVs(f.k, cruz.a), pb: placarVs(f.k, cruz.b) }))
      .filter((x) => x.pa.n || x.pb.n)
      .map((x) => ({ ...x, pior: Math.min(nota(x.pa), nota(x.pb)), ambos: x.pa.n > 0 && x.pb.n > 0 }))
      .sort((x, y) => Number(y.ambos) - Number(x.ambos) || y.pior - x.pior || (y.pa.n + y.pb.n) - (x.pa.n + x.pb.n))
      .slice(0, 6);
  }

  async function calcularCruz(tipo) {
    if (!window.__pokeAnalise?.sugerirContraVarios) { cruz.calc = { erro: 'o módulo 📊 Time não está carregado nesta conta' }; return pintar(); }
    if (!cruz.a || !cruz.b || mesmoNick(cruz.a, cruz.b)) { cruz.calc = { erro: 'escolha dois jogadores diferentes' }; return pintar(); }
    cruz.calc = tipo;
    pintar();
    const meus = minhaOrdemSalva().length ? minhaOrdemSalva() : ([...hist].sort((x, y) => y.em - x.em)[0]?.meu ?? []);
    try {
      const r = await window.__pokeAnalise.sugerirContraVarios({
        meus: meus.map((x) => ({ id: x.id, nome: x.nome, nivel: x.nivel })),
        rivais: [cruz.a, cruz.b].map((nick) => {
          const u = ultimoDuelo(nick);
          return { nick, peso: 1, ordemRival: u && !u.deleSemOrdem ? (u.dele ?? []) : [] };
        }),
        buscarNaBolsa: tipo === 'bolsa',
      });
      melhores.__cruz__ = { nick: '__cruz__', em: Date.now(), tipo, a: cruz.a, b: cruz.b, r: r.opcoes, avisos: r.avisos };
      salvarMelhores();
      cruz.calc = null;
      registrar(`🔀 cruzamento ${cruz.a} × ${cruz.b} (${tipo === 'bolsa' ? 'bolsa' : 'sua equipe'}): ${r.opcoes[0]?.ordem.map((p) => p.nome).join(' → ') ?? '—'}`);
    } catch (e) {
      cruz.calc = { erro: e.message };
    }
    pintar();
  }

  function htmlCruzar(nicks) {
    cruzPadrao(nicks);
    const opcoes = (sel) => `<option value="">— escolha —</option>${nicks.map((n) => `<option ${mesmoNick(n, sel) ? 'selected' : ''}>${esc(n)}</option>`).join('')}`;
    const placar = (pv) => (pv.n ? `<b class="${pv.v * 2 > pv.n ? 'ppvp-v' : pv.v * 2 < pv.n ? 'ppvp-d' : ''}">${pv.v}V ${pv.n - pv.v}D</b>` : '<small class="ppvp-aviso">nunca</small>');
    const real = cruz.a && cruz.b && !mesmoNick(cruz.a, cruz.b) ? cruzReal() : [];
    const sim = melhores.__cruz__;
    const simOk = sim?.r?.length && mesmoNick(sim.a, cruz.a) && mesmoNick(sim.b, cruz.b);
    const ocupado = cruz.calc && !cruz.calc.erro;
    return `<section>
        <h4>🔀 Cruzar 2 jogadores — times bons contra os dois</h4>
        <div class="ppvp-linha">
          <select class="ppvp-in" data-c="cruzA">${opcoes(cruz.a)}</select> <b>×</b>
          <select class="ppvp-in" data-c="cruzB">${opcoes(cruz.b)}</select>
          <button class="ppvp-bt ppvp-mini" data-a="cruzCalc" data-v="ordem" ${ocupado ? 'disabled' : ''}>${cruz.calc === 'ordem' ? 'calculando…' : '💡 simular (minha equipe, melhor ordem)'}</button>
          <button class="ppvp-bt ppvp-mini" data-a="cruzCalc" data-v="bolsa" ${ocupado ? 'disabled' : ''}>${cruz.calc === 'bolsa' ? 'procurando…' : '🔍 simular (melhor comp da bolsa)'}</button>
          ${cruz.calc?.erro ? `<span class="ppvp-d">${esc(cruz.calc.erro)}</span>` : ''}
        </div>
        ${cruz.a && cruz.b && !mesmoNick(cruz.a, cruz.b) ? `
        <table class="ppvp-tab" style="margin-top:4px"><tr><th>Sua formação (real)</th><th>vs ${esc(cruz.a)}</th><th>vs ${esc(cruz.b)}</th><th></th></tr>
          ${real.length ? real.map((x) => `<tr><td>${esc(nomesDosIds(x.f.ids).join(' → '))}${x.ambos ? '' : ' <small class="ppvp-aviso">(só jogou contra um)</small>'}</td><td>${placar(x.pa)}</td><td>${placar(x.pb)}</td>
            <td>${botoesAplicar({ ordem: x.f.ids.map((id) => ({ id })) }, `${cruz.a} × ${cruz.b}`)}</td></tr>`).join('')
            : '<tr><td colspan="4"><span class="ppvp-aviso">Nenhuma formação sua jogou contra eles ainda — use a simulação.</span></td></tr>'}
        </table>
        <small class="ppvp-aviso">Ordenado pelo PIOR placar dos dois (com prior 1V 1D): no topo, a que vai bem contra ambos.</small>
        ${simOk ? `<div style="margin-top:6px"><b>🔬 Simulado</b> <small class="ppvp-aviso">(${sim.tipo === 'bolsa' ? 'da bolsa' : 'sua equipe'} · ${dataCurta(sim.em)} · stats atuais do perfil deles)</small>
          ${sim.r.map((o, i) => `<div>${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} ${ordemCurta(o)} — ${o.porRival.map((x) => `${esc(x.nick)}: <b class="${x.vitorias === x.total ? 'ppvp-v' : x.vitorias ? '' : 'ppvp-d'}">${x.vitorias}/${x.total}</b>${realTxt(realDaOrdem(x.nick, o))}`).join(' · ')}
            <br>${botoesAplicar(o, `${sim.a} × ${sim.b}${i ? ` ${i + 1}` : ''}`)}</div>`).join('')}
          ${sim.avisos?.length ? `<small class="ppvp-aviso">${esc(sim.avisos.slice(0, 4).join(' · '))}</small>` : ''}</div>` : ''}` : ''}
      </section>`;
  }

  function htmlRivais() {
    const top = ladder.slice(0, 10).map(nickDaLadder).filter(Boolean)
      .filter((n) => n.toLowerCase() !== String(core.eu?.nick ?? '').toLowerCase());
    const posTop = new Map(ladder.slice(0, 10).map((l, i) => [String(nickDaLadder(l)).toLowerCase(), i + 1]));
    const nicks = new Map();
    for (const n of top) nicks.set(n.toLowerCase(), n);
    for (const h of hist) if (!nicks.has(String(h.nick).toLowerCase())) nicks.set(String(h.nick).toLowerCase(), h.nick);
    for (const m of Object.values(melhores)) if (!String(m.nick).startsWith('__') && !nicks.has(m.nick.toLowerCase())) nicks.set(m.nick.toLowerCase(), m.nick);
    const q = busca.trim().toLowerCase();
    const lista = [...nicks.values()]
      .filter((n) => !q || n.toLowerCase().includes(q))
      .filter((n) => !st.soTop || posTop.has(n.toLowerCase()))
      .sort((a, b) => (posTop.get(a.toLowerCase()) ?? 99) - (posTop.get(b.toLowerCase()) ?? 99)
        || (ultimoDuelo(b)?.em ?? 0) - (ultimoDuelo(a)?.em ?? 0));
    const linhas = lista.map((nick) => {
      const k = nick.toLowerCase();
      const duelos = hist.filter((h) => String(h.nick).toLowerCase() === k);
      const v = duelos.filter((h) => h.venci).length;
      const ult = duelos[0];
      // Venceu com (real): as suas ordens que ganharam dele, agrupadas.
      const ganhou = new Map();
      for (const h of duelos.filter((x) => x.venci && x.meu?.length)) {
        const chave = h.meu.map((x) => x.nome).join(' → ');
        ganhou.set(chave, (ganhou.get(chave) ?? 0) + 1);
      }
      const real = [...ganhou.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2)
        .map(([c, n]) => `<div>${esc(c)} <small class="ppvp-v">(${n} vitória${n > 1 ? 's' : ''})</small></div>`).join('') || '<span class="ppvp-aviso">—</span>';
      const salvo = melhores[k] ?? {};
      const calc = calcRival.get(nick);
      const simOrdem = salvo.ordem ? `<div><small class="ppvp-aviso">sua equipe atual · ${dataCurta(salvo.ordem.em)}</small><br>${ordemCurta(salvo.ordem.r)}<br><small>simulação: ${resultadoCurto(salvo.ordem.r)}${realTxt(realDaOrdem(nick, salvo.ordem.r))}</small><br>${botoesAplicar(salvo.ordem.r, `Anti ${nick}`)}</div>` : '';
      const simBolsa = salvo.bolsa?.r?.length ? `<div style="margin-top:4px"><small class="ppvp-aviso">melhor comp da bolsa · ${dataCurta(salvo.bolsa.em)}</small>
          ${salvo.bolsa.r.map((o, i) => `<div>${i === 0 ? '🥇' : i === 1 ? '🥈' : '🥉'} ${ordemCurta(o)} <small>simulação: ${resultadoCurto(o)}${realTxt(realDaOrdem(nick, o))}</small><br>${botoesAplicar(o, `Anti ${nick} bolsa${i ? ` ${i + 1}` : ''}`)}</div>`).join('')}</div>` : '';
      return `<tr>
        <td><b>${esc(nick)}</b>${posTop.has(k) ? ` <small class="ppvp-top">#${posTop.get(k)} PvP</small>` : ''}</td>
        <td>${duelos.length ? `<span class="ppvp-v">${v}</span>-<span class="ppvp-d">${duelos.length - v}</span><br><button class="ppvp-bt ppvp-mini" data-a="rivalHist" data-v="${esc(nick)}">📜 ${mesmoNick(rivalAberto, nick) ? 'fechar' : 'histórico'}</button>` : '<span class="ppvp-aviso">nunca</span>'}</td>
        <td>${ult ? ordemHtml(ult.dele, ult.naoEntrou, ult.deleSemOrdem) : '<span class="ppvp-aviso">—</span>'}</td>
        <td style="white-space:normal">${real}</td>
        <td style="white-space:normal">${simOrdem}${simBolsa}${!simOrdem && !simBolsa ? '<span class="ppvp-aviso">ainda não calculado</span>' : ''}
          ${calc?.erro ? `<div class="ppvp-d">${esc(calc.erro)}</div>` : ''}
          <div style="margin-top:4px">
            <button class="ppvp-bt ppvp-mini" data-a="calcOrdem" data-v="${esc(nick)}" ${calc && !calc.erro ? 'disabled' : ''}>${calc === 'ordem' ? 'calculando…' : '💡 melhor ordem'}</button>
            <button class="ppvp-bt ppvp-mini" data-a="calcBolsa" data-v="${esc(nick)}" ${calc && !calc.erro ? 'disabled' : ''}>${calc === 'bolsa' ? 'procurando…' : '🔍 melhor comp da bolsa'}</button>
          </div></td></tr>
        ${mesmoNick(rivalAberto, nick) ? `<tr><td colspan="5">${htmlHistoricoRival(nick)}</td></tr>` : ''}`;
    }).join('');
    return `
      ${htmlCruzar([...nicks.values()].sort((a, b) => a.localeCompare(b)))}
      <section>
        <div class="ppvp-linha">
          <button class="ppvp-bt" data-a="top10">🏅 Top 10 do PvP</button>
          <label><input type="checkbox" data-a="soTop" ${st.soTop ? 'checked' : ''}> mostrar só o top 10</label>
          <input class="ppvp-in" data-c="busca" placeholder="filtrar por nick…" value="${esc(busca)}" spellcheck="false" style="width:200px">
        </div>
        <p class="ppvp-aviso" style="margin:0">💡 = melhor ordem da sua equipe de PvP atual contra o time dele. 🔍 = procura entre os seus 8 pokémon mais fortes os 5 (e a ordem) que melhor vencem ele.
          Os stats dele vêm do perfil (time atual). Sem duelo com ele, a ordem dele é desconhecida: testa todas e escolhe a sua ordem que vence na maioria. Tudo fica guardado aqui.</p>
      </section>
      <section>
        ${linhas ? `<table class="ppvp-tab"><tr><th>Jogador</th><th>Você</th><th>Último time dele</th><th>Você venceu com (real)</th><th>Melhor contra ele (simulado, guardado)</th></tr>${linhas}</table>`
          : '<span class="ppvp-aviso">Nenhum rival ainda — clique em "Top 10 do PvP" ou jogue alguns duelos.</span>'}
      </section>`;
  }

  // ---------------------------------------------------------------- melhor ordem (derrotas)
  async function calcularSugestao(h) {
    if (!window.__pokeAnalise?.sugerirOrdem) {
      sugestoes.set(h.id, { erro: 'o módulo 📊 Time não está carregado nesta conta' });
      return pintarTabela();
    }
    sugestoes.set(h.id, { carregando: true });
    pintarTabela();
    try {
      const r = await window.__pokeAnalise.sugerirOrdem({
        meus: h.meu.map((x) => ({ id: x.id, nome: x.nome, nivel: x.nivel })),
        rivalNick: h.nick,
        ordemRival: h.deleSemOrdem ? [] : (h.dele ?? []),
        restoRival: [...(h.deleSemOrdem ? h.dele ?? [] : []), ...(h.naoEntrou ?? [])],
      });
      sugestoes.set(h.id, { r });
      if (r.melhores?.[0]) guardarMelhor(h.nick, 'ordem', r.melhores[0]);
    } catch (e) {
      sugestoes.set(h.id, { erro: e.message });
    }
    pintarTabela();
  }

  const margemTxt = (m) => `${m >= 0 ? '+' : ''}${Math.round(m * 100)}%`;
  function opcaoHtml(o, titulo, nome = '') {
    const res = o.vitorias === o.total
      ? `<b class="ppvp-v">vence</b>${o.total > 1 ? ` nos ${o.total} cenários` : ''}`
      : o.vitorias ? `<b>vence ${o.vitorias} de ${o.total} cenários</b>` : '<b class="ppvp-d">perde</b>';
    const passos = o.passos.map((s) => s.venceu === 'eu'
      ? `<span class="ppvp-v">seu ${esc(s.eu)}</span> derruba ${esc(s.ele)}${s.golpe ? ` <small>(${esc(s.golpe)}${s.ef > 1 ? ', super efetivo' : ''})</small>` : ''} — fica com ${Math.round(s.sobra * 100)}% de HP`
      : `<span class="ppvp-d">${esc(s.ele)} dele</span> derruba seu ${esc(s.eu)}${s.golpe ? ` <small>(${esc(s.golpe)}${s.ef > 1 ? ', super efetivo' : ''})</small>` : ''} — fica com ${Math.round(s.sobra * 100)}%`);
    return `<div class="ppvp-op"><b>${titulo}:</b> ${o.ordem.map((p, i) => `<b style="color:#f3c77a">${i + 1}</b> ${esc(p.nome)}`).join(' → ')}
      <div>${res} · margem ${margemTxt(o.pior)}${o.total > 1 ? ` no pior cenário (média ${margemTxt(o.media)})` : ''}</div>
      ${nome ? `<div>${botoesAplicar(o, nome)}</div>` : ''}
      <details><summary class="ppvp-aviso">como a luta se desenrola</summary><ol>${passos.map((p) => `<li>${p}</li>`).join('')}</ol></details></div>`;
  }

  function htmlSugestao(h) {
    const s = sugestoes.get(h.id);
    if (!s || s.carregando) return '<div class="ppvp-sug ppvp-aviso">Simulando as 120 ordens do seu time contra a dele… (busca os stats atuais dele no perfil)</div>';
    if (s.erro) return `<div class="ppvp-sug ppvp-d">Não deu para calcular: ${esc(s.erro)}</div>`;
    const r = s.r;
    const melhor = r.melhores[0];
    const mesma = melhor && melhor.ordem.map((p) => p.nome).join() === r.usada.ordem.map((p) => p.nome).join();
    return `<div class="ppvp-sug">
      <div>Rival na simulação: ${r.rival.map((p, i) => `${i < r.fixos ? `<b>${i + 1}</b>` : `<i>${i + 1}?</i>`} ${esc(p.nome)}`).join(' → ')}
        ${r.cenarios > 1 ? `<span class="ppvp-aviso"> · as posições com "?" não são conhecidas: testei as ${r.cenarios} combinações</span>` : ''}</div>
      ${opcaoHtml(r.usada, 'A ordem que você usou')}
      ${mesma ? '<p class="ppvp-aviso">A ordem que você usou já é a melhor possível com esse time — para virar, só trocando pokémon (use o 📊 Time).</p>'
        : r.melhores.map((o, i) => opcaoHtml(o, i === 0 ? '💡 Melhor ordem' : `${i + 1}ª opção`, `Anti ${h.nick}${i ? ` ${i + 1}` : ''}`)).join('')}
      ${melhor && !melhor.vitorias ? '<p class="ppvp-d">Nenhuma ordem desse time vence a dele na simulação — vale trocar pokémon (📊 Time sugere quem).</p>' : ''}
      ${r.usada.vitorias === r.usada.total ? '<p class="ppvp-aviso">⚠ A simulação diz que a ordem usada venceria, mas você perdeu: o rival pode ter mudado o time desde o duelo, ou a sorte do dano pesou.</p>' : ''}
      ${r.avisos.length ? `<p class="ppvp-aviso">${r.avisos.map(esc).join(' · ')}</p>` : ''}
      <p class="ppvp-aviso">Simulação com as regras de combate do jogo (luta de desgaste, status, golpe escolhido e tipos${r.tabelaOficial ? '' : ' — tabela de tipos padrão até recarregar a conta'}). É uma previsão, não garantia.</p>
    </div>`;
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
          <td>${ordemHtml(h.meu)}${h.meu?.length ? `<div>${botoesDoDuelo(h, `Contra ${h.nick}`)}</div>` : ''}${!h.venci && h.meu?.length && (h.dele?.length || h.naoEntrou?.length)
            ? `<button class="ppvp-bt ppvp-sug-bt" data-a="sugerir" data-v="${esc(h.id)}">💡 ${abertaSug === h.id ? 'fechar' : 'Melhor ordem'}</button>` : ''}</td></tr>
          ${abertaSug === h.id ? `<tr><td colspan="5">${htmlSugestao(h)}</td></tr>` : ''}`).join('')}</table>
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
    if (a === 'autoPvp') { if (sessaoRodando()) pararAutoPvp('pausada', 'desligado na mão'); else if (cfg.sessao?.estado !== 'encerrada' || confirm('A última sessão foi encerrada (saldo não positivo). Começar uma sessão nova do zero?')) iniciarAutoPvp(); }
    else if (a === 'autoPvpFim') pararAutoPvp('encerrada', 'encerrada na mão');
    else if (a === 'trava') { cfg.trava = !cfg.trava; registrar(cfg.trava ? 'trava da fila ligada' : 'trava da fila desligada'); }
    else if (a === 'limpar') { hist = []; salvarHist(); }
    else if (a === 'pag') { pagina = Math.max(0, pagina + Number(b.dataset.v)); return pintarTabela(); }
    else if (a === 'aba') { aba = b.dataset.v; if ((aba === 'rivais' && !ladder.length) || (aba === 'formacoes' && formacoes == null)) core.send({ t: 'pvp.info' }); }
    else if (a === 'aplicar' || a === 'armario') {
      let d = null;
      try { d = JSON.parse(b.dataset.v); } catch {}
      if (!d?.ids?.length) return;
      if (a === 'aplicar') aplicarEquipe(d.ids, d.nome);
      else salvarNoArmario(d.ids, d.nome);
      setTimeout(() => core.send({ t: 'pvp.info' }), 800); // traz o armário/equipe atualizados
    }
    else if (a === 'limparTrocas') { trocas = []; salvarTrocas(); }
    else if (a === 'verTrocas') trocasVerTodas = !trocasVerTodas;
    else if (a === 'contraQuem') formAberta = formAberta === b.dataset.v ? null : b.dataset.v;
    else if (a === 'usarForm') {
      const f = minhasFormacoes().find((x) => x.k === b.dataset.v);
      if (f && aplicarEquipe(f.ids, `formação "${f.nome}" (manual)`)) { cfg.auto.usoEm[f.k] = Date.now(); cfg.auto.seguidas = 0; }
    }
    else if (a === 'autoAtivo') alternarAuto();
    else if (a === 'autoNaDerrota') cfg.auto.naDerrota = b.checked;
    else if (a === 'autoModo') cfg.auto.modo = b.dataset.v;
    else if (a === 'autoFoco') cfg.auto.focoAmeacas = b.checked;
    else if (a === 'autoAnti') cfg.auto.contraCounter = b.checked;
    else if (a === 'autoAbertura') cfg.auto.abertura = b.checked;
    else if (a === 'autoReavaliar') cfg.auto.reavaliarFila = b.checked;
    else if (a === 'autoIA') cfg.auto.ia = b.checked;
    else if (a === 'autoAgente') cfg.auto.agente = b.checked;
    else if (a === 'autoAgenteSw') { cfg.auto.agente = !cfg.auto.agente; if (cfg.auto.agente && !cfg.auto.ativo) { cfg.auto.ativo = true; cfg.auto.seguidas = 0; } registrar(cfg.auto.agente ? '🤖 agente de IA LIGADO nesta conta' : '🤖 agente de IA desligado nesta conta'); }
    else if (a === 'limparEventos') { eventosAgente = []; salvarEventos(); }
    else if (a === 'pagAgente') { paginaAgente = Math.max(0, paginaAgente + Number(b.dataset.v)); }
    else if (a === 'limparCaderno') { caderno = ''; try { localStorage.removeItem(CHAVE_CADERNO); } catch {} }
    else if (a === 'calcAtivos') return calcularContraAtivos(b.dataset.v);
    else if (a === 'cruzCalc') return calcularCruz(b.dataset.v);
    else if (a === 'autoFora') {
      const k = b.dataset.v;
      cfg.auto.foraKeys = b.checked ? cfg.auto.foraKeys.filter((x) => x !== k) : [...new Set([...cfg.auto.foraKeys, k])];
    }
    else if (a === 'top10') { st.soTop = true; core.send({ t: 'pvp.info' }); }
    else if (a === 'soTop') st.soTop = b.checked;
    else if (a === 'rivalHist') { rivalAberto = mesmoNick(rivalAberto, b.dataset.v) ? null : b.dataset.v; rivalPagina = 0; }
    else if (a === 'rivalPag') rivalPagina = Math.max(0, rivalPagina + Number(b.dataset.v));
    else if (a === 'calcOrdem') return calcularRival(b.dataset.v, 'ordem');
    else if (a === 'calcBolsa') return calcularRival(b.dataset.v, 'bolsa');
    else if (a === 'sugerir') {
      const h = hist.find((x) => String(x.id) === b.dataset.v);
      abertaSug = abertaSug === h?.id ? null : h?.id ?? null;
      if (h && abertaSug != null && !sugestoes.get(h.id)?.r) calcularSugestao(h);
      return pintarTabela();
    }
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

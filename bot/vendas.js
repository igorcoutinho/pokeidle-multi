// PokéIdle Bot — RELATÓRIO DE COMPRAS E VENDAS do Mercado. Trocado a quente junto com a lógica.
//
// Lê o extrato do próprio jogador no Mercado da Comunidade (as abas "Histórico de compras" e
// "Histórico de vendas" — `market.historicoCompras` e `market.historico`), página por página, e
// agrupa por item: quanto comprou e a que preço médio, quanto vendeu, quanto a taxa levou, o
// lucro, e A PARTIR DE QUE PREÇO vender para empatar (ou para ter a margem escolhida).
// A comissão é a do jogo: `shared/taxa-mercado.mjs`, o mesmo arquivo que o servidor usa.
(() => {
  'use strict';
  const VERSAO_VENDAS = '1.3.2';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pv-fundo')?.classList.contains('aberto');
  window.__pokeVendas?.desmontar?.();

  const limpezas = [];
  const V = {
    versao: VERSAO_VENDAS,
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    // Para a janela do app comandar todas as contas de uma vez (botão "📉 Pedra abaixo do mercado").
    infoRebaixar: () => infoRebaixar(),
    previaRebaixar: (o) => previaRebaixar(o),
    rebaixarAgora: (o) => rebaixarAgora(o),
    /** Baixa o extrato (compras e vendas). `desde` = 0 → tudo. Usado pelo 📦 Itens → Boss (lucro). */
    garantirDados: (forcar = false, desde = null) => garantirDados(forcar, desde),
    fechar: () => fechar(),
  };
  window.__pokeVendas = V;

  // ---------------------------------------------------------------- constantes
  const MAX_PAGINAS = 60;          // por extrato (30 linhas cada) — teto de segurança
  const ESPERA_PAGINA_MS = 350;    // entre pedidos, para não martelar o servidor
  const DIA = 24 * 60 * 60 * 1000;
  const CHAVE_CFG = 'pokevendas.v1';
  const PERIODOS = [
    { id: 'hoje', nome: 'Hoje', dias: 1 },
    { id: '3d', nome: 'Últimos 3 dias', dias: 3 },
    { id: '7d', nome: '7 dias', dias: 7 },
    { id: '30d', nome: '30 dias', dias: 30 },
    { id: 'tudo', nome: 'Tudo', dias: null },
    { id: 'datas', nome: 'Entre datas', dias: null },
  ];

  function lerCfg() {
    const padrao = { periodo: '3d', moeda: '', tipo: '', busca: '', margem: 10, de: '', ate: '', ordem: 'lucro' };
    try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; } catch { return padrao; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify({ ...cfg, busca: '' })); } catch {} };

  // Os dados baixados sobrevivem à troca a quente deste arquivo.
  const dados = (window.__pokeVendasDados ??= { compras: [], vendas: [], ate: 0, baixadoEm: 0, completo: false });
  let taxaMod = null;
  let ocupado = false;
  let msg = '';
  let aberto = null; // chave do item com o detalhe aberto
  let modo = 'relatorio'; // 'relatorio' | 'rebaixar'

  // ---------------------------------------------------------------- anunciar abaixo do mercado
  // Publica 1 ou 2 unidades de uma pedra em Coins, 5–10% abaixo do menor anúncio atual. NUNCA nas
  // contas protegidas (a principal): o modo fica bloqueado nelas.
  const CONTAS_PROTEGIDAS = ['bekazin'];
  const CHAVE_REB = 'pokevendas.rebaixar.v1';
  const reb = { itemId: null, qtd: 1, desconto: null, mercado: null, carregando: false, publicando: false, msg: '',
    log: (() => { try { return JSON.parse(localStorage.getItem(CHAVE_REB)) ?? []; } catch { return []; } })() };
  const salvarReb = () => { try { localStorage.setItem(CHAVE_REB, JSON.stringify(reb.log.slice(0, 50))); } catch {} };
  const contaProtegida = () => CONTAS_PROTEGIDAS.includes(String(core.eu?.nick ?? '').toLowerCase());
  const nomeItem = (id) => core.itens?.get?.(Number(id))?.name ?? core.itens?.get?.(Number(id))?.nome ?? `item ${id}`;

  /** As pedras da bolsa desta conta: itens com "Stone"/"Pedra" no nome e quantidade > 0. */
  function pedrasNaBolsa() {
    return Object.entries(core.eu?.items ?? {})
      .map(([id, q]) => ({ id: Number(id), q: Math.floor(Number(q) || 0), nome: nomeItem(id) }))
      .filter((x) => x.q > 0 && /stone|pedra/i.test(x.nome))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  async function carregarMercadoReb() {
    reb.carregando = true;
    pintar();
    try {
      const m = await pedir({ t: 'market.itens' }, (x) => x.aba === 'itens');
      reb.mercado = { resumo: m.resumo ?? {}, medias: m.medias ?? {}, em: Date.now() };
      reb.msg = '';
    } catch (e) { reb.msg = `Não deu para ler os preços: ${e.message}`; }
    reb.carregando = false;
    pintar();
  }

  /**
   * O preço sugerido: o menor anúncio atual em Coins (sem anúncio, a média de 7 dias) menos um
   * desconto entre 5% e 10% — 5% com pouca concorrência, subindo até 10% com 10+ anúncios; se o
   * menor já está bem abaixo da média (preço já caindo), fica nos 5%.
   */
  function precoSugerido(itemId) {
    const r = reb.mercado?.resumo?.[itemId];
    const menor = r?.anuncios && r.minGold ? Number(r.minGold) : null;
    const media = Number(reb.mercado?.medias?.[itemId]?.gold?.media) || null;
    const ref = menor ?? media;
    if (!ref) return null;
    let d = 0.05 + 0.05 * Math.min(1, (r?.anuncios ?? 0) / 10);
    if (menor && media && menor < media * 0.8) d = 0.05;
    if (reb.desconto != null) d = Math.min(0.10, Math.max(0.05, reb.desconto / 100));
    return { ref, fonte: menor ? 'menor anúncio' : 'média de 7 dias', anuncios: r?.anuncios ?? 0, media, desconto: d, preco: Math.max(2, Math.floor(ref * (1 - d))) };
  }

  // ---- comandado pela janela do app (todas as contas de uma vez)
  function infoRebaixar() {
    return { nick: core.eu?.nick ?? null, logado: !!core.logado, protegida: contaProtegida(), pedras: core.logado ? pedrasNaBolsa() : [] };
  }

  /** O preço que esta conta anunciaria (lê o Mercado agora). `desconto` em % (5–10) ou null = automático. */
  async function previaRebaixar({ nome, desconto = null }) {
    if (!core.logado) return { erro: 'conta deslogada' };
    if (contaProtegida()) return { protegida: true };
    const it = pedrasNaBolsa().find((x) => x.nome.toLowerCase() === String(nome).toLowerCase());
    if (!it) return { tem: 0 };
    const antes = reb.desconto;
    reb.desconto = desconto == null || desconto === '' ? null : Number(desconto);
    try {
      const m = await pedir({ t: 'market.itens' }, (x) => x.aba === 'itens');
      reb.mercado = { resumo: m.resumo ?? {}, medias: m.medias ?? {}, em: Date.now() };
      const sug = precoSugerido(it.id);
      return sug ? { tem: it.q, itemId: it.id, ...sug } : { tem: it.q, itemId: it.id, erro: 'sem referência de preço em Coins' };
    } catch (e) {
      return { tem: it.q, erro: e.message };
    } finally { reb.desconto = antes; }
  }

  /**
   * Publica já (sem perguntar — a janela do app já confirmou com o jogador). Com `preco` (e
   * `itemId`), usa o preço calculado ANTES de qualquer conta publicar: sem isso, cada conta veria
   * o anúncio da anterior como "menor" e baixaria de novo, em cascata.
   */
  async function rebaixarAgora({ nome, qtd = 1, desconto = null, preco: precoFixo = null, itemId = null, ref: refFixo = null }) {
    if (contaProtegida()) return { ok: false, protegida: true, msg: 'conta protegida — pulada' };
    const tem = pedrasNaBolsa().find((x) => x.nome.toLowerCase() === String(nome).toLowerCase());
    const pv = precoFixo && itemId && tem
      ? { tem: tem.q, itemId, preco: Math.max(2, Math.floor(precoFixo)), ref: refFixo, desconto: (desconto ?? 0) / 100 }
      : await previaRebaixar({ nome, desconto });
    if (pv.erro || !pv.preco) return { ok: false, msg: pv.erro ?? 'não tem essa pedra' };
    const n = Math.min(pv.tem, Math.max(1, Math.min(2, Number(qtd) || 1)));
    const registro = { em: Date.now(), conta: core.eu?.nick ?? '?', item: nome, qtd: n, preco: pv.preco, ref: pv.ref, desconto: Math.round(pv.desconto * 100), resultado: 'enviado' };
    let ok = false;
    try {
      await pedir({ t: 'market.criar', tipo: 'item', itemId: pv.itemId, pokemonId: null, caixaId: null, casaId: null, bicicletaId: null, qtd: n, preco: pv.preco, moeda: 'gold', dias: null }, (x) => x.aba === 'criado', 8000);
      registro.resultado = 'publicado';
      ok = true;
    } catch (e) { registro.resultado = `sem confirmação (${e.message})`; }
    reb.log.unshift(registro);
    salvarReb();
    return { ok, qtd: n, preco: pv.preco, ref: pv.ref, desconto: pv.desconto, msg: registro.resultado };
  }

  async function publicarReb() {
    if (contaProtegida()) return;
    const it = pedrasNaBolsa().find((x) => x.id === reb.itemId);
    const sug = it && precoSugerido(it.id);
    if (!it || !sug) return;
    const qtd = Math.min(it.q, Math.max(1, Math.min(2, Number(reb.qtd) || 1)));
    if (!confirm(`Anunciar ${qtd}× ${it.nome} por ${fmt(sug.preco)} Coins cada?\n\n${Math.round(sug.desconto * 100)}% abaixo do ${sug.fonte} (${fmt(sug.ref)}).\nConta: ${core.eu?.nick ?? '?'} · moeda: COINS`)) return;
    reb.publicando = true;
    pintar();
    const pacote = { t: 'market.criar', tipo: 'item', itemId: it.id, pokemonId: null, caixaId: null, casaId: null, bicicletaId: null, qtd, preco: sug.preco, moeda: 'gold', dias: null };
    const registro = { em: Date.now(), conta: core.eu?.nick ?? '?', item: it.nome, qtd, preco: sug.preco, ref: sug.ref, desconto: Math.round(sug.desconto * 100), resultado: 'enviado' };
    try {
      await pedir(pacote, (x) => x.aba === 'criado', 8000);
      registro.resultado = 'publicado';
      reb.msg = `✅ Anunciado: ${qtd}× ${it.nome} por ${fmt(sug.preco)} Coins cada.`;
    } catch (e) {
      registro.resultado = `sem confirmação (${e.message}) — confira em "Meus anúncios"`;
      reb.msg = `⚠ O jogo não confirmou o anúncio: confira em Mercado → Meus anúncios.`;
    }
    reb.log.unshift(registro);
    salvarReb();
    reb.publicando = false;
    setTimeout(carregarMercadoReb, 1500);
  }

  // ---------------------------------------------------------------- reposição automática de pedras
  // Quando uma pedra VIGIADA desta conta vende no Mercado (`marketVendido`), compra as 2 mais baratas
  // do Mercado — até o alvo de compra do Rotom, nunca de uma conta sua — e reanuncia a "alvo + %".
  // É o estoque das contas alternativas para segurar o preço perto do alvo (a Bekazin compra no alvo).
  // NUNCA roda na conta protegida. Os alvos, os seus nicks e o % de cada conta vêm da janela do app
  // (`window.__pokeReposicao`), lidos do Rotom Sniper.
  const PEDRAS_REPOR = ['Water', 'Rock', 'Earth', 'Fire', 'Leaf'];
  const CHAVE_REPOR = 'pokevendas.repor.v1';
  const repor = (() => {
    const padrao = { ativo: false, garantir: true, teto: 150, pedras: Object.fromEntries(PEDRAS_REPOR.map((p) => [p, true])), qtd: 2, log: [] };
    try { const s = JSON.parse(localStorage.getItem(CHAVE_REPOR)) ?? {}; return { ...padrao, ...s, pedras: { ...padrao.pedras, ...(s.pedras ?? {}) }, log: s.log ?? [] }; } catch { return padrao; }
  })();
  const salvarRepor = () => { try { localStorage.setItem(CHAVE_REPOR, JSON.stringify({ ...repor, log: repor.log.slice(0, 40) })); } catch {} };
  const reporNota = (txt) => { repor.log.unshift({ em: Date.now(), txt }); repor.log = repor.log.slice(0, 40); salvarRepor(); console.log('[Reposição]', txt); if (document.getElementById('pv-fundo')?.classList.contains('aberto') && modo === 'rebaixar') pintar(); };
  const dadosApp = () => window.__pokeReposicao ?? null;
  /** O id e o nome do catálogo de "<Tipo> Stone". */
  function pedraDoTipo(tipo) {
    for (const [id, i] of core.itens ?? []) {
      const n = String(i.name ?? i.nome ?? '');
      if (new RegExp(`^${tipo}\\s+stone$`, 'i').test(n)) return { id: Number(id), nome: n };
    }
    return null;
  }
  const naBolsaId = (id) => Math.floor(Number(core.eu?.items?.[id]) || 0);

  /** Espera um evento de batalha (ex.: `marketComprado`) que passe no filtro. */
  function esperarEvento(filtro, ms = 7000) {
    return new Promise((ok) => {
      const ws = core.ws;
      if (!ws) return ok(null);
      const t = setTimeout(() => { ws.removeEventListener('message', f); ok(null); }, ms);
      function f(ev) {
        if (typeof ev.data !== 'string' || !ev.data.includes('"t":"batalha"')) return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        const e = (m.ev ?? []).find(filtro);
        if (!e) return;
        clearTimeout(t); ws.removeEventListener('message', f); ok(e);
      }
      ws.addEventListener('message', f);
    });
  }

  const filaRepor = [];
  let reponDo = false;
  const ultimaRepos = new Map(); // tipo → quando (evita repor 2× pelo mesmo lote)
  function aoVenderPedra(descricao) {
    const m = String(descricao ?? '').match(/\b(water|rock|earth|fire|leaf)\s+stone\b/i);
    if (!m) return;
    const tipo = PEDRAS_REPOR.find((p) => p.toLowerCase() === m[1].toLowerCase());
    if (!repor.ativo || !repor.pedras[tipo]) return;
    if (contaProtegida()) { reporNota(`🔒 ${tipo} Stone vendeu, mas esta conta é protegida — não repõe`); return; }
    if (Date.now() - (ultimaRepos.get(tipo) ?? 0) < 30_000 || filaRepor.some((x) => x.tipo === tipo)) return;
    filaRepor.push({ tipo, garantir: false });
    processarRepor();
  }

  async function processarRepor() {
    if (reponDo) return;
    reponDo = true;
    try {
      while (filaRepor.length) {
        const { tipo, garantir } = filaRepor.shift();
        if (!garantir) ultimaRepos.set(tipo, Date.now());
        await reporPedra(tipo, garantir).catch((e) => reporNota(`⚠ ${tipo} Stone: ${e.message}`));
        await dormir(1500);
      }
    } finally { reponDo = false; }
  }

  /**
   * `garantir` = checagem periódica ("manter sempre um anúncio"): se esta conta já tem anúncio da
   * pedra, não faz nada; se não tem, anuncia o que tiver na bolsa ou, sem nenhuma, compra 2 e anuncia.
   */
  async function reporPedra(tipo, garantir = false) {
    if (contaProtegida()) return;
    const pedra = pedraDoTipo(tipo);
    if (!pedra) return garantir ? null : reporNota(`⚠ não achei "${tipo} Stone" no catálogo de itens`);
    const app = dadosApp();
    const alvo = Number(app?.alvos?.[pedra.nome.toLowerCase()]) || 0;
    if (!alvo) return garantir ? null : reporNota(`⚠ ${pedra.nome} vendeu, mas não há alvo no Rotom para ela — não comprei (sem teto de preço)`);
    const meus = new Set([...(app?.meusNicks ?? []), core.eu?.nick].filter(Boolean).map((n) => String(n).toLowerCase()));
    // 1) os anúncios em Coins, do mais barato, sem os seus, até o alvo
    const r = await pedir({ t: 'market.item', itemId: pedra.id, moeda: 'gold' }, (x) => x.aba === 'item' && Number(x.itemId) === pedra.id, 8000);
    const acimaG = Math.max(0, Number(app?.acima ?? 5)) / 100;
    const precoG = Math.max(2, Math.ceil(alvo * (1 + acimaG)));
    if (garantir) {
      const eu = String(core.eu?.nick ?? '').toLowerCase();
      if ((r.linhas ?? []).some((l) => String(l.vendedor ?? '').toLowerCase() === eu)) return; // já tem anúncio: nada a fazer
      const tem = naBolsaId(pedra.id);
      if (tem > 0) {
        const pub = await rebaixarAgora({ nome: pedra.nome, qtd: Math.min(tem, 2), preco: precoG, itemId: pedra.id, ref: alvo, desconto: -Math.round(acimaG * 100) });
        return reporNota(`📌 ${pedra.nome}: estava sem anúncio — ${pub.ok ? `anunciei ${pub.qtd}× da bolsa a ${fmt(precoG)} (alvo +${Math.round(acimaG * 100)}%)` : `não anunciei (${pub.msg})`}`);
      }
    }
    // Do mais barato que encontrar, fora as suas contas; teto = X% do alvo (0 = sem teto).
    const teto = Number(repor.teto) > 0 ? alvo * (Number(repor.teto) / 100) : Infinity;
    const ofertas = (r.linhas ?? []).filter((l) => !meus.has(String(l.vendedor ?? '').toLowerCase()) && Number(l.preco) > 0 && Number(l.preco) <= teto)
      .sort((a, b) => a.preco - b.preco);
    let falta = Math.max(1, Math.min(5, Number(repor.qtd) || 2));
    let comprou = 0, gasto = 0;
    const antes = naBolsaId(pedra.id);
    for (const l of ofertas) {
      if (!falta) break;
      const n = Math.min(falta, Math.floor(Number(l.qtd) || 1));
      if ((Number(core.eu?.gold) || 0) < n * l.preco) { reporNota(`⚠ ${pedra.nome}: sem Coins para comprar ${n}× a ${fmt(l.preco)}`); break; }
      core.send({ t: 'market.comprar', id: l.id, qtd: n, preco: l.preco, moeda: 'gold' });
      const ev = await esperarEvento((e) => e.k === 'marketComprado' && /stone/i.test(e.descricao ?? ''), 7000);
      if (!ev) { reporNota(`⚠ ${pedra.nome}: a compra de ${n}× de ${l.vendedor} não confirmou (outro comprador levou?)`); continue; }
      comprou += n; gasto += n * l.preco; falta -= n;
      await dormir(700);
    }
    if (!comprou) return reporNota(`${pedra.nome} ${garantir ? 'sem estoque nem anúncio' : 'vendeu'} — nenhum anúncio até o teto (${teto === Infinity ? 'sem teto' : fmt(teto)}) para repor${ofertas.length ? '' : ` · menor fora dos seus: ${fmt(Math.min(...(r.linhas ?? []).filter((l) => !meus.has(String(l.vendedor ?? '').toLowerCase())).map((l) => l.preco)) || 0)}`}`);
    // 2) reanuncia a alvo + % (o degrau desta conta, que a janela do app escalona entre as contas)
    for (let i = 0; i < 10 && naBolsaId(pedra.id) < antes + comprou; i++) await dormir(500);
    const acima = Math.max(0, Number(app?.acima ?? 5)) / 100;
    const precoVenda = Math.max(2, Math.ceil(alvo * (1 + acima)));
    const pub = await rebaixarAgora({ nome: pedra.nome, qtd: Math.min(comprou, 2), preco: precoVenda, itemId: pedra.id, ref: alvo, desconto: -Math.round(acima * 100) });
    reporNota(`${garantir ? '📌' : '🔁'} ${pedra.nome} ${garantir ? 'sem estoque nem anúncio' : 'vendeu'} → comprei ${comprou}× (${fmt(gasto)} Coins, do mais barato · alvo ${fmt(alvo)}) e ${pub.ok ? `anunciei ${pub.qtd}× a ${fmt(precoVenda)} (alvo +${Math.round(acima * 100)}%)` : `NÃO anunciei (${pub.msg})`}`);
  }

  // Escuta as vendas desta conta (inclusive as que aconteceram offline: chegam no login).
  function aoMsgRepor(ev) {
    if (typeof ev.data !== 'string' || !ev.data.includes('"marketVendido"')) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    for (const e of m.ev ?? []) if (e.k === 'marketVendido') aoVenderPedra(e.descricao);
  }
  let wsRepor = null;
  const vigiaRepor = setInterval(() => {
    if (core.ws === wsRepor) return;
    wsRepor?.removeEventListener('message', aoMsgRepor);
    wsRepor = core.ws;
    wsRepor?.addEventListener('message', aoMsgRepor);
  }, 1000);
  limpezas.push(() => { clearInterval(vigiaRepor); wsRepor?.removeEventListener('message', aoMsgRepor); });
  // "Manter sempre um anúncio": a cada 10 min (a 1ª, 2 min depois de abrir), confere cada pedra marcada.
  let ultimaGarantia = Date.now() - 8 * 60_000;
  const vigiaGarantia = setInterval(() => {
    if (!repor.ativo || !repor.garantir || contaProtegida() || !core.logado || !dadosApp()?.alvos || Date.now() - ultimaGarantia < 10 * 60_000) return;
    ultimaGarantia = Date.now();
    for (const p of PEDRAS_REPOR) if (repor.pedras[p] && !filaRepor.some((x) => x.tipo === p)) filaRepor.push({ tipo: p, garantir: true });
    processarRepor();
  }, 30_000);
  limpezas.push(() => clearInterval(vigiaGarantia));

  function htmlRepor() {
    if (contaProtegida()) return `<section><p class="pv-neg"><b>🔁 Reposição automática: 🔒 bloqueada nesta conta.</b></p></section>`;
    const app = dadosApp();
    return `<section>
        <h4 class="pv-rot">🔁 Reposição automática</h4>
        <div class="pv-linha">
          <button class="pv-bt ${repor.ativo ? 'on' : ''}" data-a="reporAtivo">${repor.ativo ? '● LIGADA' : 'desligada'}</button>
          ${PEDRAS_REPOR.map((p) => `<label><input type="checkbox" data-a="reporPedra" data-v="${p}" ${repor.pedras[p] ? 'checked' : ''}> ${p}</label>`).join(' ')}
          <label title="compra do mais barato que encontrar, até este % do seu alvo do Rotom (0 = sem teto: compra seja qual for o preço)">teto de compra <input type="number" class="pv-in" data-c="reporTeto" min="0" max="1000" step="10" value="${esc(repor.teto ?? 150)}" style="width:64px">% do alvo</label>
          <label title="a cada 10 min: se esta conta não tiver anúncio de uma pedra marcada, anuncia o que tiver na bolsa — ou, sem nenhuma, compra 2 no Mercado (até o alvo) e anuncia"><input type="checkbox" data-a="reporGarantir" ${repor.garantir ? 'checked' : ''}> manter sempre um anúncio (sem estoque → compra 2)</label>
        </div>
        <p class="pv-ajuda">Quando uma dessas pedras desta conta vende (ou, com "manter sempre um anúncio", quando ela fica sem), o bot compra as <b>2 mais baratas</b> do Mercado (em Coins, até <b>${Number(repor.teto) > 0 ? `${esc(repor.teto)}% do alvo do Rotom` : 'qualquer preço'}</b>, nunca de uma conta sua) e reanuncia a <b>alvo + ${esc(app?.acima ?? 5)}%</b>. Alvos do Rotom: ${app?.alvos ? PEDRAS_REPOR.map((p) => { const pe = pedraDoTipo(p); const a = pe && app.alvos[pe.nome.toLowerCase()]; return `${p} ${a ? fmt(a) : '—'}`; }).join(' · ') : '<span class="pv-neg">ainda não recebidos da janela do app (abra o app novo / aguarde 1 min)</span>'}.</p>
        ${repor.log.length ? `<table class="pv-tab"><tr><th>Quando</th><th>O que aconteceu</th></tr>${repor.log.slice(0, 12).map((l) => `<tr><td>${dataHora(l.em)}</td><td style="text-align:left;white-space:normal">${esc(l.txt)}</td></tr>`).join('')}</table>` : '<p class="pv-ajuda">Nada ainda.</p>'}
      </section>`;
  }

  // ---------------------------------------------------------------- ⭐ favoritos vigiados
  // Os anúncios que você favoritou no Mercado (a ★ do card): a cada N min o bot pede a lista
  // (`market.favoritos`) e avisa quando o PREÇO muda ou o anúncio SAI (vendido / retirado).
  // Só lê — não compra nada.
  const CHAVE_FAV = 'pokevendas.favoritos.v1';
  const fav = (() => {
    const padrao = { ativo: true, cadaMin: 2, vistos: {}, log: [] };
    try { const s = JSON.parse(localStorage.getItem(CHAVE_FAV)) ?? {}; return { ...padrao, ...s, vistos: s.vistos ?? {}, log: s.log ?? [] }; } catch { return padrao; }
  })();
  const salvarFav = () => { try { localStorage.setItem(CHAVE_FAV, JSON.stringify({ ...fav, log: fav.log.slice(0, 40) })); } catch {} };
  let favUltima = 0, favLendo = false, favMsg = '';
  const nomeAnuncio = (a) => {
    const f = a.ficha ?? {};
    const nome = f.nome ?? f.especie ?? f.name ?? a.nome ?? a.descricao ?? `anúncio ${a.id}`;
    const nv = f.level ?? f.nivel;
    return `${f.shiny ? '✨' : ''}${nome}${nv ? ` Nv ${fmt(nv)}` : ''}`;
  };
  const precoTxt = (v, m) => `${fmt(v)} ${m === 'orb' ? '💎' : '🪙'}`;

  function alertaFav(txt) {
    fav.log.unshift({ em: Date.now(), txt });
    fav.log = fav.log.slice(0, 40);
    salvarFav();
    console.log('[Favoritos]', txt);
    // aviso grande na tela (fica 20 s), som e notificação do Windows
    let el = document.getElementById('pv-fav-alerta');
    if (!el) {
      el = document.createElement('div');
      el.id = 'pv-fav-alerta';
      el.style.cssText = 'position:fixed;left:50%;top:90px;transform:translateX(-50%);z-index:100004;padding:12px 18px;border-radius:12px;background:#1e3a1e;color:#b6ffb6;border:3px solid #7fdc8f;font:800 16px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.6);cursor:pointer;max-width:80vw';
      el.onclick = () => el.remove();
      document.body.appendChild(el);
      limpezas.push(() => el.remove());
    }
    el.textContent = `⭐ ${txt}`;
    clearTimeout(alertaFav.t);
    alertaFav.t = setTimeout(() => el.remove(), 20_000);
    try {
      const ctx = new AudioContext();
      for (const [i, f] of [880, 1175, 1568].entries()) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; g.gain.value = 0.15;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + i * 0.18); o.stop(ctx.currentTime + i * 0.18 + 0.15);
      }
    } catch {}
    // Aviso GRANDE na janela do app (por cima das 4 contas) + notificação do Windows: vai pelo preload.
    window.postMessage({ __pbAlerta: { titulo: '⭐ Favorito do Mercado', texto: txt } }, '*');
    if (document.getElementById('pv-fundo')?.classList.contains('aberto') && modo === 'favoritos') pintar();
  }

  async function vigiarFavoritos(manual = false) {
    if (favLendo || !core.logado) return;
    favLendo = true;
    try {
      const m = await pedir({ t: 'market.favoritos' }, (x) => x.aba === 'favoritos', 9000);
      const agora = Date.now();
      const linhas = (m.linhas ?? []).filter((a) => a.id != null);
      const presentes = new Set();
      for (const a of linhas) {
        const k = String(a.id);
        presentes.add(k);
        const nome = nomeAnuncio(a);
        const preco = Number(a.preco) || 0;
        const moeda = a.moeda ?? 'gold';
        const aberto = !a.estado || a.estado === 'aberto';
        const antes = fav.vistos[k];
        if (!antes) {
          fav.vistos[k] = { nome, vendedor: a.vendedor ?? '', preco, moeda, aberto, desde: agora, mudouEm: null, antes: null };
          continue;
        }
        if (aberto && antes.aberto && preco && preco !== antes.preco) {
          const pct = antes.preco ? Math.round(((preco - antes.preco) / antes.preco) * 100) : 0;
          alertaFav(`${nome} (de ${a.vendedor ?? antes.vendedor}) ${preco < antes.preco ? 'BAIXOU' : 'subiu'}: ${precoTxt(antes.preco, antes.moeda)} → ${precoTxt(preco, moeda)} (${pct > 0 ? '+' : ''}${pct}%)`);
          Object.assign(antes, { antes: antes.preco, preco, moeda, mudouEm: agora });
        } else if (!aberto && antes.aberto) {
          alertaFav(`${nome} (de ${antes.vendedor}) ${a.estado === 'vendido' ? 'foi VENDIDO' : 'saiu do Mercado'}`);
          Object.assign(antes, { aberto: false, mudouEm: agora });
        }
        Object.assign(antes, { nome, vendedor: a.vendedor ?? antes.vendedor, aberto });
      }
      for (const k of Object.keys(fav.vistos)) if (!presentes.has(k)) delete fav.vistos[k]; // você desfavoritou
      favUltima = agora;
      favMsg = `${linhas.length} favorito(s) · lido ${dataHora(agora)}`;
      salvarFav();
    } catch (e) {
      favMsg = `não deu para ler os favoritos: ${e.message}`;
    } finally {
      favLendo = false;
      if (document.getElementById('pv-fundo')?.classList.contains('aberto') && modo === 'favoritos') pintar();
    }
  }
  const vigiaFav = setInterval(() => {
    if (fav.ativo && Date.now() - favUltima > Math.max(1, Number(fav.cadaMin) || 2) * 60_000) vigiarFavoritos();
  }, 20_000);
  limpezas.push(() => clearInterval(vigiaFav));

  function htmlFavoritos() {
    const itens = Object.entries(fav.vistos).sort((a, b) => (b[1].mudouEm ?? 0) - (a[1].mudouEm ?? 0));
    return `<section>
        <div class="pv-linha">
          <button class="pv-bt ${fav.ativo ? 'on' : ''}" data-a="favAtivo">${fav.ativo ? '● vigiando' : 'parado'}</button>
          a cada <input type="number" class="pv-in" data-c="favCada" min="1" max="60" value="${esc(fav.cadaMin)}" style="width:54px"> min
          <button class="pv-bt" data-a="favAgora" ${favLendo ? 'disabled' : ''}>${favLendo ? 'lendo…' : '⟳ ler agora'}</button>
          <span class="pv-ajuda">${esc(favMsg)}</span>
        </div>
        <p class="pv-ajuda">Vigia os anúncios que você favoritou (★ no card do Mercado) NESTA conta e avisa — na tela, com som e notificação do Windows — quando o preço muda ou o anúncio sai. Não compra nada.</p>
        ${itens.length ? `<table class="pv-tab"><tr><th>Anúncio</th><th>Vendedor</th><th>Preço agora</th><th>Antes</th><th>Mudou</th><th>Situação</th></tr>
          ${itens.map(([, v]) => `<tr><td style="text-align:left"><b>${esc(v.nome)}</b></td><td>${esc(v.vendedor)}</td><td><b>${precoTxt(v.preco, v.moeda)}</b></td><td>${v.antes != null ? precoTxt(v.antes, v.moeda) : '—'}</td><td>${v.mudouEm ? dataHora(v.mudouEm) : '—'}</td><td>${v.aberto ? 'à venda' : '<span class="pv-neg">fora do Mercado</span>'}</td></tr>`).join('')}</table>`
          : '<p class="pv-ajuda">Nenhum favorito lido ainda — clique em "ler agora".</p>'}
        ${fav.log.length ? `<h4 class="pv-rot">Avisos</h4><table class="pv-tab">${fav.log.slice(0, 12).map((l) => `<tr><td>${dataHora(l.em)}</td><td style="text-align:left;white-space:normal">${esc(l.txt)}</td></tr>`).join('')}</table>` : ''}
      </section>`;
  }

  function htmlRebaixar() {
    if (contaProtegida()) {
      return `<section><p class="pv-neg"><b>🔒 Bloqueado nesta conta (${esc(core.eu?.nick ?? '')}).</b> O anúncio abaixo do mercado só roda nas contas alternativas.</p></section>`;
    }
    const pedras = pedrasNaBolsa();
    if (reb.itemId == null || !pedras.some((x) => x.id === reb.itemId)) reb.itemId = pedras[0]?.id ?? null;
    const it = pedras.find((x) => x.id === reb.itemId);
    const sug = it && precoSugerido(it.id);
    return `
      <section>
        <p class="pv-ajuda" style="margin-top:0">Publica 1 ou 2 unidades de uma pedra em <b>Coins</b>, entre 5% e 10% abaixo do menor anúncio atual. Conta: <b>${esc(core.eu?.nick ?? '?')}</b>.</p>
        ${pedras.length ? `
        <div class="pv-linha"><span class="pv-rot">Pedra</span>
          <select class="pv-in" data-c="rebItem">${pedras.map((x) => `<option value="${x.id}" ${x.id === reb.itemId ? 'selected' : ''}>${esc(x.nome)} (${fmt(x.q)} na bolsa)</option>`).join('')}</select>
          <span class="pv-rot" style="min-width:auto">Qtd</span>
          ${[1, 2].map((n) => `<button class="pv-bt ${Number(reb.qtd) === n ? 'on' : ''}" data-a="rebQtd" data-v="${n}" ${it && it.q < n ? 'disabled' : ''}>${n}</button>`).join('')}
          <span class="pv-rot" style="min-width:auto">Desconto</span>
          <input type="number" class="pv-in" data-c="rebDesc" min="5" max="10" step="0.5" value="${sug ? (Math.round(sug.desconto * 1000) / 10) : ''}" placeholder="auto"> %
          <button class="pv-bt" data-a="rebAuto" title="volta ao desconto automático">auto</button>
          <span style="flex:1"></span>
          <button class="pv-bt" data-a="rebPrecos" ${reb.carregando ? 'disabled' : ''}>⟳ Atualizar preços</button>
        </div>
        ${reb.carregando ? '<p class="pv-msg">Lendo os preços do Mercado…</p>' : !reb.mercado ? '' : sug ? `
        <div class="pv-cards">
          <div class="pv-card"><small>Menor anúncio agora</small><b>${sug.fonte === 'menor anúncio' ? preco(sug.ref, 'gold') : '—'}</b><small>${fmt(sug.anuncios)} anúncio(s)</small></div>
          <div class="pv-card"><small>Média de 7 dias</small><b>${sug.media ? preco(sug.media, 'gold') : '—'}</b></div>
          <div class="pv-card"><small>Seu preço (−${Math.round(sug.desconto * 1000) / 10}%)</small><b class="pv-alvo">${preco(sug.preco, 'gold')}</b><small>por unidade · você recebe ${preco(Math.floor(sug.preco * 0.85), 'gold')} líquido</small></div>
        </div>
        <div class="pv-linha" style="margin-top:8px"><button class="pv-bt on" data-a="rebPublicar" ${reb.publicando ? 'disabled' : ''}>${reb.publicando ? 'publicando…' : `📢 Publicar ${Math.min(it.q, Number(reb.qtd) || 1)}× ${esc(it.nome)} por ${fmt(sug.preco)} Coins`}</button></div>`
          : '<p class="pv-msg">Ninguém anuncia nem vendeu esta pedra em Coins recentemente — sem referência de preço.</p>'}
        ` : '<p class="pv-msg">Nenhuma pedra na bolsa desta conta.</p>'}
        ${reb.msg ? `<p>${esc(reb.msg)}</p>` : ''}
      </section>
      <section>
        <h4 class="pv-rot">Anúncios feitos por aqui</h4>
        ${reb.log.length ? `<table class="pv-tab"><tr><th>Quando</th><th>Conta</th><th>Pedra</th><th>Qtd</th><th>Preço</th><th>Referência</th><th>Resultado</th></tr>
          ${reb.log.slice(0, 15).map((l) => `<tr><td>${dataHora(l.em)}</td><td>${esc(l.conta)}</td><td>${esc(l.item)}</td><td>${l.qtd}</td><td>${preco(l.preco, 'gold')}</td><td>${preco(l.ref, 'gold')} ${l.desconto < 0 ? `+${-l.desconto}% (alvo do Rotom)` : `−${l.desconto}%`}</td><td>${esc(l.resultado)}</td></tr>`).join('')}</table>`
          : '<p class="pv-ajuda">Nenhum ainda.</p>'}
      </section>`;
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const fmt2 = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const moedaNome = (m) => (m === 'orb' ? 'Gemas' : 'Coins');
  const moedaIco = (m) => (m === 'orb' ? '💎' : '🪙');
  const dataHora = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

  // ---------------------------------------------------------------- servidor (somente leitura)
  function pedir(msgEnvio, aceitar, ms = 8000) {
    return new Promise((ok, falha) => {
      const ws = core.ws;
      if (!ws || ws.readyState !== 1) return falha(new Error('conta desconectada'));
      const t = setTimeout(() => { ws.removeEventListener('message', f); falha(new Error('sem resposta do servidor')); }, ms);
      function f(ev) {
        if (typeof ev.data !== 'string' || !ev.data.includes('"market"')) return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t !== 'market' || !aceitar(m)) return;
        clearTimeout(t);
        ws.removeEventListener('message', f);
        ok(m);
      }
      ws.addEventListener('message', f);
      core.send(msgEnvio);
    });
  }

  /**
   * Baixa um extrato do mais novo para o mais velho, até passar de `desde` ou acabar.
   * `aba` da resposta: 'historico' (vendas) ou 'historicoCompras'.
   */
  async function baixarExtrato(tipoMsg, abaResp, desde, rotulo) {
    const linhas = [];
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
      msg = `Lendo ${rotulo}… página ${pagina + 1}`;
      pintar();
      const m = await pedir({ t: tipoMsg, pagina }, (x) => x.aba === abaResp && (x.pagina ?? 0) === pagina);
      const lote = (m.linhas ?? []).map((l) => normalizarLinha(l)).filter(Boolean);
      linhas.push(...lote);
      const paginas = Math.ceil((m.total ?? 0) / (m.porPagina ?? 30));
      const maisVelha = lote.length ? Math.min(...lote.map((l) => l.em)) : 0;
      if (!lote.length || pagina + 1 >= paginas || (desde && maisVelha < desde)) {
        return { linhas, completo: pagina + 1 >= paginas || !lote.length };
      }
      await dormir(ESPERA_PAGINA_MS);
    }
    return { linhas, completo: false };
  }

  // ---------------------------------------------------------------- linhas
  const numBr = (s) => Number(String(s).replace(/\./g, '').replace(',', '.')) || 0;

  /** Separa "Ultra Ball ×100" / "100× Ultra Ball" / "Charizard Nv 80" em nome-base e quantidade. */
  function lerDescricao(desc, tipo) {
    let nome = String(desc ?? '').trim();
    let qtd = 0;
    let m = nome.match(/^(.*?)\s*[×x]\s*([\d.,]+)\s*$/i);
    if (m) { nome = m[1]; qtd = numBr(m[2]); }
    else if ((m = nome.match(/^([\d.,]+)\s*[×x]\s+(.*)$/i))) { qtd = numBr(m[1]); nome = m[2]; }
    if (tipo === 'pokemon') nome = nome.replace(/\s+(Nv|Lv|Lvl|Nível)\.?\s*\d+.*$/i, '');
    return { nome: nome.trim() || '—', qtd };
  }

  function normalizarLinha(l) {
    const em = typeof l.em === 'number' ? l.em : Date.parse(l.em);
    if (!Number.isFinite(em)) return null;
    const tipo = l.tipo ?? 'item';
    const d = lerDescricao(l.descricao, tipo);
    const qtd = Math.max(1, Number(l.qtd ?? l.quantidade ?? 0) || d.qtd || 1);
    const bruto = Number(l.bruto ?? l.total ?? l.preco ?? 0) || 0;
    const moeda = l.moeda === 'orb' ? 'orb' : 'gold';
    const chaveItem = l.itemId != null ? `i${l.itemId}` : tipo === 'pokemon' && l.ficha?.speciesId ? `p${l.ficha.speciesId}` : `n${d.nome.toLowerCase()}`;
    return {
      em, tipo, nome: d.nome, qtd, bruto, moeda,
      liquidoServidor: l.liquido != null ? Number(l.liquido) : null,
      quem: l.comprador ?? l.vendedor ?? '',
      shiny: !!l.ficha?.shiny,
      chave: `${tipo}|${chaveItem}|${moeda}`,
    };
  }

  // ---------------------------------------------------------------- taxa (a do jogo)
  function taxaDaVenda(total, moeda, tipo) {
    const t = Math.floor(Number(total) || 0);
    if (t <= 0) return 0;
    if (moeda === 'orb') return taxaMod ? taxaMod.taxaOrbDaVenda(t, tipo) : Math.ceil(t * 0.15);
    const pct = taxaMod?.TAXA_GOLD ?? 0.15;
    return Math.min(t, Math.ceil(t * pct));
  }
  const liquido = (total, moeda, tipo) => Math.max(0, Math.floor(total) - taxaDaVenda(total, moeda, tipo));

  /**
   * Menor preço POR UNIDADE que, vendido o lote de `qtd`, devolve pelo menos `alvoPorUnidade`
   * líquido por unidade. Busca binária, porque a taxa da gema em pokémon é progressiva.
   */
  function precoParaLiquido(alvoPorUnidade, qtd, moeda, tipo) {
    if (!(alvoPorUnidade > 0)) return 0;
    const q = Math.max(1, qtd);
    const alvo = alvoPorUnidade * q;
    let lo = 1, hi = Math.ceil(alvoPorUnidade * 2) + 2;
    while (liquido(hi * q, moeda, tipo) < alvo) hi *= 2;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (liquido(mid * q, moeda, tipo) >= alvo) hi = mid; else lo = mid + 1;
    }
    return lo;
  }

  // ---------------------------------------------------------------- relatório
  function inicioDoPeriodo() {
    const p = PERIODOS.find((x) => x.id === cfg.periodo) ?? PERIODOS[1];
    if (p.id === 'datas') return cfg.de ? new Date(`${cfg.de}T00:00:00`).getTime() : 0;
    if (!p.dias) return 0;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return hoje.getTime() - (p.dias - 1) * DIA;
  }
  function fimDoPeriodo() {
    if (cfg.periodo === 'datas' && cfg.ate) return new Date(`${cfg.ate}T23:59:59.999`).getTime();
    return Infinity;
  }

  function filtrar(linhas) {
    const de = inicioDoPeriodo();
    const ate = fimDoPeriodo();
    const busca = cfg.busca.trim().toLowerCase();
    return linhas.filter((l) => l.em >= de && l.em <= ate
      && (!cfg.moeda || l.moeda === cfg.moeda)
      && (!cfg.tipo || l.tipo === cfg.tipo)
      && (!busca || l.nome.toLowerCase().includes(busca)));
  }

  function montarRelatorio() {
    const compras = filtrar(dados.compras);
    const vendas = filtrar(dados.vendas);
    const grupos = new Map();
    const grupo = (l) => {
      let g = grupos.get(l.chave);
      if (!g) {
        g = { chave: l.chave, nome: l.nome, tipo: l.tipo, moeda: l.moeda, cQtd: 0, cTotal: 0, vQtd: 0, vBruto: 0, vTaxa: 0, vLiq: 0, linhas: [] };
        grupos.set(l.chave, g);
      }
      return g;
    };
    for (const l of compras) { const g = grupo(l); g.cQtd += l.qtd; g.cTotal += l.bruto; g.linhas.push({ ...l, lado: 'compra' }); }
    for (const l of vendas) {
      const g = grupo(l);
      const liq = l.liquidoServidor ?? liquido(l.bruto, l.moeda, l.tipo);
      g.vQtd += l.qtd; g.vBruto += l.bruto; g.vLiq += liq; g.vTaxa += l.bruto - liq;
      g.linhas.push({ ...l, lado: 'venda', liq });
    }
    const margem = Math.max(0, Number(cfg.margem) || 0) / 100;
    const lista = [...grupos.values()].map((g) => {
      const medioCompra = g.cQtd ? g.cTotal / g.cQtd : 0;
      const medioVenda = g.vQtd ? g.vBruto / g.vQtd : 0;
      const lucro = g.cQtd && g.vQtd ? g.vLiq - medioCompra * g.vQtd : null;
      // O lote típico da venda: o que já se vendeu por vez, ou 1 (pokémon é sempre 1).
      const lote = g.tipo === 'pokemon' ? 1 : Math.max(1, Math.round(g.vQtd / Math.max(1, g.linhas.filter((l) => l.lado === 'venda').length)) || 1);
      const empate = medioCompra ? precoParaLiquido(medioCompra, lote, g.moeda, g.tipo) : 0;
      const comMargem = medioCompra ? precoParaLiquido(medioCompra * (1 + margem), lote, g.moeda, g.tipo) : 0;
      g.linhas.sort((a, b) => b.em - a.em);
      return { ...g, medioCompra, medioVenda, lucro, empate, comMargem, saldo: g.cQtd - g.vQtd, lote };
    });
    const ordem = {
      lucro: (a, b) => (b.lucro ?? -Infinity) - (a.lucro ?? -Infinity),
      gasto: (a, b) => b.cTotal - a.cTotal,
      vendido: (a, b) => b.vBruto - a.vBruto,
      nome: (a, b) => a.nome.localeCompare(b.nome),
    }[cfg.ordem] ?? (() => 0);
    lista.sort(ordem);

    const tot = {};
    for (const g of lista) {
      const t = (tot[g.moeda] ??= { gasto: 0, bruto: 0, taxa: 0, liq: 0, lucro: 0 });
      t.gasto += g.cTotal; t.bruto += g.vBruto; t.taxa += g.vTaxa; t.liq += g.vLiq; t.lucro += g.lucro ?? 0;
    }
    return { lista, tot, nCompras: compras.length, nVendas: vendas.length };
  }

  // ---------------------------------------------------------------- UI
  const CSS = `
  #pv-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #pv-fundo.aberto{display:flex}
  #pv-modal{width:min(1100px,97vw);max-height:93vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pv-modal header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pv-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pv-modal header button[data-a="fechar"]{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pv-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  .pv-linha{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
  .pv-rot{font-size:11px;letter-spacing:.5px;text-transform:uppercase;color:#f3c77a;min-width:62px}
  .pv-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pv-bt:hover{background:#6e3d3d}.pv-bt.on{background:#b04ad0;border-color:#f3c77a;color:#fff}.pv-bt:disabled{opacity:.5;cursor:default}
  .pv-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit}
  .pv-in[type=number]{width:64px}.pv-in[type=search]{width:200px}
  .pv-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
  .pv-card{background:#2a1515;border-radius:10px;padding:8px 10px}
  .pv-card small{display:block;opacity:.7;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  .pv-card b{font-size:16px}
  .pv-tab{width:100%;border-collapse:collapse;font-size:12px}
  .pv-tab th{position:sticky;top:50px;background:#4a2828;text-align:right;padding:6px;font-weight:700;color:#f3c77a;white-space:nowrap;cursor:pointer}
  .pv-tab th:first-child,.pv-tab td:first-child{text-align:left}
  .pv-tab td{padding:6px;text-align:right;border-top:1px solid #4a2a2a;white-space:nowrap}
  .pv-tab tr.pv-item{cursor:pointer}.pv-tab tr.pv-item:hover td{background:#432424}
  .pv-tab td small{display:block;opacity:.65}
  .pv-tab .pv-det td{background:#2a1515;white-space:normal}
  .pv-det table{width:100%;font-size:11px}.pv-det td{border:none;padding:2px 6px}
  .pv-pos{color:#7fdc8f}.pv-neg{color:#ff8a8a}.pv-alvo{color:#f3c77a;font-weight:700}
  .pv-msg{opacity:.8;font-style:italic}
  .pv-ajuda{opacity:.65;font-size:11px}`;

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pv-fundo';
    fundo.innerHTML = '<div id="pv-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('input', aoDigitar);
    fundo.addEventListener('change', aoDigitar);
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => { css.remove(); fundo.remove(); document.removeEventListener('keydown', aoEsc); });
  }

  const preco = (v, moeda) => `${moedaIco(moeda)} ${fmt(v)}`;
  const sinal = (v) => (v > 0 ? 'pv-pos' : v < 0 ? 'pv-neg' : '');

  function pintarFiltros() {
    return `
      <section>
        <div class="pv-linha"><span class="pv-rot">Período</span>
          ${PERIODOS.map((p) => `<button class="pv-bt ${cfg.periodo === p.id ? 'on' : ''}" data-a="periodo" data-v="${p.id}">${p.nome}</button>`).join('')}
          ${cfg.periodo === 'datas' ? `<input type="date" class="pv-in" data-c="de" value="${esc(cfg.de)}"> até <input type="date" class="pv-in" data-c="ate" value="${esc(cfg.ate)}">` : ''}
        </div>
        <div class="pv-linha"><span class="pv-rot">Filtros</span>
          <input type="search" class="pv-in" data-c="busca" placeholder="buscar item… (ex.: ultra ball)" value="${esc(cfg.busca)}" spellcheck="false">
          ${[['', 'Todas'], ['gold', '🪙 Coins'], ['orb', '💎 Gemas']].map(([v, n]) => `<button class="pv-bt ${cfg.moeda === v ? 'on' : ''}" data-a="moeda" data-v="${v}">${n}</button>`).join('')}
          ${[['', 'Tudo'], ['item', 'Itens'], ['pokemon', 'Pokémon'], ['diamante', 'Diamantes']].map(([v, n]) => `<button class="pv-bt ${cfg.tipo === v ? 'on' : ''}" data-a="tipo" data-v="${v}">${n}</button>`).join('')}
        </div>
        <div class="pv-linha"><span class="pv-rot">Margem</span>
          <input type="number" class="pv-in" data-c="margem" min="0" step="1" value="${esc(cfg.margem)}"> %
          <span class="pv-ajuda">o lucro que você quer sobre o preço médio de compra, já descontada a taxa do Mercado</span>
          <span style="flex:1"></span>
          <button class="pv-bt" data-a="baixar" ${ocupado ? 'disabled' : ''}>⟳ Atualizar extrato</button>
        </div>
      </section>`;
  }

  function pintar() {
    const modal = document.getElementById('pv-modal');
    if (!modal || !document.getElementById('pv-fundo').classList.contains('aberto')) return;
    const cab = `<header><span>💰 Compras e vendas no Mercado<small>v${VERSAO_VENDAS}</small></span>
      <span class="pv-linha" style="margin:0">
        <button class="pv-bt ${modo === 'relatorio' ? 'on' : ''}" data-a="modo" data-v="relatorio">📊 Relatório</button>
        <button class="pv-bt ${modo === 'rebaixar' ? 'on' : ''}" data-a="modo" data-v="rebaixar">📉 Anunciar abaixo do mercado</button>
        <button class="pv-bt ${modo === 'favoritos' ? 'on' : ''}" data-a="modo" data-v="favoritos">⭐ Favoritos</button>
        <button data-a="fechar" title="Fechar">×</button></span></header>`;
    if (modo === 'rebaixar') { modal.innerHTML = cab + htmlRepor() + htmlRebaixar(); return; }
    if (modo === 'favoritos') { modal.innerHTML = cab + htmlFavoritos(); if (!favUltima && !favLendo) vigiarFavoritos(true); return; }
    const foco = document.activeElement?.dataset?.c;
    const cursor = document.activeElement?.selectionStart;

    let corpo = '';
    if (!dados.baixadoEm) {
      corpo = `${pintarFiltros()}<section class="pv-msg">${esc(msg || (ocupado ? 'Lendo o extrato…' : 'Clique em "⟳ Atualizar extrato" para ler suas compras e vendas (ele só lê quando você pede).'))}</section>`;
    } else {
      const r = montarRelatorio();
      const estadoDados = `${fmt(dados.compras.length)} compras e ${fmt(dados.vendas.length)} vendas lidas`
        + (dados.ate ? ` · desde ${new Date(dados.ate).toLocaleDateString('pt-BR')}` : '')
        + (dados.completo ? ' (extrato inteiro)' : '')
        + ` · atualizado ${dataHora(dados.baixadoEm)}`
        + (!dados.completo && inicioDoPeriodo() < dados.ate ? ' · ⚠ o período escolhido começa antes do que foi lido — clique em "⟳ Atualizar extrato"' : '');
      const cards = Object.entries(r.tot).map(([m, t]) => `
        <div class="pv-card"><small>Comprou (${moedaNome(m)})</small><b>${preco(t.gasto, m)}</b></div>
        <div class="pv-card"><small>Vendeu bruto (${moedaNome(m)})</small><b>${preco(t.bruto, m)}</b></div>
        <div class="pv-card"><small>Taxa paga (${moedaNome(m)})</small><b>${preco(t.taxa, m)}</b></div>
        <div class="pv-card"><small>Recebeu líquido (${moedaNome(m)})</small><b>${preco(t.liq, m)}</b></div>
        <div class="pv-card"><small>Lucro realizado (${moedaNome(m)})</small><b class="${sinal(t.lucro)}">${preco(t.lucro, m)}</b></div>`).join('');
      const th = (id, nome, dica = '') => `<th data-a="ordem" data-v="${id}" title="${esc(dica)}">${nome}${cfg.ordem === id ? ' ▾' : ''}</th>`;
      const linhas = r.lista.map((g) => {
        const det = aberto === g.chave ? `<tr class="pv-det"><td colspan="7"><table>${g.linhas.map((l) => `
            <tr><td>${dataHora(l.em)}</td><td>${l.lado === 'compra' ? '⬇ compra' : '⬆ venda'}</td><td>${fmt(l.qtd)} un.</td>
              <td>${preco(l.bruto / l.qtd, l.moeda)} /un.</td><td>${preco(l.bruto, l.moeda)}${l.lado === 'venda' ? ` → líquido ${preco(l.liq, l.moeda)}` : ''}</td>
              <td>${esc(l.quem)}</td></tr>`).join('')}</table></td></tr>` : '';
        return `
          <tr class="pv-item" data-a="detalhe" data-v="${esc(g.chave)}">
            <td><b>${esc(g.nome)}</b><small>${g.tipo === 'pokemon' ? 'Pokémon' : g.tipo === 'diamante' ? 'Diamante' : 'Item'} · ${moedaNome(g.moeda)}</small></td>
            <td>${g.cQtd ? `${fmt(g.cQtd)} un.<small>médio ${preco(g.medioCompra, g.moeda)} · total ${fmt(g.cTotal)}</small>` : '—'}</td>
            <td>${g.vQtd ? `${fmt(g.vQtd)} un.<small>médio ${preco(g.medioVenda, g.moeda)} · líq. ${fmt(g.vLiq)}</small>` : '—'}</td>
            <td>${g.vQtd ? preco(g.vTaxa, g.moeda) : '—'}</td>
            <td class="${g.lucro == null ? '' : sinal(g.lucro)}">${g.lucro == null ? '—' : preco(g.lucro, g.moeda)}</td>
            <td>${g.empate ? `${preco(g.empate, g.moeda)}<small>por un.${g.lote > 1 ? ` (lote de ${fmt(g.lote)})` : ''}</small>` : '—'}</td>
            <td class="pv-alvo">${g.comMargem ? `${preco(g.comMargem, g.moeda)}<small>por un. · saldo ${fmt(g.saldo)}</small>` : '—'}</td>
          </tr>${det}`;
      }).join('');
      corpo = `
        ${pintarFiltros()}
        <section>
          <div class="pv-linha pv-ajuda">${esc(estadoDados)}${ocupado ? ` · ${esc(msg)}` : ''}</div>
          ${r.lista.length ? `<div class="pv-cards">${cards}</div>` : ''}
        </section>
        <section>
          ${r.lista.length ? `
          <table class="pv-tab">
            <thead><tr>
              ${th('nome', 'Item')}${th('gasto', 'Comprado', 'quantidade · preço médio pago por unidade · total gasto')}
              ${th('vendido', 'Vendido', 'quantidade · preço médio bruto por unidade · total líquido recebido')}
              <th>Taxa paga</th>${th('lucro', 'Lucro', 'líquido das vendas − custo médio das unidades vendidas')}
              <th title="menor preço por unidade em que a venda devolve o preço médio de compra, depois da taxa">Vender p/ empatar</th>
              <th title="menor preço por unidade em que sobra a margem escolhida, depois da taxa">Vender c/ ${fmt2(cfg.margem)}%</th>
            </tr></thead>
            <tbody>${linhas}</tbody>
          </table>
          <p class="pv-ajuda">Clique num item para ver cada compra e venda. Taxa do Mercado: Coins 15%; Gemas 15% em itens e por faixas em pokémon (13% · 10% · 7,5%). "Saldo" = comprado − vendido no período.</p>`
          : `<p class="pv-msg">Nada no período e filtros escolhidos.${dados.completo ? '' : ' Se for mais antigo, use "Tudo" — o extrato é lido até onde o período pede.'}</p>`}
        </section>`;
    }
    modal.innerHTML = cab + corpo;
    if (foco) {
      const el = modal.querySelector(`[data-c="${foco}"]`);
      if (el) { el.focus(); if (cursor != null && el.setSelectionRange && el.type !== 'number' && el.type !== 'date') el.setSelectionRange(cursor, cursor); }
    }
  }

  /** Baixa o que falta para cobrir o período pedido (ou tudo, se `forcar`). */
  async function garantirDados(forcar = false, desdeFixo = null) {
    const desde = desdeFixo ?? inicioDoPeriodo();
    const cobre = dados.baixadoEm && !forcar && (dados.completo || (desde && desde >= dados.ate));
    if (cobre || ocupado) return pintar();
    if (!core.logado) { msg = 'Faça login nesta conta para ler o extrato.'; return pintar(); }
    ocupado = true;
    try {
      if (!taxaMod) taxaMod = await import(`${location.origin}/shared/taxa-mercado.mjs`).catch(() => null);
      const c = await baixarExtrato('market.historicoCompras', 'historicoCompras', desde, 'compras');
      await dormir(ESPERA_PAGINA_MS);
      const v = await baixarExtrato('market.historico', 'historico', desde, 'vendas');
      dados.compras = c.linhas;
      dados.vendas = v.linhas;
      dados.completo = c.completo && v.completo;
      dados.ate = Math.min(...[...c.linhas, ...v.linhas].map((l) => l.em), Date.now());
      dados.baixadoEm = Date.now();
      msg = '';
    } catch (e) {
      msg = `Não deu para ler o extrato: ${e.message}`;
      if (!dados.baixadoEm) dados.baixadoEm = 0;
    }
    ocupado = false;
    pintar();
  }

  let espera = null;
  function aoDigitar(e) {
    const c = e.target.dataset?.c;
    if (!c) return;
    if (c === 'rebItem') { reb.itemId = Number(e.target.value); reb.msg = ''; return pintar(); }
    if (c === 'favCada') { if (e.type === 'change') { fav.cadaMin = Math.max(1, Math.min(60, Number(e.target.value) || 2)); salvarFav(); pintar(); } return; }
    if (c === 'reporTeto') { if (e.type === 'change') { repor.teto = Math.max(0, Math.min(1000, Number(e.target.value) || 0)); salvarRepor(); pintar(); } return; }
    if (c === 'rebDesc') { if (e.type === 'change') { reb.desconto = e.target.value === '' ? null : Number(e.target.value); pintar(); } return; }
    cfg[c] = e.target.value;
    salvarCfg();
    clearTimeout(espera);
    espera = setTimeout(() => pintar(), c === 'busca' ? 250 : 0);
  }

  function aoClicar(e) {
    if (e.target.id === 'pv-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'fechar') fechar();
    else if (a === 'periodo') { cfg.periodo = b.dataset.v; salvarCfg(); pintar(); }
    else if (a === 'moeda' || a === 'tipo' || a === 'ordem') { cfg[a] = b.dataset.v; salvarCfg(); pintar(); }
    else if (a === 'detalhe') { aberto = aberto === b.dataset.v ? null : b.dataset.v; pintar(); }
    else if (a === 'baixar') garantirDados(true);
    else if (a === 'modo') { modo = b.dataset.v; if (modo === 'rebaixar' && !reb.mercado && !contaProtegida()) carregarMercadoReb(); else pintar(); }
    else if (a === 'rebQtd') { reb.qtd = Number(b.dataset.v); pintar(); }
    else if (a === 'rebAuto') { reb.desconto = null; pintar(); }
    else if (a === 'rebPrecos') carregarMercadoReb();
    else if (a === 'rebPublicar') publicarReb();
    else if (a === 'favAtivo') { fav.ativo = !fav.ativo; salvarFav(); }
    else if (a === 'favAgora') { vigiarFavoritos(true); }
    else if (a === 'reporAtivo') { if (!contaProtegida()) { repor.ativo = !repor.ativo; salvarRepor(); reporNota(repor.ativo ? 'reposição LIGADA' : 'reposição desligada'); } }
    else if (a === 'reporPedra') { repor.pedras[b.dataset.v] = b.checked; salvarRepor(); }
    else if (a === 'reporGarantir') { repor.garantir = b.checked; salvarRepor(); }
  }

  function abrir() {
    document.getElementById('pv-fundo').classList.add('aberto');
    pintar(); // o extrato só é lido quando você pede ("⟳ Atualizar extrato")
  }
  function fechar() { document.getElementById('pv-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

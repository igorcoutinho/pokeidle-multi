// PokéIdle Bot — ITENS PRINCIPAIS e HISTÓRICO DE BOSS. Trocado a quente junto com a lógica.
//
// Aba "Principais": os itens que de fato se vendem (Boss Token, peças de TM e fragmentos) —
// quantos tem na bolsa (`eu.items`), o menor preço anunciado agora e a média de venda de 7 dias
// (`market.itens`, a mesma resposta que o Mercado usa), quanto a bolsa vale líquida da taxa,
// quanto já vendeu (do extrato do 💰 Vendas, se ele já foi lido) e quanto caiu na hunt e no boss.
//
// Aba "Boss": cada luta contra boss fica gravada — o evento `bossMorto` traz o nome e os drops,
// `bossPerdeu` marca a derrota. Resumo por boss (lutas, vitórias, drops por luta, % com peça de
// TM) e o histórico paginado. Tudo salvo por conta.
(() => {
  'use strict';
  const VERSAO_ITENS = '1.5.2';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pit-fundo')?.classList.contains('aberto');
  window.__pokeItens?.desmontar?.();

  const limpezas = [];
  const I = {
    versao: VERSAO_ITENS,
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokeItens = I;

  // ---------------------------------------------------------------- constantes
  const PRINCIPAIS = [
    { id: 70000, nome: 'Bronze Boss Token' },
    { id: 59194, nome: 'TM Disk Piece (Elemental)' },
    { id: 40530, nome: 'AoE TM Disk Piece' },
    { id: 70014, nome: 'Mega Fragment' },
    { id: 70015, nome: 'Mega Shiny Fragment' },
    { id: 70012, nome: 'Shiny Stone Fragment' },
    { id: 70011, nome: 'Key Fragment' },
    { id: 70013, nome: 'Bicycle Fragment' },
  ];
  const IDS_TM = new Set([59194, 40530]);
  const CHAVE_DROPS = 'pokeitens.drops.v1';   // { 'AAAA-MM-DD': { itemId: { hunt, boss } } }
  const CHAVE_BOSS = 'pokeitens.boss.v1';     // [{ em, nome, key, venceu, drops, xp, valor, boost }]
  const CHAVE_CFG = 'pokeitens.cfg.v1';
  const BOSS_MAX = 1000;
  const DIAS_GUARDADOS = 60;
  const POR_PAGINA = 10;
  const DIA = 24 * 60 * 60 * 1000;
  const PERIODOS = [{ id: 'hoje', nome: 'Hoje', dias: 1 }, { id: '3d', nome: '3 dias', dias: 3 }, { id: '7d', nome: '7 dias', dias: 7 }, { id: '30d', nome: '30 dias', dias: 30 }, { id: 'tudo', nome: 'Tudo', dias: null }];

  const ler = (k, padrao) => { try { return JSON.parse(localStorage.getItem(k)) ?? padrao; } catch { return padrao; } };
  const gravar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const cfg = { aba: 'principais', periodo: '7d', boss: '', tokensPadrao: 1, custoBoss: {}, moedaLucro: 'orb', tokenGemas: 5, ...ler(CHAVE_CFG, {}) };
  // O antigo 🕵 Multi-acc saiu (pesava): limpa o que ele guardou e a aba, se estava aberta nela.
  for (const k of ['pokeitens.vendedores.v1', 'pokeitens.transacoes.v1', 'pokeitens.varredura.em']) { try { localStorage.removeItem(k); } catch {} }
  for (const k of ['monitor', 'cadaMin', 'conhecidos']) delete cfg[k];
  if (cfg.aba === 'multi') cfg.aba = 'principais';
  const salvarCfg = () => gravar(CHAVE_CFG, cfg);
  let drops = ler(CHAVE_DROPS, {});
  let bosses = ler(CHAVE_BOSS, []);
  let mercado = null;        // { resumo, medias, em }
  let carregandoMercado = false;
  let pagina = 0;
  const sessao = (core.memoria.itensSessao ??= { desde: Date.now(), hunt: {}, boss: {} });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const fmt1 = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  const quando = (ms) => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const diaDe = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const nomeItem = (id, reserva) => core.itens?.get?.(Number(id))?.name ?? core.itens?.get?.(Number(id))?.nome ?? reserva ?? `item ${id}`;
  const naBolsa = (id) => Math.max(0, Math.floor(Number(core.eu?.items?.[id]) || 0));
  const ehPrincipal = (id) => PRINCIPAIS.some((p) => p.id === Number(id));
  const idDoDrop = (d) => {
    if (d.itemId != null) return Number(d.itemId);
    const p = PRINCIPAIS.find((x) => x.nome === d.nome || nomeItem(x.id, x.nome) === d.nome);
    return p?.id ?? null;
  };

  // ---------------------------------------------------------------- lucro do boss
  const BOSS_TOKEN = 70000;
  let entrada = null; // a entrada em boss em andamento: { em, key, nome, antes, tokens }

  /**
   * O que a luta custou para entrar: [{ id, qtd }]. Ordem de confiança: a ficha do boss que o jogo
   * manda no login (`bossesJogaveis[].entrada`), o que sumiu da bolsa ao entrar (medido), o último
   * custo medido desse boss, e por fim o padrão (1 Boss Token, ajustável).
   */
  function entradaDaLuta(e) {
    const key = e.key ?? entrada?.key ?? null;
    const ficha = (core.bossesJogaveis ?? []).find((b) => b.key === key)?.entrada;
    if (ficha?.itemId && ficha.qtd) return [{ id: Number(ficha.itemId), qtd: Number(ficha.qtd), fonte: 'ficha' }];
    const medido = entrada && (entrada.key === key || entrada.nome === e.nome) && Date.now() - entrada.em < 15 * 60_000 ? entrada.tokens : null;
    if (medido) return [{ id: BOSS_TOKEN, qtd: medido, fonte: 'medido' }];
    const salvo = cfg.custoBoss[key ?? e.nome];
    if (salvo) return [{ id: BOSS_TOKEN, qtd: salvo, fonte: 'medido antes' }];
    return null; // usa o padrão na conta
  }
  const custoDaLuta = (b) => b.entrada ?? [{ id: BOSS_TOKEN, qtd: Math.max(0, Number(cfg.tokensPadrao) || 1), fonte: 'padrão' }];

  // A moeda do lucro (Gemas por padrão — é nela que esses itens se vendem). O que vier na outra
  // moeda é convertido pela cotação do próprio Mercado: a mediana de (média em Coins ÷ média em
  // Gemas) dos itens que têm venda nas duas.
  const ML = () => (cfg.moedaLucro === 'gold' ? 'gold' : 'orb');
  const outra = (m) => (m === 'orb' ? 'gold' : 'orb');
  function coinsPorGema() {
    const r = [];
    for (const md of Object.values(mercado?.medias ?? {})) {
      const g = Number(md?.gold?.media), o = Number(md?.orb?.media);
      if (g > 0 && o > 0) r.push(g / o);
    }
    if (!r.length) return null;
    r.sort((a, b) => a - b);
    return r[Math.floor(r.length / 2)];
  }
  /** Converte `v` da moeda `de` para a moeda do lucro (null se não há cotação). */
  function conv(v, de) {
    if (!v) return 0;
    if (de === ML()) return v;
    const c = coinsPorGema();
    if (!c) return null;
    return de === 'gold' ? v / c : v * c;
  }
  const casaItem = (l, id) => l.chave?.includes(`|i${id}|`) || l.nome?.toLowerCase() === nomeItem(id).toLowerCase();

  /** Preço de UMA unidade para o custo, na moeda do lucro: média do que você PAGOU; sem compra, o mercado. */
  function custoUnitario(id) {
    // O preço que VOCÊ informou para o Boss Token (em Gemas) vale acima de tudo.
    if (Number(id) === BOSS_TOKEN && Number(cfg.tokenGemas) > 0) {
      const v = conv(Number(cfg.tokenGemas), 'orb');
      if (v != null) return { v, fonte: `você pagou ${fmt(cfg.tokenGemas)} 💎 cada` };
    }
    const dados = window.__pokeVendasDados;
    const pago = { gold: { q: 0, t: 0 }, orb: { q: 0, t: 0 } };
    for (const l of dados?.compras ?? []) if (casaItem(l, id)) { const k = l.moeda === 'orb' ? 'orb' : 'gold'; pago[k].q += l.qtd; pago[k].t += l.bruto; }
    const q = pago.gold.q + pago.orb.q;
    if (q) {
      const t = (pago[ML()].t) + (conv(pago[outra(ML())].t, outra(ML())) ?? 0);
      const misturou = pago[outra(ML())].q > 0;
      const rot = !misturou ? '' : pago[ML()].q ? ', parte convertida' : `, pagos em ${outra(ML()) === 'gold' ? 'Coins' : 'Gemas'} e convertidos`;
      return { v: t / q, fonte: `média paga (${fmt(q)} comprados${rot})` };
    }
    for (const m of [ML(), outra(ML())]) {
      const md = Number(mercado?.medias?.[id]?.[m]?.media);
      if (md) { const v = conv(md, m); if (v != null) return { v, fonte: `média de venda 7 dias${m !== ML() ? ' (convertida)' : ''}` }; }
    }
    return { v: 0, fonte: 'sem preço' };
  }
  /** Preço de venda HOJE, na moeda do lucro: menor anúncio; sem anúncio, a média de 7 dias; senão a outra moeda convertida. */
  function precoHoje(id) {
    const r = mercado?.resumo?.[id];
    for (const m of [ML(), outra(ML())]) {
      const min = r?.anuncios ? Number(m === 'orb' ? r.minOrb : r.minGold) : 0;
      const v = min || Number(mercado?.medias?.[id]?.[m]?.media) || 0;
      if (v) { const c = conv(v, m); if (c != null) return c; }
    }
    return 0;
  }

  function lucroBoss() {
    const de = inicioPeriodo();
    const lutas = bosses.filter((b) => b.em >= de);
    const custos = new Map(); // id → qtd gasta
    const caiu = new Map();   // id → { qtd, nome }
    const porBoss = new Map();
    for (const b of lutas) {
      let custoLuta = 0;
      for (const c of custoDaLuta(b)) {
        custos.set(c.id, (custos.get(c.id) ?? 0) + c.qtd);
        custoLuta += c.qtd * custoUnitario(c.id).v;
      }
      let valorLuta = 0;
      for (const x of b.drops) {
        if (x.id == null) continue;
        const c = caiu.get(x.id) ?? { qtd: 0, nome: x.nome };
        c.qtd += x.qtd;
        caiu.set(x.id, c);
        valorLuta += liquido(x.qtd * precoHoje(x.id));
      }
      const r = porBoss.get(b.nome) ?? { nome: b.nome, lutas: 0, vit: 0, custo: 0, valor: 0, fonteCusto: custoDaLuta(b)[0]?.fonte };
      r.lutas++; if (b.venceu) r.vit++;
      r.custo += custoLuta; r.valor += valorLuta;
      porBoss.set(b.nome, r);
    }
    let custoTotal = 0;
    const custoLinhas = [...custos.entries()].map(([id, qtd]) => {
      const u = custoUnitario(id);
      custoTotal += qtd * u.v;
      return { id, qtd, unit: u.v, fonte: u.fonte, total: qtd * u.v };
    });
    // Vendas: a parte do que vendeu que veio do BOSS (o mesmo item também cai na hunt).
    let realizado = 0, realizadoOrb = 0, presumido = 0;
    const itens = [...caiu.entries()].map(([id, c]) => {
      const dp = dropsNoPeriodo(id);
      const parte = dp.boss + dp.hunt > 0 ? dp.boss / (dp.boss + dp.hunt) : 1;
      const v = vendasDoItem(id, nomeItem(id, c.nome));
      const vendG = v ? v.vendas.gold : { qtd: 0, total: 0 };
      const vendO = v ? v.vendas.orb : { qtd: 0, total: 0 };
      const qtdVendida = Math.min(c.qtd, (vendG.qtd + vendO.qtd) * parte);
      const naMoeda = { gold: liquido(vendG.total) * parte, orb: liquido(vendO.total) * parte };
      const convOutra = conv(naMoeda[outra(ML())], outra(ML()));
      const liqG = naMoeda[ML()] + (convOutra ?? 0);          // tudo na moeda do lucro
      const liqO = convOutra == null ? naMoeda[outra(ML())] : 0; // sem cotação: fica à parte
      const sobra = Math.max(0, c.qtd - qtdVendida);
      const ph = precoHoje(id);
      const pres = liquido(sobra * ph);
      realizado += liqG; realizadoOrb += liqO; presumido += pres;
      return { id, nome: nomeItem(id, c.nome), caiu: c.qtd, parte, qtdVendida, liqG, liqO, sobra, ph, pres };
    }).sort((a, b) => (b.liqG + b.pres) - (a.liqG + a.pres));
    return { lutas: lutas.length, custoTotal, custoLinhas, itens, realizado, realizadoOrb, presumido,
      porBoss: [...porBoss.values()].sort((a, b) => b.lutas - a.lutas), temVendas: !!window.__pokeVendasDados?.baixadoEm, ate: window.__pokeVendasDados?.ate };
  }

  function htmlLucro() {
    const L = lucroBoss();
    if (!L.lutas) return '';
    const M = ML();
    const sinal = (n) => `<b class="${n >= 0 ? 'pit-v' : 'pit-d'}">${n >= 0 ? '+' : '−'}${preco(Math.abs(n), M)}</b>`;
    const lucroReal = L.realizado - L.custoTotal;
    const lucroTotal = L.realizado + L.presumido - L.custoTotal;
    return `<section>
        <h4>💰 Lucro do boss (no período)</h4>
        <div class="pit-linha">
          <button class="pit-bt" data-a="extrato">⟳ ler compras e vendas (extrato)</button>
          <button class="pit-bt" data-a="mercado">⟳ preços de hoje</button>
          Moeda: <button class="pit-bt ${M === 'orb' ? 'on' : ''}" data-a="moedaLucro" data-v="orb">💎 Gemas</button><button class="pit-bt ${M === 'gold' ? 'on' : ''}" data-a="moedaLucro" data-v="gold">🪙 Coins</button>
          <span class="pit-ajuda">${L.temVendas ? `extrato lido${L.ate ? ` desde ${quando(L.ate)}` : ''}` : '⚠ extrato ainda não lido — clique em "ler compras e vendas"'}${mercado ? ` · preços de ${quando(mercado.em)}` : ' · sem preços'}</span>
          <span style="flex:1"></span>
          <span class="pit-ajuda">Boss Token custou</span> <input type="number" class="pit-in" data-c="tokenGemas" min="0" step="0.5" value="${esc(cfg.tokenGemas ?? '')}" placeholder="extrato" style="width:60px"> <span class="pit-ajuda">💎 cada (vazio = média do extrato)</span>
          <span class="pit-ajuda">· sem dado de entrada, cada luta custa</span> <input type="number" class="pit-in" data-c="tokensPadrao" min="0" max="20" value="${esc(cfg.tokensPadrao)}" style="width:54px"> <span class="pit-ajuda">Boss Token</span>
        </div>
        <div class="pit-cards">
          <div class="pit-card"><small>Custo (${fmt(L.lutas)} lutas)</small><b>${preco(L.custoTotal, M)}</b>
            <small style="text-transform:none">${L.custoLinhas.map((c) => `${fmt(c.qtd)}× ${esc(nomeItem(c.id))} a ${preco(c.unit, M)} — ${esc(c.fonte)}`).join('<br>')}</small></div>
          <div class="pit-card"><small>Vendido (líquido −15%)</small><b>${preco(L.realizado, M)}</b>${L.realizadoOrb ? `<small style="text-transform:none">+ ${preco(L.realizadoOrb, outra(M))}</small>` : ''}</div>
          <div class="pit-card"><small>Lucro realizado</small>${sinal(lucroReal)}<small style="text-transform:none">vendido − custo</small></div>
          <div class="pit-card"><small>A vender (preço de hoje −15%)</small><b>${preco(L.presumido, M)}</b><small style="text-transform:none">o que caiu e ainda não vendeu</small></div>
          <div class="pit-card"><small>Lucro presumido</small>${sinal(lucroTotal)}<small style="text-transform:none">vendido + a vender − custo</small></div>
        </div>
        <table class="pit-tab" style="margin-top:8px"><tr><th>Item que caiu no boss</th><th>Caiu</th><th title="das vendas desse item no período, a parte que veio do boss (o resto caiu na hunt)">Vendido (do boss)</th><th>Líquido recebido</th><th>Sobrando</th><th>Preço hoje</th><th>A vender (líq.)</th></tr>
          ${L.itens.map((x) => `<tr><td><b>${esc(x.nome)}</b></td><td>${fmt(x.caiu)}</td>
            <td>${fmt(x.qtdVendida)}${x.parte < 1 ? `<small>${Math.round(x.parte * 100)}% das vendas</small>` : ''}</td>
            <td>${x.liqG ? preco(x.liqG, M) : '—'}${x.liqO ? `<small>${preco(x.liqO, outra(M))}</small>` : ''}</td>
            <td>${fmt(x.sobra)}</td><td>${x.ph ? preco(x.ph, M) : '—'}</td><td>${x.pres ? preco(x.pres, M) : '—'}</td></tr>`).join('')}
        </table>
        <table class="pit-tab" style="margin-top:8px"><tr><th>Por boss</th><th>Lutas</th><th>Custo</th><th>Drops a preço de hoje (líq.)</th><th>Lucro presumido</th><th>Por luta</th></tr>
          ${L.porBoss.map((r) => `<tr><td><b>${esc(r.nome)}</b><small>custo: ${esc(r.fonteCusto ?? 'padrão')}</small></td><td>${fmt(r.lutas)}</td><td>${preco(r.custo, M)}</td><td>${preco(r.valor, M)}</td>
            <td>${sinal(r.valor - r.custo)}</td><td>${sinal((r.valor - r.custo) / r.lutas)}</td></tr>`).join('')}
        </table>
        <p class="pit-ajuda">${(() => { const c = coinsPorGema(); return c ? `Cotação do Mercado: 1 💎 ≈ ${fmt(c)} 🪙 (o que foi na outra moeda entra convertido). ` : 'Sem cotação Coins/Gemas — o que foi na outra moeda aparece à parte. '; })()}Custo = itens de entrada × o que você pagou neles (média do extrato de compras; sem compra, o preço do mercado). Vendido = suas vendas desses itens no período, só a parte que caiu no boss (o resto é da hunt), já sem a taxa de 15%. A vender = o que caiu e ainda não vendeu × o menor anúncio de hoje, −15%. Lucro presumido = vendido + a vender − custo.</p>
      </section>`;
  }

  function inicioPeriodo() {
    const p = PERIODOS.find((x) => x.id === cfg.periodo) ?? PERIODOS[2];
    if (!p.dias) return 0;
    const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
    return hoje.getTime() - (p.dias - 1) * DIA;
  }

  // ---------------------------------------------------------------- gravação dos drops
  function somarDrop(itemId, qtd, fonte) {
    if (!ehPrincipal(itemId) || !(qtd > 0)) return;
    const dia = diaDe(Date.now());
    const d = (drops[dia] ??= {});
    const it = (d[itemId] ??= { hunt: 0, boss: 0 });
    it[fonte] += qtd;
    const s = sessao[fonte];
    s[itemId] = (s[itemId] ?? 0) + qtd;
  }

  function podarDias() {
    const limite = diaDe(Date.now() - DIAS_GUARDADOS * DIA);
    for (const dia of Object.keys(drops)) if (dia < limite) delete drops[dia];
  }

  function aoMensagem(ev) {
    if (typeof ev.data !== 'string') return;
    const d = ev.data;
    if (d.includes('"t":"batalha"')) {
      if (!d.includes('"morte"') && !d.includes('"bossMorto"') && !d.includes('"bossPerdeu"') && !d.includes('"bossEntrou"')) return;
      let m;
      try { m = JSON.parse(d); } catch { return; }
      let mudou = false;
      for (const e of m.ev ?? []) {
        if (e.k === 'bossEntrou') {
          // A entrada gasta o item na hora: guarda a bolsa de antes e confere no próximo `estado`.
          entrada = { em: Date.now(), key: e.key ?? null, nome: e.nome ?? '?', antes: naBolsa(BOSS_TOKEN), tokens: null };
        } else if (e.k === 'morte' && e.quem === 'selvagem') {
          for (const x of e.drops ?? []) { const id = idDoDrop(x); if (id != null) { somarDrop(id, Number(x.qtd) || 1, 'hunt'); mudou = true; } }
        } else if (e.k === 'bossMorto') {
          const lista = (e.drops ?? []).map((x) => ({ id: idDoDrop(x), nome: x.nome ?? nomeItem(x.itemId), qtd: Number(x.qtd) || 1 }));
          for (const x of lista) if (x.id != null) somarDrop(x.id, x.qtd, 'boss');
          bosses.unshift({ em: Date.now(), nome: e.nome ?? '?', key: e.key ?? null, venceu: true, drops: lista, entrada: entradaDaLuta(e),
            xp: Number(e.xpTreinador ?? e.xp ?? 0) || 0, valor: Number(e.valor ?? 0) || 0, boost: !!e.lootBoost });
          bosses = bosses.slice(0, BOSS_MAX);
          gravar(CHAVE_BOSS, bosses);
          mudou = true;
        } else if (e.k === 'bossPerdeu') {
          bosses.unshift({ em: Date.now(), nome: e.nome ?? '?', key: e.key ?? null, venceu: false, drops: [], entrada: entradaDaLuta(e) });
          bosses = bosses.slice(0, BOSS_MAX);
          gravar(CHAVE_BOSS, bosses);
          mudou = true;
        }
      }
      if (mudou) { podarDias(); gravar(CHAVE_DROPS, drops); if (estaAberto()) pintar(); }
    } else if (entrada && entrada.tokens == null && d.includes('"t":"estado"')) {
      // O core mescla o estado no mesmo evento: lê a bolsa logo depois.
      setTimeout(() => {
        if (!entrada || entrada.tokens != null) return;
        const gastou = entrada.antes - naBolsa(BOSS_TOKEN);
        if (gastou > 0) {
          entrada.tokens = gastou;
          cfg.custoBoss[entrada.key ?? entrada.nome] = gastou;
          salvarCfg();
        }
      }, 0);
    } else if (d.includes('"t":"market"') && d.includes('"aba":"itens"')) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      if (m.t === 'market' && m.aba === 'itens') {
        mercado = { resumo: m.resumo ?? {}, medias: m.medias ?? {}, em: Date.now() };
        carregandoMercado = false;
        if (estaAberto()) pintar();
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
  const vigia = setInterval(ligarWs, 1000);
  limpezas.push(() => { clearInterval(vigia); wsOuvido?.removeEventListener('message', aoMensagem); });

  function pedirMercado() {
    if (carregandoMercado) return;
    carregandoMercado = true;
    if (!core.send({ t: 'market.itens' })) carregandoMercado = false;
    setTimeout(() => { if (carregandoMercado) { carregandoMercado = false; if (estaAberto()) pintar(); } }, 8000);
  }

  // ---------------------------------------------------------------- contas
  const taxa = (total) => Math.ceil(Math.max(0, total) * 0.15); // itens: 15% em Coins e em Gemas (taxa-mercado.mjs)
  const liquido = (total) => Math.max(0, Math.floor(total) - taxa(total));

  function dropsNoPeriodo(id) {
    const de = diaDe(inicioPeriodo());
    let hunt = 0, boss = 0;
    for (const [dia, itens] of Object.entries(drops)) {
      if (cfg.periodo !== 'tudo' && dia < de) continue;
      hunt += itens[id]?.hunt ?? 0;
      boss += itens[id]?.boss ?? 0;
    }
    return { hunt, boss };
  }

  /** O que o 💰 Vendas já leu do extrato, filtrado por este item e pelo período. */
  function vendasDoItem(id, nome) {
    const dados = window.__pokeVendasDados;
    if (!dados?.baixadoEm) return null;
    const de = inicioPeriodo();
    const casa = (l) => l.em >= de && (l.chave?.includes(`|i${id}|`) || l.nome?.toLowerCase() === String(nome).toLowerCase());
    const soma = (lista) => lista.filter(casa).reduce((s, l) => {
      const k = l.moeda === 'orb' ? 'orb' : 'gold';
      s[k].qtd += l.qtd; s[k].total += l.bruto;
      return s;
    }, { gold: { qtd: 0, total: 0 }, orb: { qtd: 0, total: 0 } });
    return { vendas: soma(dados.vendas ?? []), compras: soma(dados.compras ?? []), ate: dados.ate };
  }

  // ---------------------------------------------------------------- UI
  const CSS = `
  #pit-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #pit-fundo.aberto{display:flex}
  #pit-modal{width:min(1100px,97vw);max-height:93vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pit-modal header{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pit-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pit-modal header button.pit-x{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pit-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  #pit-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a}
  .pit-linha{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:6px}
  .pit-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pit-bt:hover{background:#6e3d3d}.pit-bt.on{background:#b04ad0;border-color:#f3c77a;color:#fff}.pit-bt:disabled{opacity:.5;cursor:default}
  .pit-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit}
  .pit-sw{position:relative;width:44px;height:24px;border-radius:12px;background:#6a4a4a;cursor:pointer;border:none;flex:none}
  .pit-sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
  .pit-sw.on{background:#2f9a4a}.pit-sw.on::after{left:23px}
  .pit-tab{width:100%;border-collapse:collapse;font-size:12px}
  .pit-tab th{text-align:right;color:#f3c77a;padding:5px 6px;font-weight:700;white-space:nowrap}
  .pit-tab td{padding:6px;border-top:1px solid #4a2a2a;text-align:right;white-space:nowrap;vertical-align:top}
  .pit-tab th:first-child,.pit-tab td:first-child{text-align:left}
  .pit-tab td small{display:block;opacity:.65}
  .pit-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
  .pit-card{background:#2a1515;border-radius:10px;padding:8px 10px}
  .pit-card small{display:block;opacity:.7;font-size:11px;text-transform:uppercase;letter-spacing:.4px}
  .pit-card b{font-size:16px}
  .pit-drops{display:flex;flex-wrap:wrap;gap:3px}
  .pit-drops span{background:#2a1515;border-radius:5px;padding:1px 6px}
  .pit-drops .pit-tm{background:#5a2a6a;color:#ffd6ff;font-weight:700}
  .pit-v{color:#7fdc8f;font-weight:800}.pit-d{color:#ff8a8a;font-weight:800}
  .pit-ajuda{opacity:.65;font-size:11px}
  .pit-pags{display:flex;gap:8px;align-items:center;justify-content:center;margin-top:8px}`;

  // ---------------------------------------------------------------- 🎒 Exp Share (item segurado)
  // Quem segura o Exp. Share (item 70050, `heldItemId`) ganha uma % do XP de cada abate do pokémon de
  // batalha. O jogo só deixa mexer 1× por minuto (equipar OU remover). A automação: quem chega no
  // "tirar no nível N" perde o item e, no minuto seguinte, o próximo da FILA recebe — uma ação por minuto.
  const XSH_ID = 70050;
  const CHAVE_XSH = 'pokeitens.xpshare.v1';
  const xsh = { ativo: false, alvos: {}, fila: [], log: [], busca: '', ...ler(CHAVE_XSH, {}) };
  const salvarXsh = () => gravar(CHAVE_XSH, { ...xsh, log: xsh.log.slice(0, 30), busca: '' });
  let xshUltimaAcao = 0;
  const XSH_ESPERA = 61_000; // 1 min do jogo + 1 s de garantia
  const pokes = () => core.eu?.pokemons ?? [];
  const segura = (p) => Number(p?.heldItemId) === XSH_ID;
  const noDeposito = (p) => p && p.slot == null; // só pokémon guardado (fora da equipe) recebe pela automação
  const nomePk = (p) => `${p.shiny ? '✨' : ''}${p.apelido || p.nick || p.nome} Nv ${fmt(p.level)}`;
  /** O que diferencia dois pokémon da mesma espécie: potência, qualidade e IV somado. */
  const idPk = (p) => {
    const iv = Object.values(p.ivs ?? {}).reduce((t, v) => t + (Number(v) || 0), 0);
    const q = Number(p.quality ?? p.qualidade);
    return [`P${Number(p.potencia) || 1}`, q ? `Q ${q.toFixed(3).replace('.', ',')}` : '', iv ? `IV ${iv}` : ''].filter(Boolean).join(' · ');
  };
  /** 👁 Abre a FICHA oficial do jogo (o mesmo link de pokémon do chat): sprite, stats, IVs, golpes. */
  function verFicha(id) {
    const chat = document.getElementById('chat-msgs');
    const nick = core.eu?.nick;
    if (!chat || !nick) return false;
    fechar();
    const el = document.createElement('span');
    el.className = 'm-pk-link';
    el.dataset.nick = nick;
    el.dataset.pk = String(id);
    el.style.display = 'none';
    chat.appendChild(el);
    el.click();
    el.remove();
    return true;
  }
  const btFicha = (p) => `<button class="pit-bt" data-a="xshFicha" data-v="${p.id}" title="abrir a ficha do pokémon no jogo">👁 ficha</button>`;
  const celNome = (p) => `<b>${esc(nomePk(p))}</b><br><small>${esc(idPk(p))}</small>`;
  const xshNota = (txt) => { xsh.log.unshift({ em: Date.now(), txt }); xsh.log = xsh.log.slice(0, 30); salvarXsh(); console.log('[Exp Share]', txt); if (estaAberto() && cfg.aba === 'xsh') pintar(); };

  function xshAcao(tipo, p, motivo) {
    const falta = XSH_ESPERA - (Date.now() - xshUltimaAcao);
    if (falta > 0) return { ok: false, msg: `espere ${Math.ceil(falta / 1000)} s (o jogo só deixa mexer 1× por minuto)` };
    if (!core.send({ t: tipo === 'tirar' ? 'xpshareheld.remover' : 'xpshareheld.equipar', pokemonId: p.id })) return { ok: false, msg: 'conta desconectada' };
    xshUltimaAcao = Date.now();
    clearTimeout(xshAcao.t); xshAcao.t = setTimeout(xshPasso, XSH_ESPERA + 50); // o próximo passo sai assim que o jogo liberar (61 s)
    xshNota(`${tipo === 'tirar' ? '➖ tirei de' : '➕ coloquei em'} ${nomePk(p)}${motivo ? ` — ${motivo}` : ''}`);
    return { ok: true };
  }

  /** Um passo da automação (no máximo 1 ação por minuto). */
  function xshPasso() {
    if (!xsh.ativo || !core.logado || Date.now() - xshUltimaAcao < XSH_ESPERA) return;
    const lista = pokes();
    // 1) quem já chegou no nível-alvo sai
    for (const p of lista.filter(segura)) {
      const alvo = Number(xsh.alvos[p.id]) || 0;
      if (alvo && p.level >= alvo) { xshAcao('tirar', p, `chegou no Nv ${fmt(alvo)}`); return; }
    }
    // 2) sobrou Exp Share na bolsa: o próximo da fila (que ainda não chegou no alvo dele) recebe
    if ((Number(core.eu?.items?.[XSH_ID]) || 0) < 1) return;
    xsh.fila = xsh.fila.filter((id) => lista.some((p) => p.id === id));
    for (const id of xsh.fila) {
      const p = lista.find((x) => x.id === id);
      if (!p || segura(p) || !noDeposito(p)) continue;
      const alvo = Number(xsh.alvos[p.id]) || 0;
      if (alvo && p.level >= alvo) continue;
      const r = xshAcao('colocar', p, 'próximo da fila');
      if (r.ok) { xsh.fila = xsh.fila.filter((x) => x !== id); salvarXsh(); }
      return;
    }
  }
  const vigiaXsh = setInterval(xshPasso, 10_000);
  limpezas.push(() => clearInterval(vigiaXsh));

  function htmlXsh() {
    const lista = pokes();
    const naBolsa = Number(core.eu?.items?.[XSH_ID]) || 0;
    const usando = lista.filter(segura).sort((a, b) => b.level - a.level);
    const q = String(xsh.busca ?? '').trim().toLowerCase();
    const podem = lista.filter((p) => !segura(p) && noDeposito(p) && (!q || String(p.apelido || p.nick || p.nome).toLowerCase().includes(q)))
      .sort((a, b) => (xsh.fila.includes(b.id) - xsh.fila.includes(a.id)) || a.level - b.level).slice(0, 40);
    const falta = Math.max(0, XSH_ESPERA - (Date.now() - xshUltimaAcao));
    const inAlvo = (p) => `<input type="number" class="pit-in" data-c="xshAlvo" data-v="${p.id}" min="1" value="${esc(xsh.alvos[p.id] ?? '')}" placeholder="—" style="width:80px">`;
    xsh.fila = xsh.fila.filter((id) => noDeposito(lista.find((p) => p.id === id)) || !lista.some((p) => p.id === id));
    const filaNomes = xsh.fila.map((id) => lista.find((p) => p.id === id)).filter(Boolean);
    return `<section>
        <div class="pit-linha">
          <button class="pit-sw ${xsh.ativo ? 'on' : ''}" data-a="xshAtivo"></button> <b>Automação</b>
          <span class="pit-ajuda">Na bolsa: <b>${naBolsa}</b> · equipados: <b>${usando.length}</b> · ${falta ? `próxima mexida liberada em ${Math.ceil(falta / 1000)} s` : 'pode mexer agora'}</span>
        </div>
        <p class="pit-ajuda">Quem chega no <b>"tirar no nível"</b> perde o Exp Share e, no minuto seguinte, o <b>próximo da fila</b> recebe (o jogo só deixa mexer 1× por minuto — o bot espera sozinho). Sobrou Exp Share na bolsa? O próximo da fila recebe também. Pokémon no posto da casa não pode segurar (o jogo recusa).</p>
      </section>
      <section>
        <h4>Usando (${usando.length})</h4>
        ${usando.length ? `<table class="pit-tab"><tr><th>Pokémon</th><th>Onde</th><th>Tirar no nível</th><th></th></tr>
          ${usando.map((p) => `<tr><td>${celNome(p)} ${btFicha(p)}</td><td>${p.slot != null ? `equipe #${p.slot + 1}` : 'guardado'}</td><td>${inAlvo(p)}${xsh.alvos[p.id] ? `<small>faltam ${fmt(Math.max(0, xsh.alvos[p.id] - p.level))} níveis</small>` : ''}</td>
            <td><button class="pit-bt" data-a="xshTirar" data-v="${p.id}">➖ tirar agora</button></td></tr>`).join('')}</table>`
          : '<span class="pit-ajuda">Ninguém segura Exp Share agora.</span>'}
      </section>
      <section>
        <h4>Fila para receber (${filaNomes.length})</h4>
        ${filaNomes.length ? `<table class="pit-tab">${filaNomes.map((p, i) => `<tr><td>${i + 1}º</td><td style="text-align:left">${celNome(p)} ${btFicha(p)}</td><td>tirar no nível ${inAlvo(p)}</td>
          <td><button class="pit-bt" data-a="xshSobe" data-v="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="pit-bt" data-a="xshFila" data-v="${p.id}">✕</button></td></tr>`).join('')}</table>`
          : '<span class="pit-ajuda">Vazia — use "➕ fila" na lista abaixo.</span>'}
      </section>
      <section>
        <h4>Podem usar — depósito</h4>
        <div class="pit-linha"><input class="pit-in" data-c="xshBusca" placeholder="buscar pokémon…" value="${esc(xsh.busca ?? '')}" spellcheck="false" style="width:220px"><span class="pit-ajuda">só do depósito · mostrando ${podem.length} (menor nível primeiro)</span></div>
        <table class="pit-tab"><tr><th>Pokémon</th><th>Onde</th><th>Tirar no nível</th><th></th></tr>
          ${podem.map((p) => `<tr><td>${celNome(p)} ${btFicha(p)}</td><td>${p.slot != null ? `equipe #${p.slot + 1}` : 'guardado'}</td><td>${inAlvo(p)}</td>
            <td><button class="pit-bt ${xsh.fila.includes(p.id) ? 'on' : ''}" data-a="xshFila" data-v="${p.id}">${xsh.fila.includes(p.id) ? `na fila (${xsh.fila.indexOf(p.id) + 1}º)` : '➕ fila'}</button>
              <button class="pit-bt" data-a="xshColocar" data-v="${p.id}" ${naBolsa < 1 ? 'disabled title="sem Exp Share na bolsa"' : ''}>colocar agora</button></td></tr>`).join('')}
        </table>
      </section>
      ${xsh.log.length ? `<section><h4>Registro</h4><table class="pit-tab">${xsh.log.slice(0, 12).map((l) => `<tr><td>${quando(l.em)}</td><td style="text-align:left">${esc(l.txt)}</td></tr>`).join('')}</table></section>` : ''}`;
  }

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pit-fundo';
    fundo.innerHTML = '<div id="pit-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('change', (e) => {
      const c = e.target.dataset.c;
      if (c === 'boss') { cfg.boss = e.target.value; pagina = 0; salvarCfg(); pintar(); }
      if (c === 'xshAlvo') { const v = e.target.value; if (v === '') delete xsh.alvos[e.target.dataset.v]; else xsh.alvos[e.target.dataset.v] = Math.max(1, Number(v) || 1); salvarXsh(); pintar(); }
      if (c === 'xshBusca') { xsh.busca = e.target.value; pintar(); }
      if (c === 'tokenGemas') { cfg.tokenGemas = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0); salvarCfg(); pintar(); }
      if (c === 'tokensPadrao') { cfg.tokensPadrao = Math.max(0, Math.min(20, Number(e.target.value) || 0)); salvarCfg(); pintar(); }
    });
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => { css.remove(); fundo.remove(); document.removeEventListener('keydown', aoEsc); });
  }
  const estaAberto = () => document.getElementById('pit-fundo')?.classList.contains('aberto');
  const preco = (v, moeda) => (v == null ? '—' : `${moeda === 'orb' ? '💎' : '🪙'} ${fmt(v)}`);

  function htmlPeriodo() {
    return `<div class="pit-linha"><b style="color:#f3c77a;font-size:11px;text-transform:uppercase">Período</b>
      ${PERIODOS.map((p) => `<button class="pit-bt ${cfg.periodo === p.id ? 'on' : ''}" data-a="periodo" data-v="${p.id}">${p.nome}</button>`).join('')}</div>`;
  }

  function htmlPrincipais() {
    const horas = Math.max(1 / 60, (Date.now() - sessao.desde) / 3_600_000);
    let totGold = 0, totOrb = 0;
    const linhas = PRINCIPAIS.map((p) => {
      const nome = p.nome;                    // o rótulo daqui ("TM Disk Piece" sozinho não diz qual é)
      const nomeJogo = nomeItem(p.id, p.nome); // o nome que o extrato do Mercado usa
      const q = naBolsa(p.id);
      const r = mercado?.resumo?.[p.id];
      const md = mercado?.medias?.[p.id];
      const minG = r?.anuncios ? r.minGold : null;
      const minO = r?.anuncios ? r.minOrb : null;
      const valG = q && minG ? liquido(q * minG) : 0;
      const valO = q && minO ? liquido(q * minO) : 0;
      totGold += valG; totOrb += valO;
      const dp = dropsNoPeriodo(p.id);
      const ses = (sessao.hunt[p.id] ?? 0) + (sessao.boss[p.id] ?? 0);
      const v = vendasDoItem(p.id, nomeJogo);
      const vendeu = v ? ['gold', 'orb'].filter((k) => v.vendas[k].qtd).map((k) =>
        `${fmt(v.vendas[k].qtd)} un. · médio ${preco(v.vendas[k].total / v.vendas[k].qtd, k)}<small>líquido ${preco(liquido(v.vendas[k].total), k)}</small>`).join('') || '0' : '<small>abra o 💰 Vendas</small>';
      return `<tr>
        <td><b>${esc(nome)}</b></td>
        <td><b>${fmt(q)}</b></td>
        <td>${preco(minG, 'gold')}<small>${preco(minO, 'orb')}${r?.anuncios ? ` · ${fmt(r.anuncios)} anúncios` : ''}</small></td>
        <td>${md?.gold ? preco(md.gold.media, 'gold') : '—'}<small>${md?.orb ? preco(md.orb.media, 'orb') : '—'}</small></td>
        <td>${valG ? preco(valG, 'gold') : '—'}<small>${valO ? preco(valO, 'orb') : '—'}</small></td>
        <td>${vendeu}</td>
        <td>${fmt(dp.hunt + dp.boss)}<small>hunt ${fmt(dp.hunt)} · boss ${fmt(dp.boss)}</small></td>
        <td>${fmt(ses)}<small>${fmt1(ses / horas)}/h</small></td>
      </tr>`;
    }).join('');
    const idadeMercado = mercado ? `preços de ${new Date(mercado.em).toLocaleTimeString('pt-BR')}` : carregandoMercado ? 'buscando preços…' : 'sem preços ainda';
    return `
      <section>
        ${htmlPeriodo()}
        <div class="pit-linha"><span class="pit-ajuda">${esc(idadeMercado)} · valor líquido já com a taxa de 15% do Mercado · "Vendeu" usa o extrato do 💰 Vendas · drops contam desde que o app ficou aberto com este painel instalado</span>
          <span style="flex:1"></span><button class="pit-bt" data-a="mercado" ${carregandoMercado ? 'disabled' : ''}>⟳ Atualizar preços</button></div>
        <div class="pit-cards">
          <div class="pit-card"><small>Bolsa vale (vendendo em Coins)</small><b>${preco(totGold, 'gold')}</b></div>
          <div class="pit-card"><small>Bolsa vale (vendendo em Gemas)</small><b>${preco(totOrb, 'orb')}</b></div>
        </div>
      </section>
      <section>
        <table class="pit-tab">
          <tr><th>Item</th><th>Na bolsa</th><th title="menor preço anunciado agora">Menor preço</th><th title="média das vendas dos últimos 7 dias">Média 7d</th>
            <th title="na bolsa × menor preço, menos 15% de taxa">Bolsa vale</th><th>Você vendeu</th><th>Dropou (período)</th><th>Nesta sessão</th></tr>
          ${linhas}
        </table>
      </section>`;
  }

  function htmlBoss() {
    const de = inicioPeriodo();
    const doPeriodo = bosses.filter((b) => b.em >= de);
    const nomes = [...new Set(bosses.map((b) => b.nome))].sort();
    const lista = doPeriodo.filter((b) => !cfg.boss || b.nome === cfg.boss);
    // Resumo por boss
    const porBoss = new Map();
    for (const b of doPeriodo) {
      const r = porBoss.get(b.nome) ?? { nome: b.nome, lutas: 0, vit: 0, tm: 0, itens: {} };
      r.lutas++;
      if (b.venceu) r.vit++;
      if (b.drops.some((x) => IDS_TM.has(x.id))) r.tm++;
      for (const x of b.drops) r.itens[x.nome] = (r.itens[x.nome] ?? 0) + x.qtd;
      porBoss.set(b.nome, r);
    }
    const resumo = [...porBoss.values()].sort((a, b) => b.lutas - a.lutas).map((r) => {
      const principais = Object.entries(r.itens).sort((a, b) => b[1] - a[1]).slice(0, 8);
      return `<tr>
        <td><b>${esc(r.nome)}</b></td><td>${fmt(r.lutas)}</td>
        <td><span class="pit-v">${fmt(r.vit)}</span> / <span class="pit-d">${fmt(r.lutas - r.vit)}</span></td>
        <td>${r.vit ? `${Math.round((r.tm / r.vit) * 100)}%` : '—'}<small>${fmt(r.tm)} luta(s)</small></td>
        <td style="text-align:left;white-space:normal"><div class="pit-drops">${principais.map(([n, q]) => `<span>${esc(n)} ×${fmt(q)} <small>(${fmt1(q / Math.max(1, r.vit))}/luta)</small></span>`).join('') || '—'}</div></td>
      </tr>`;
    }).join('');
    const paginas = Math.max(1, Math.ceil(lista.length / POR_PAGINA));
    pagina = Math.min(pagina, paginas - 1);
    const pag = lista.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
    const historico = pag.map((b) => `<tr>
        <td>${quando(b.em)}</td><td style="text-align:left"><b>${esc(b.nome)}</b>${b.boost ? ' <small>loot boost</small>' : ''}</td>
        <td class="${b.venceu ? 'pit-v' : 'pit-d'}">${b.venceu ? 'venceu' : 'perdeu'}</td>
        <td style="text-align:left;white-space:normal"><div class="pit-drops">${b.drops.map((x) => `<span class="${IDS_TM.has(x.id) ? 'pit-tm' : ''}">${esc(x.nome)} ×${fmt(x.qtd)}</span>`).join('') || (b.venceu ? 'nada' : '—')}</div></td>
        <td>${b.xp ? fmt(b.xp) : '—'}</td></tr>`).join('');
    return `
      <section>
        ${htmlPeriodo()}
      </section>
      ${htmlLucro()}
      <section>
        <div class="pit-linha">Boss: <select class="pit-in" data-c="boss"><option value="">todos</option>${nomes.map((n) => `<option ${n === cfg.boss ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>
          <span class="pit-ajuda">cada luta contra boss fica gravada aqui sozinha (vitórias com os drops, e as derrotas)</span>
          <span style="flex:1"></span>${bosses.length ? '<button class="pit-bt" data-a="limparBoss">limpar histórico</button>' : ''}</div>
      </section>
      <section>
        <h4>Resumo por boss</h4>
        ${resumo ? `<table class="pit-tab"><tr><th>Boss</th><th>Lutas</th><th>V / D</th><th title="vitórias que deram peça de TM">Com peça de TM</th><th style="text-align:left">Drops (total e por vitória)</th></tr>${resumo}</table>`
          : '<span class="pit-ajuda">Nenhuma luta de boss no período.</span>'}
      </section>
      <section>
        <h4>Histórico${cfg.boss ? ` — ${esc(cfg.boss)}` : ''}</h4>
        ${historico ? `<table class="pit-tab"><tr><th>Quando</th><th style="text-align:left">Boss</th><th>Resultado</th><th style="text-align:left">Drops</th><th>XP</th></tr>${historico}</table>
          ${paginas > 1 ? `<div class="pit-pags"><button class="pit-bt" data-a="pag" data-v="-1" ${pagina === 0 ? 'disabled' : ''}>‹</button>
            <span>página ${pagina + 1} de ${paginas} · ${lista.length} lutas</span>
            <button class="pit-bt" data-a="pag" data-v="1" ${pagina >= paginas - 1 ? 'disabled' : ''}>›</button></div>` : ''}`
          : '<span class="pit-ajuda">Nada ainda — as próximas lutas de boss entram aqui.</span>'}
      </section>`;
  }

  function pintar() {
    const modal = document.getElementById('pit-modal');
    if (!modal || !estaAberto()) return;
    modal.innerHTML = `
      <header><span>📦 Itens e boss<small>v${VERSAO_ITENS}</small></span>
        <span class="pit-linha" style="margin:0">
          <button class="pit-bt ${cfg.aba === 'principais' ? 'on' : ''}" data-a="aba" data-v="principais">Principais</button>
          <button class="pit-bt ${cfg.aba === 'boss' ? 'on' : ''}" data-a="aba" data-v="boss">Boss</button>
          <button class="pit-bt ${cfg.aba === 'xsh' ? 'on' : ''}" data-a="aba" data-v="xsh">🎒 Exp Share</button>
          <button class="pit-x" data-a="fechar" title="Fechar">×</button></span></header>
      ${cfg.aba === 'boss' ? htmlBoss() : cfg.aba === 'xsh' ? htmlXsh() : htmlPrincipais()}`;
  }

  function aoClicar(e) {
    if (e.target.id === 'pit-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'fechar') return fechar();
    if (a === 'aba') { cfg.aba = b.dataset.v; pagina = 0; if ((cfg.aba === 'principais' || cfg.aba === 'boss') && !mercado) pedirMercado(); }
    else if (a === 'periodo') { cfg.periodo = b.dataset.v; pagina = 0; }
    else if (a === 'mercado') pedirMercado();
    else if (a === 'moedaLucro') cfg.moedaLucro = b.dataset.v;
    else if (a === 'extrato') {
      if (!window.__pokeVendas?.garantirDados) { alert('Abra o 💰 Vendas uma vez nesta conta (o módulo ainda não carregou).'); return; }
      b.disabled = true; b.textContent = 'lendo o extrato…';
      window.__pokeVendas.garantirDados(true, 0).finally(() => pintar());
      return;
    }
    else if (a === 'pag') pagina = Math.max(0, pagina + Number(b.dataset.v));
    else if (a === 'limparBoss') { bosses = []; gravar(CHAVE_BOSS, bosses); }
    else if (a === 'xshAtivo') { xsh.ativo = !xsh.ativo; salvarXsh(); xshNota(xsh.ativo ? 'automação LIGADA' : 'automação desligada'); }
    else if (a === 'xshTirar' || a === 'xshColocar') {
      const pk = pokes().find((x) => x.id === Number(b.dataset.v));
      if (pk) { const r = xshAcao(a === 'xshTirar' ? 'tirar' : 'colocar', pk, 'na mão'); if (!r.ok) xshNota(`não deu: ${r.msg}`); }
    }
    else if (a === 'xshFicha') { if (!verFicha(Number(b.dataset.v))) alert('Não deu para abrir a ficha (o chat do jogo ainda não carregou).'); return; }
    else if (a === 'xshFila') { const id = Number(b.dataset.v); xsh.fila = xsh.fila.includes(id) ? xsh.fila.filter((x) => x !== id) : [...xsh.fila, id]; salvarXsh(); }
    else if (a === 'xshSobe') { const id = Number(b.dataset.v); const i = xsh.fila.indexOf(id); if (i > 0) { xsh.fila.splice(i, 1); xsh.fila.splice(i - 1, 0, id); salvarXsh(); } }
    salvarCfg();
    pintar();
  }

  function abrir() {
    document.getElementById('pit-fundo').classList.add('aberto');
    if ((cfg.aba === 'principais' || cfg.aba === 'boss') && (!mercado || Date.now() - mercado.em > 5 * 60 * 1000)) pedirMercado();
    pintar();
  }
  function fechar() { document.getElementById('pit-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

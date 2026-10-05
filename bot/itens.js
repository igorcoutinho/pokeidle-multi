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
//
// Aba "Multi-acc": lê as TRANSAÇÕES desses itens na tabela de preços global do Mercado
// (`market.historicoGlobal`: vendedor, comprador, valor, hora) e os anúncios abertos
// (`market.item`), e marca TODOS os nicks com cara de
// gerados (PalavraPalavra + números, ex.: KantoHeart857, wingmenLegate4B). Para os suspeitos,
// lê o perfil público (`ranking.perfil`: nível, capturas, Pokédex, guild) e junta quem anuncia
// pelo mesmo preço. Só junta evidência para VOCÊ reportar — não faz nada com as contas.
(() => {
  'use strict';
  const VERSAO_ITENS = '1.3.2';

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
  const NICKS_INICIAIS = ['wingmenLegate4B', 'emeraldLogouts2q', 'KantoHeart857', 'BlazeRider497', 'AceWave299'];
  const cfg = { aba: 'principais', periodo: '7d', boss: '', tokensPadrao: 1, custoBoss: {}, moedaLucro: 'orb', tokenGemas: 5, monitor: false, cadaMin: 10, conhecidos: NICKS_INICIAIS.join('\n'), ...ler(CHAVE_CFG, {}) };
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
    } else if (esperas.size && d.includes('"t":"market"') && d.includes('"aba":"item"')) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      esperas.get(`item:${m.itemId}:${m.moeda}`)?.(m);
    } else if (esperas.size && d.includes('"t":"market"') && d.includes('"aba":"historicoGlobal"')) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      esperas.get('hist')?.(m);
    } else if (esperas.size && d.includes('"t":"perfil"')) {
      let m;
      try { m = JSON.parse(d); } catch { return; }
      esperas.get(`perfil:${String(m.perfil?.nick ?? '').toLowerCase()}`)?.(m);
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

  // ---------------------------------------------------------------- multi-acc (vendedores suspeitos)
  const CHAVE_VEND = 'pokeitens.vendedores.v1'; // { nick minúsculo: { nick, primeiro, ultimo, varreduras, itens, perfil, marcado } }
  const VIGIADOS = [
    { id: 70000, nome: 'Bronze Boss Token' }, { id: 70011, nome: 'Key Fragment' }, { id: 70012, nome: 'Shiny Stone Fragment' },
    { id: 70015, nome: 'Mega Shiny Fragment' }, { id: 70040, nome: 'Chave (comum)' }, { id: 70041, nome: 'Chave (incomum)' },
    { id: 70042, nome: 'Chave (rara)' }, { id: 70043, nome: 'Chave (mítica)' }, { id: 70044, nome: 'Chave (lendária)' },
  ];
  const nomeVigiado = (id) => nomeItem(id, VIGIADOS.find((x) => x.id === Number(id))?.nome);
  let vend = ler(CHAVE_VEND, {});
  // As transações lidas: [{ k, em, item, desc, vendedor, comprador, valor, moeda }] (as mais novas primeiro).
  const CHAVE_TRANS = 'pokeitens.transacoes.v1';
  const TRANS_MAX = 4000;
  let trans = ler(CHAVE_TRANS, []);
  const chaveTrans = (l) => `${l.em}|${l.vendedor}|${l.comprador}|${l.bruto}|${l.descricao}`;
  const salvarVend = () => gravar(CHAVE_VEND, vend);
  const varre = { rodando: false, msg: '', ultima: Number(ler('pokeitens.varredura.em', 0)) || 0 };
  const esperas = new Map(); // 'item:ID:moeda' | 'perfil:nick' → resolve

  /** Cara de nick gerado: duas palavras coladas + 1–4 números (às vezes com uma letra no fim). */
  function nickEstranho(n) {
    const s = String(n ?? '');
    const motivos = [];
    if (/^[a-z]+[A-Z][a-z]+\d{1,3}[A-Za-z]$/.test(s)) motivos.push('palavra+Palavra+número+letra');
    else if (/^[A-Za-z][a-z]+[A-Z][a-z]+\d{2,4}$/.test(s)) motivos.push('PalavraPalavra+número');
    else if (/^[A-Za-z]{4,}\d{3,4}$/.test(s)) motivos.push('nome+3-4 números');
    return motivos;
  }
  const conhecidos = () => new Set(String(cfg.conhecidos ?? '').split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean));

  /** Pontos de suspeita e os porquês (para o relatório). */
  function suspeita(v) {
    const motivos = [...nickEstranho(v.nick)];
    let pts = !motivos.length ? 0 : motivos[0] === 'nome+3-4 números' ? 1 : 2; // "Pedro123" é comum: pesa menos
    if (conhecidos().has(v.nick.toLowerCase())) { pts += 3; motivos.push('na sua lista'); }
    const itens = Object.keys(v.itens ?? {}).length;
    if (itens >= 2) { pts += 1; motivos.push(`vende ${itens} dos itens vigiados`); }
    const pf = v.perfil;
    if (pf && !pf.erro) {
      if ((pf.dex ?? 0) <= 30) { pts += 1; motivos.push(`Pokédex ${pf.dex ?? 0}`); }
      if (!pf.guild) { pts += 1; motivos.push('sem guild'); }
      if ((pf.conquistas ?? 0) <= 3) { pts += 1; motivos.push(`${pf.conquistas ?? 0} conquistas`); }
    }
    const mesmos = mesmoPreco(v);
    if (mesmos.length) { pts += 2; motivos.push(`mesmo preço que ${mesmos.slice(0, 3).join(', ')}`); }
    const t = v.trans;
    if (t?.vendas + t?.compras >= 3) { pts += 1; motivos.push(`${t.vendas} vendas / ${t.compras} compras desses itens`); }
    const g = grupoDe(v.nick);
    if (g) { pts += 3; motivos.push(`ligado a ${g.estranhos.filter((n) => !mesmoNickI(n, v.nick)).slice(0, 3).join(', ')} via ${g.hub}`); }
    return { pts, motivos };
  }

  /** Outros vendedores com nick estranho anunciando o MESMO item pelo MESMO preço. */
  function mesmoPreco(v) {
    const out = new Set();
    for (const [id, it] of Object.entries(v.itens ?? {})) {
      for (const o of Object.values(vend)) {
        if (o === v || !nickEstranho(o.nick).length && !conhecidos().has(o.nick.toLowerCase())) continue;
        const x = o.itens?.[id];
        if (x && x.precos?.some((pr) => it.precos?.includes(pr))) out.add(o.nick);
      }
    }
    return [...out];
  }

  const mesmoNickI = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
  const suspeitoNick = (n) => nickEstranho(n).length > 0 && nickEstranho(n)[0] !== 'nome+3-4 números' || conhecidos().has(String(n).toLowerCase());

  /**
   * GRUPOS: quem negocia com 2+ contas de nick estranho (o "hub" — a conta principal que recebe
   * os itens, ou a que abastece as outras). Cada grupo: o hub, as contas estranhas ligadas a ele e
   * as transações entre eles.
   */
  let gruposCache = null;
  function grupos() {
    if (gruposCache) return gruposCache;
    const lig = new Map(); // hub → Map(estranho → { n, valor, vende, compra })
    for (const t of trans) {
      for (const [a, b, papel] of [[t.vendedor, t.comprador, 'vende'], [t.comprador, t.vendedor, 'compra']]) {
        if (!a || !b || !suspeitoNick(a)) continue;
        const m = lig.get(b.toLowerCase()) ?? new Map();
        const x = m.get(a.toLowerCase()) ?? { nick: a, n: 0, valor: 0, vende: 0, compra: 0 };
        x.n++; x.valor += Number(t.valor) || 0; x[papel]++;
        m.set(a.toLowerCase(), x);
        lig.set(b.toLowerCase(), m);
      }
    }
    const nickReal = (k) => trans.find((t) => mesmoNickI(t.vendedor, k))?.vendedor ?? trans.find((t) => mesmoNickI(t.comprador, k))?.comprador ?? k;
    gruposCache = [...lig.entries()].filter(([, m]) => m.size >= 2)
      .map(([hub, m]) => ({ hub: nickReal(hub), hubEstranho: suspeitoNick(nickReal(hub)), estranhos: [...m.values()].map((x) => x.nick), lig: [...m.values()].sort((a, b) => b.n - a.n),
        n: [...m.values()].reduce((t, x) => t + x.n, 0) }))
      .sort((a, b) => b.estranhos.length - a.estranhos.length || b.n - a.n);
    return gruposCache;
  }
  const grupoDe = (nick) => grupos().find((g) => mesmoNickI(g.hub, nick) || g.estranhos.some((n) => mesmoNickI(n, nick))) ?? null;

  /** Recalcula o resumo de transações de cada nick (e cria a ficha de quem só aparece nelas). */
  function resumirTransacoes() {
    gruposCache = null;
    for (const v of Object.values(vend)) v.trans = { vendas: 0, compras: 0, com: [] };
    for (const t of trans) {
      for (const [nick, papel, outro] of [[t.vendedor, 'vendas', t.comprador], [t.comprador, 'compras', t.vendedor]]) {
        if (!nick) continue;
        const k = nick.toLowerCase();
        if (!vend[k] && !suspeitoNick(nick) && !grupoDe(nick)) continue; // gente normal sem ligação: não guarda ficha
        const v = (vend[k] ??= { nick, primeiro: t.em, ultimo: 0, varreduras: 0, itens: {}, perfil: null, marcado: false });
        v.trans ??= { vendas: 0, compras: 0, com: [] };
        v.trans[papel]++;
        v.primeiro = Math.min(v.primeiro, t.em);
        if (outro && !v.trans.com.includes(outro) && v.trans.com.length < 8) v.trans.com.push(outro);
      }
    }
  }

  function esperar(chave, ms = 7000) {
    return new Promise((res) => {
      const t = setTimeout(() => { esperas.delete(chave); res(null); }, ms);
      esperas.set(chave, (m) => { clearTimeout(t); esperas.delete(chave); res(m); });
    });
  }
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  function anotarAnuncio(itemId, moeda, a) {
    const nick = String(a.vendedor ?? '').trim();
    if (!nick || nick.toLowerCase() === String(core.eu?.nick ?? '').toLowerCase()) return;
    const k = nick.toLowerCase();
    const v = (vend[k] ??= { nick, primeiro: Date.now(), ultimo: 0, varreduras: 0, itens: {}, perfil: null, marcado: false });
    v.nick = nick;
    v.ultimo = Date.now();
    const it = (v.itens[itemId] ??= { anuncios: 0, qtdMax: 0, precos: [], moedas: [] });
    it.anuncios++;
    it.qtdMax = Math.max(it.qtdMax, Number(a.qtd) || 0);
    const pr = `${moeda === 'orb' ? '💎' : '🪙'}${Number(a.preco) || 0}`;
    if (!it.precos.includes(pr)) it.precos = [pr, ...it.precos].slice(0, 6);
  }

  async function lerPerfil(v) {
    if (!core.send({ t: 'ranking.perfil', nick: v.nick })) return;
    const m = await esperar(`perfil:${v.nick.toLowerCase()}`);
    setTimeout(() => document.getElementById('perfil')?.classList.add('hidden'), 0);
    const p = m?.perfil;
    v.perfil = p
      ? { em: Date.now(), level: p.level ?? null, capturas: p.capturas ?? null, dex: p.capturasEsp ?? null, guild: p.guildTag || p.guildNome || '',
          conquistas: Array.isArray(p.conquistas) ? p.conquistas.length : (Number(p.conquistas) || 0), pvp: p.pvpRank ?? null, shinys: p.shinysVistos ?? null }
      : { em: Date.now(), erro: 'perfil não respondeu' };
  }

  async function varrer() {
    if (varre.rodando || !core.logado) return;
    varre.rodando = true;
    try {
      // 1) TRANSAÇÕES: a tabela de preços global, filtrada por item, até achar o que já foi lido.
      const conhecidas = new Set(trans.map((t) => t.k));
      const novas = [];
      for (const it of VIGIADOS) {
        const paginasMax = trans.length ? 4 : 10; // a primeira varredura vai mais fundo
        for (let pg = 0; pg < paginasMax; pg++) {
          varre.msg = `transações de ${nomeVigiado(it.id)} (página ${pg + 1})…`;
          if (estaAberto() && cfg.aba === 'multi') pintar();
          if (!core.send({ t: 'market.historicoGlobal', pagina: pg, tipo: 'item', itemId: it.id })) break;
          const m = await esperar('hist');
          const linhas = m?.linhas ?? [];
          let repetidas = 0;
          for (const l of linhas) {
            const k = chaveTrans(l);
            if (conhecidas.has(k)) { repetidas++; continue; }
            conhecidas.add(k);
            novas.push({ k, em: Number(l.em) || Date.now(), item: it.id, desc: l.descricao ?? '', vendedor: l.vendedor ?? '', comprador: l.comprador ?? '', valor: Number(l.bruto) || 0, moeda: l.moeda ?? 'gold' });
          }
          await dormir(1200);
          if (!m?.temMais || !linhas.length || repetidas === linhas.length) break;
        }
      }
      trans = [...novas, ...trans].sort((a, b) => b.em - a.em).slice(0, TRANS_MAX);
      gravar(CHAVE_TRANS, trans);
      resumirTransacoes();
      // 2) ANÚNCIOS abertos agora.
      const vistosAgora = new Set();
      for (const it of VIGIADOS) {
        for (const moeda of ['gold', 'orb']) {
          varre.msg = `lendo ${nomeItem(it.id, it.nome)} (${moeda === 'orb' ? 'Gemas' : 'Coins'})…`;
          if (estaAberto() && cfg.aba === 'multi') pintar();
          if (!core.send({ t: 'market.item', itemId: it.id, moeda })) continue;
          const m = await esperar(`item:${it.id}:${moeda}`);
          for (const a of m?.linhas ?? []) { anotarAnuncio(it.id, moeda, a); vistosAgora.add(String(a.vendedor ?? '').toLowerCase()); }
          await dormir(1200);
        }
      }
      for (const k of vistosAgora) if (vend[k]) vend[k].varreduras++;
      // Perfil dos suspeitos (nick estranho ou da sua lista), no máximo 1 vez por dia cada.
      const fila = Object.values(vend).filter((v) => (nickEstranho(v.nick).length || conhecidos().has(v.nick.toLowerCase()))
        && (!v.perfil || Date.now() - v.perfil.em > DIA)).slice(0, 15);
      for (const v of fila) {
        varre.msg = `perfil de ${v.nick}…`;
        if (estaAberto() && cfg.aba === 'multi') pintar();
        await lerPerfil(v);
        await dormir(2500);
      }
      // Os nicks da sua lista que não estão vendendo agora: lê o perfil mesmo assim (uma vez por dia).
      for (const k of conhecidos()) {
        if (vend[k]?.perfil && Date.now() - vend[k].perfil.em < DIA) continue;
        const v = (vend[k] ??= { nick: String(cfg.conhecidos).split(/[\s,;]+/).find((x) => x.toLowerCase() === k) ?? k, primeiro: Date.now(), ultimo: 0, varreduras: 0, itens: {}, perfil: null, marcado: false });
        varre.msg = `perfil de ${v.nick}…`;
        await lerPerfil(v);
        await dormir(2500);
      }
      varre.ultima = Date.now();
      gravar('pokeitens.varredura.em', varre.ultima);
      varre.msg = `varredura feita: ${novas.length} transações novas (${trans.length} guardadas) · ${vistosAgora.size} vendedores com anúncio aberto`;
      salvarVend();
    } finally {
      varre.rodando = false;
      if (estaAberto()) pintar();
    }
  }
  // Monitor: com ele ligado NESTA conta, varre a cada N minutos.
  const relogio = setInterval(() => {
    if (cfg.monitor && !varre.rodando && Date.now() - varre.ultima > Math.max(5, Number(cfg.cadaMin) || 10) * 60_000) varrer();
  }, 30_000);
  limpezas.push(() => clearInterval(relogio));

  function relatorio(lista) {
    const linhas = lista.map(({ v, s: sp }) => {
      const pf = v.perfil && !v.perfil.erro ? `Nv ${v.perfil.level ?? '?'}, ${fmt(v.perfil.capturas ?? 0)} capturas, Pokédex ${v.perfil.dex ?? '?'}, guild: ${v.perfil.guild || 'nenhuma'}` : 'perfil não lido';
      const itens = Object.entries(v.itens).map(([id, it]) => `${nomeVigiado(id)} (até ${it.qtdMax} un., ${it.precos.join(' / ')})`).join('; ') || 'nenhum anúncio visto';
      const tr = v.trans ? `${v.trans.vendas} vendas e ${v.trans.compras} compras desses itens${v.trans.com.length ? ` (com: ${v.trans.com.join(', ')})` : ''}` : 'sem transações lidas';
      return `• ${v.nick} — ${pf}\n  Anúncios: ${itens}\n  Transações: ${tr}\n  Visto de ${quando(v.primeiro)} a ${quando(v.ultimo || v.primeiro)} · indícios: ${sp.motivos.join(', ') || '—'}`;
    });
    const gs = grupos().filter((g) => lista.some(({ v }) => grupoDe(v.nick) === g)).slice(0, 8);
    const txtGrupos = gs.length ? `\n\nGrupos (contas de nick gerado que negociam com a mesma conta):\n${gs.map((g) => `• ${g.hub} ⇄ ${g.lig.map((x) => `${x.nick} (${x.vende ? `vendeu ${x.vende}× para ele` : ''}${x.vende && x.compra ? ', ' : ''}${x.compra ? `comprou ${x.compra}× dele` : ''})`).join(', ')}`).join('\n')}` : '';
    return `Possíveis multi-contas negociando itens raros no Mercado (levantamento automático, ${quando(Date.now())}):\n\n${linhas.join('\n\n')}${txtGrupos}\n\nObs.: indícios, não prova — peço que a moderação confira IP/dispositivo.`;
  }

  function htmlMulti() {
    const todos = Object.values(vend).map((v) => ({ v, s: suspeita(v) }))
      .filter((x) => x.s.pts >= 2 || x.v.marcado)
      .sort((a, b) => Number(b.v.marcado) - Number(a.v.marcado) || b.s.pts - a.s.pts || (b.v.ultimo - a.v.ultimo));
    const total = Object.keys(vend).length;
    return `<section>
        <div class="pit-linha">
          <button class="pit-sw ${cfg.monitor ? 'on' : ''}" data-a="monitor"></button>
          <b>Monitorar nesta conta</b> · a cada <input type="number" class="pit-in" data-c="cadaMin" min="5" max="120" value="${esc(cfg.cadaMin)}"> min
          <button class="pit-bt" data-a="varrer" ${varre.rodando ? 'disabled' : ''}>${varre.rodando ? 'varrendo…' : '🔎 varrer agora'}</button>
          <button class="pit-bt" data-a="copiarRel" ${todos.length ? '' : 'disabled'}>📋 copiar relatório</button>
          <span class="pit-ajuda">${esc(varre.msg)}${varre.ultima ? ` · última: ${quando(varre.ultima)}` : ''} · ${total} contas com ficha · ${trans.length} transações</span>
        </div>
        <p class="pit-ajuda" style="margin:2px 0">Vigia: ${VIGIADOS.map((x) => esc(nomeItem(x.id, x.nome))).join(', ')}. Ligue o monitor em UMA conta só (cada varredura lê as transações desses itens na tabela de preços global e os anúncios abertos — ~1 a 2 min).</p>
        <details><summary class="pit-ajuda">Nicks que você já desconfia (um por linha)</summary>
          <textarea class="pit-in" data-c="conhecidos" rows="5" style="width:100%;font-family:monospace">${esc(cfg.conhecidos)}</textarea></details>
      </section>
      ${(() => { const gs = grupos().slice(0, 10); return gs.length ? `<section><h4 style="margin:0 0 4px;color:#f3c77a">🔗 Grupos — contas de nick gerado que negociam com a mesma conta</h4>
        <table class="pit-tab"><tr><th>Conta central</th><th>Contas ligadas</th><th>Transações</th></tr>
        ${gs.map((g) => `<tr><td><b>${esc(g.hub)}</b>${g.hubEstranho ? ' <small style="color:#ff8a8a">(nick gerado)</small>' : ''}</td>
          <td style="white-space:normal;text-align:left">${g.lig.map((x) => `${esc(x.nick)} <small>(${x.vende ? `vendeu ${x.vende}×` : ''}${x.vende && x.compra ? ' · ' : ''}${x.compra ? `comprou ${x.compra}×` : ''})</small>`).join(', ')}</td>
          <td>${g.n}</td></tr>`).join('')}</table></section>` : ''; })()}
      <section>
        ${todos.length ? `<table class="pit-tab"><tr><th></th><th>Vendedor</th><th>Pontos</th><th>Indícios</th><th>Anúncios</th><th>Transações</th><th>Perfil</th><th>Visto</th></tr>
          ${todos.map(({ v, s: sp }) => `<tr>
            <td><input type="checkbox" data-a="marcar" data-v="${esc(v.nick.toLowerCase())}" ${v.marcado ? 'checked' : ''} title="incluir no relatório"></td>
            <td><b>${esc(v.nick)}</b></td>
            <td><b style="color:${sp.pts >= 5 ? '#ff8a8a' : sp.pts >= 3 ? '#f3c77a' : '#ddd'}">${sp.pts}</b></td>
            <td style="white-space:normal;max-width:220px">${esc(sp.motivos.join(' · '))}</td>
            <td style="white-space:normal;max-width:240px">${Object.entries(v.itens).map(([id, it]) => `${esc(nomeVigiado(id))}: ${it.qtdMax} un. ${esc(it.precos.join(' / '))}`).join('<br>') || '<span class="pit-ajuda">—</span>'}</td>
            <td style="white-space:normal;max-width:200px">${v.trans && (v.trans.vendas || v.trans.compras) ? `${v.trans.vendas} vendas · ${v.trans.compras} compras${v.trans.com.length ? `<br><small>com: ${esc(v.trans.com.slice(0, 4).join(', '))}</small>` : ''}` : '<span class="pit-ajuda">—</span>'}</td>
            <td>${v.perfil ? (v.perfil.erro ? `<span class="pit-ajuda">${esc(v.perfil.erro)}</span>` : `Nv ${esc(v.perfil.level ?? '?')} · ${fmt(v.perfil.capturas ?? 0)} capt. · dex ${esc(v.perfil.dex ?? '?')} · ${v.perfil.guild ? esc(v.perfil.guild) : 'sem guild'}`) : '<span class="pit-ajuda">—</span>'}</td>
            <td><small>${quando(v.primeiro)}<br>${v.ultimo ? quando(v.ultimo) : 'não vendendo'} · ${v.varreduras}×</small></td></tr>`).join('')}</table>`
          : '<span class="pit-ajuda">Nenhum suspeito ainda — clique em "varrer agora".</span>'}
        <p class="pit-ajuda">Pontos: ligado a outras contas de nick gerado pela mesma conta central (+3), 3+ transações desses itens (+1), nick com cara de gerado (+2), na sua lista (+3), vende 2+ itens vigiados (+1), Pokédex ≤ 30 (+1), sem guild (+1), ≤ 3 conquistas (+1), mesmo preço de outro suspeito no mesmo item (+2). São INDÍCIOS para a moderação conferir — não prova.</p>
      </section>`;
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
      if (c === 'tokenGemas') { cfg.tokenGemas = e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0); salvarCfg(); pintar(); }
      if (c === 'tokensPadrao') { cfg.tokensPadrao = Math.max(0, Math.min(20, Number(e.target.value) || 0)); salvarCfg(); pintar(); }
      if (c === 'cadaMin') { cfg.cadaMin = Math.max(5, Math.min(120, Number(e.target.value) || 10)); salvarCfg(); pintar(); }
      if (c === 'conhecidos') { cfg.conhecidos = e.target.value; salvarCfg(); pintar(); }
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
          <button class="pit-bt ${cfg.aba === 'multi' ? 'on' : ''}" data-a="aba" data-v="multi">🕵 Multi-acc</button>
          <button class="pit-x" data-a="fechar" title="Fechar">×</button></span></header>
      ${cfg.aba === 'boss' ? htmlBoss() : cfg.aba === 'multi' ? htmlMulti() : htmlPrincipais()}`;
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
    else if (a === 'monitor') { cfg.monitor = !cfg.monitor; if (cfg.monitor && Date.now() - varre.ultima > 5 * 60_000) varrer(); }
    else if (a === 'varrer') varrer();
    else if (a === 'marcar') { const v = vend[b.dataset.v]; if (v) { v.marcado = b.checked; salvarVend(); } }
    else if (a === 'copiarRel') {
      const todos = Object.values(vend).map((v) => ({ v, s: suspeita(v) })).filter((x) => x.s.pts >= 2 || x.v.marcado);
      const marcados = todos.filter((x) => x.v.marcado);
      const txt = relatorio((marcados.length ? marcados : todos.filter((x) => x.s.pts >= 4)).sort((x, y) => y.s.pts - x.s.pts));
      navigator.clipboard?.writeText(txt).then(() => { varre.msg = '📋 relatório copiado'; pintar(); }).catch(() => { varre.msg = 'não deu para copiar'; pintar(); });
    }
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

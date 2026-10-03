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
  const VERSAO_ITENS = '1.0.0';

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
  const cfg = { aba: 'principais', periodo: '7d', boss: '', ...ler(CHAVE_CFG, {}) };
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
      if (!d.includes('"morte"') && !d.includes('"bossMorto"') && !d.includes('"bossPerdeu"')) return;
      let m;
      try { m = JSON.parse(d); } catch { return; }
      let mudou = false;
      for (const e of m.ev ?? []) {
        if (e.k === 'morte' && e.quem === 'selvagem') {
          for (const x of e.drops ?? []) { const id = idDoDrop(x); if (id != null) { somarDrop(id, Number(x.qtd) || 1, 'hunt'); mudou = true; } }
        } else if (e.k === 'bossMorto') {
          const lista = (e.drops ?? []).map((x) => ({ id: idDoDrop(x), nome: x.nome ?? nomeItem(x.itemId), qtd: Number(x.qtd) || 1 }));
          for (const x of lista) if (x.id != null) somarDrop(x.id, x.qtd, 'boss');
          bosses.unshift({ em: Date.now(), nome: e.nome ?? '?', key: e.key ?? null, venceu: true, drops: lista,
            xp: Number(e.xpTreinador ?? e.xp ?? 0) || 0, valor: Number(e.valor ?? 0) || 0, boost: !!e.lootBoost });
          bosses = bosses.slice(0, BOSS_MAX);
          gravar(CHAVE_BOSS, bosses);
          mudou = true;
        } else if (e.k === 'bossPerdeu') {
          bosses.unshift({ em: Date.now(), nome: e.nome ?? '?', key: e.key ?? null, venceu: false, drops: [] });
          bosses = bosses.slice(0, BOSS_MAX);
          gravar(CHAVE_BOSS, bosses);
          mudou = true;
        }
      }
      if (mudou) { podarDias(); gravar(CHAVE_DROPS, drops); if (estaAberto()) pintar(); }
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

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pit-fundo';
    fundo.innerHTML = '<div id="pit-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('change', (e) => { if (e.target.dataset.c === 'boss') { cfg.boss = e.target.value; pagina = 0; salvarCfg(); pintar(); } });
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
          <button class="pit-x" data-a="fechar" title="Fechar">×</button></span></header>
      ${cfg.aba === 'boss' ? htmlBoss() : htmlPrincipais()}`;
  }

  function aoClicar(e) {
    if (e.target.id === 'pit-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    if (a === 'fechar') return fechar();
    if (a === 'aba') { cfg.aba = b.dataset.v; pagina = 0; if (cfg.aba === 'principais' && !mercado) pedirMercado(); }
    else if (a === 'periodo') { cfg.periodo = b.dataset.v; pagina = 0; }
    else if (a === 'mercado') pedirMercado();
    else if (a === 'pag') pagina = Math.max(0, pagina + Number(b.dataset.v));
    else if (a === 'limparBoss') { bosses = []; gravar(CHAVE_BOSS, bosses); }
    salvarCfg();
    pintar();
  }

  function abrir() {
    document.getElementById('pit-fundo').classList.add('aberto');
    if (cfg.aba === 'principais' && (!mercado || Date.now() - mercado.em > 5 * 60 * 1000)) pedirMercado();
    pintar();
  }
  function fechar() { document.getElementById('pit-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

// PokéIdle Bot — RELATÓRIO DE COMPRAS E VENDAS do Mercado. Trocado a quente junto com a lógica.
//
// Lê o extrato do próprio jogador no Mercado da Comunidade (as abas "Histórico de compras" e
// "Histórico de vendas" — `market.historicoCompras` e `market.historico`), página por página, e
// agrupa por item: quanto comprou e a que preço médio, quanto vendeu, quanto a taxa levou, o
// lucro, e A PARTIR DE QUE PREÇO vender para empatar (ou para ter a margem escolhida).
// A comissão é a do jogo: `shared/taxa-mercado.mjs`, o mesmo arquivo que o servidor usa.
(() => {
  'use strict';
  const VERSAO_VENDAS = '1.0.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pv-fundo')?.classList.contains('aberto');
  window.__pokeVendas?.desmontar?.();

  const limpezas = [];
  const V = {
    versao: VERSAO_VENDAS,
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
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
  #pv-modal header button{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
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
    const cab = `<header><span>💰 Compras e vendas no Mercado<small>v${VERSAO_VENDAS}</small></span><button data-a="fechar" title="Fechar">×</button></header>`;
    const foco = document.activeElement?.dataset?.c;
    const cursor = document.activeElement?.selectionStart;

    let corpo = '';
    if (!dados.baixadoEm) {
      corpo = `<section class="pv-msg">${esc(msg || 'Carregando o extrato…')}</section>`;
    } else {
      const r = montarRelatorio();
      const estadoDados = `${fmt(dados.compras.length)} compras e ${fmt(dados.vendas.length)} vendas lidas`
        + (dados.ate ? ` · desde ${new Date(dados.ate).toLocaleDateString('pt-BR')}` : '')
        + (dados.completo ? ' (extrato inteiro)' : '')
        + ` · atualizado ${dataHora(dados.baixadoEm)}`;
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
  async function garantirDados(forcar = false) {
    const desde = inicioDoPeriodo();
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
    cfg[c] = e.target.value;
    salvarCfg();
    clearTimeout(espera);
    espera = setTimeout(() => { pintar(); if (c === 'de') garantirDados(); }, c === 'busca' ? 250 : 0);
  }

  function aoClicar(e) {
    if (e.target.id === 'pv-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'fechar') fechar();
    else if (a === 'periodo') { cfg.periodo = b.dataset.v; salvarCfg(); pintar(); garantirDados(); }
    else if (a === 'moeda' || a === 'tipo' || a === 'ordem') { cfg[a] = b.dataset.v; salvarCfg(); pintar(); }
    else if (a === 'detalhe') { aberto = aberto === b.dataset.v ? null : b.dataset.v; pintar(); }
    else if (a === 'baixar') garantirDados(true);
  }

  function abrir() {
    document.getElementById('pv-fundo').classList.add('aberto');
    pintar();
    // Reabrir depois de 5 min busca o extrato de novo — vendas novas entram.
    garantirDados(dados.baixadoEm && Date.now() - dados.baixadoEm > 5 * 60 * 1000);
  }
  function fechar() { document.getElementById('pv-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

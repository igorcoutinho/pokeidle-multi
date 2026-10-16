// PokéIdle Bot — LÓGICA (trocada a quente).
//
// Pode ser editada com o jogo aberto: o vigia percebe a mudança e esta versão é reinjetada em
// ~3 s, sem recarregar a página. Tudo o que precisa sobreviver à troca mora no núcleo
// (`core.log`, `core.memoria`) ou no localStorage (a configuração).
(() => {
  'use strict';
  const VERSAO_LOGICA = '2.1.0';

  const core = window.__pokebotCore;
  const estavaAberto = !!document.getElementById('pb-fundo')?.classList.contains('aberto');
  // Desmonta a versão anterior (intervalos, ouvintes, botão e modal).
  window.__pokebotLogica?.desmontar?.();

  const limpezas = [];
  const inst = { versao: VERSAO_LOGICA, desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } } };
  window.__pokebotLogica = inst;

  // ---------------------------------------------------------------- constantes
  const CHAVE_CFG = 'pokebot.cfg.v2';
  const LOTE_MAX = 9999;             // teto do servidor por compra (igual ao "Máx" do Market)
  const INTERVALO_MS = 8000;
  const ESPERA_POS_COMPRA_MS = 4000;
  const NOME_BOLA = 'Ultra Ball';

  // A configuração padrão. `versao` sobe quando o padrão muda e deve valer para quem já tinha
  // uma configuração salva: a antiga é trocada pela nova UMA vez; depois, o que o jogador mexer
  // no painel continua valendo.
  const VERSAO_CFG = 4; // 4: compra em quantidade sorteada (mín–máx) em vez de completar até um alvo
  const CFG_PADRAO = {
    versao: VERSAO_CFG,
    ativo: true,
    reservaOuro: 1000000,
    bola: { min: 2000, max: 20000, gatilho: 5000 },
    pocao: { min: 1000, max: 20000, gatilho: 2000, modo: 'auto', fixa: 204 }, // 204 = Ultimate Potion
    ajustarFila: true,
  };

  function lerCfg() {
    try {
      const c = JSON.parse(localStorage.getItem(CHAVE_CFG));
      if (c && c.bola && c.pocao && c.versao === VERSAO_CFG) return { ...structuredClone(CFG_PADRAO), ...c };
    } catch {}
    return structuredClone(CFG_PADRAO);
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };
  // Sempre começa LIGADO quando a conta abre. Só na primeira carga da página: a troca a quente
  // desta lógica (atualização do GitHub) não religa quem desligou no meio da sessão.
  if (core && !core.memoria.botIniciou) {
    core.memoria.botIniciou = true;
    cfg.ativo = true;
  }
  salvarCfg();

  // ---------------------------------------------------------------- UI base
  const fmt = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const fmt2 = (n) => Number(n).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const log = core?.log ?? [];
  function registrar(txt) {
    const h = new Date().toLocaleTimeString('pt-BR');
    log.unshift(`${h} · ${txt}`);
    log.length = Math.min(log.length, 80);
    const el = document.getElementById('pb-log');
    if (el) el.textContent = log.join('\n');
    console.log('[PokeBot]', txt);
  }

  const CSS = `
  #pb-botao{position:fixed;left:14px;bottom:64px;z-index:99999;padding:8px 12px;border-radius:10px;
    border:2px solid #f3c77a;background:linear-gradient(#c86bd6,#9a3fb0);color:#fff;font:700 13px system-ui;
    cursor:pointer;box-shadow:0 3px 0 #5b2168,0 6px 14px rgba(0,0,0,.4)}
  #pb-botao .pb-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-left:6px;background:#888}
  #pb-botao.on .pb-dot{background:#6f6;box-shadow:0 0 6px #6f6}
  #pb-toast{position:fixed;left:14px;bottom:110px;z-index:100001;padding:8px 12px;border-radius:10px;background:#2a1515;
    color:#f6e7d4;border:2px solid #f3c77a;font:600 13px system-ui;box-shadow:0 6px 14px rgba(0,0,0,.4);transition:opacity .4s}
  #pb-fundo{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:none;align-items:center;justify-content:center}
  #pb-fundo.aberto{display:flex}
  #pb-modal{width:min(600px,94vw);max-height:90vh;overflow:auto;background:#3a2020;color:#f6e7d4;
    border:3px solid #e2915a;border-radius:14px;font:14px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pb-modal header{display:flex;justify-content:space-between;align-items:center;padding:12px 16px;background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pb-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pb-modal header button{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pb-modal section{padding:12px 16px;border-bottom:1px solid #5a3232}
  #pb-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a}
  .pb-linha{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .pb-sw{position:relative;width:44px;height:24px;border-radius:12px;background:#6a4a4a;cursor:pointer;border:none;flex:none}
  .pb-sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
  .pb-sw.on{background:#b04ad0}.pb-sw.on::after{left:23px}
  .pb-campos{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}
  .pb-campos label{font-size:12px;opacity:.8;display:block;margin-bottom:2px}
  #pb-modal input,#pb-modal select{background:#2a1515;color:#f6e7d4;border:1px solid #8a5a4a;border-radius:6px;padding:5px 6px;width:100%;box-sizing:border-box}
  .pb-est{font-size:12px;margin-top:6px;opacity:.9}.pb-est.baixo{color:#ffb070}
  table.pb-t{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}
  .pb-t th,.pb-t td{padding:4px 6px;text-align:right;border-bottom:1px solid #4a2a2a}
  .pb-t th:first-child,.pb-t td:first-child{text-align:left}
  .pb-t tr.melhor td{background:rgba(176,74,208,.25);font-weight:700}
  #pb-log{font:12px ui-monospace,monospace;max-height:150px;overflow:auto;white-space:pre-wrap;opacity:.9}
  .pb-aviso{font-size:12px;opacity:.7;margin:6px 0 0}
  .pb-alerta{background:#5a2a10;border:1px solid #ffb070;color:#ffd9b0;border-radius:8px;padding:8px 10px;font-size:13px}
  `;

  function toast(txt, ms = 3500) {
    document.getElementById('pb-toast')?.remove();
    const el = document.createElement('div');
    el.id = 'pb-toast';
    el.textContent = txt;
    document.body.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 500); }, ms);
  }

  function montarUI() {
    for (const id of ['pb-estilo', 'pb-botao', 'pb-fundo']) document.getElementById(id)?.remove();
    const st = document.createElement('style');
    st.id = 'pb-estilo';
    st.textContent = CSS;
    document.head.appendChild(st);

    const bt = document.createElement('button');
    bt.id = 'pb-botao';
    bt.innerHTML = '🤖 Bot<span class="pb-dot"></span>';
    bt.onclick = () => { document.getElementById('pb-fundo').classList.add('aberto'); pintarModal(); };
    document.body.appendChild(bt);

    const fundo = document.createElement('div');
    fundo.id = 'pb-fundo';
    fundo.innerHTML = '<div id="pb-modal"></div>';
    fundo.onclick = (e) => { if (e.target === fundo) fundo.classList.remove('aberto'); };
    document.body.appendChild(fundo);

    limpezas.push(() => { st.remove(); bt.remove(); fundo.remove(); });
  }

  // Sem núcleo: a página abriu antes da extensão estar instalada.
  if (!core) {
    const aviso = document.createElement('div');
    aviso.id = 'pb-toast';
    aviso.textContent = '🤖 PokeBot instalado — recarregue a página do jogo (fora de uma luta) para ativar.';
    aviso.style.cssText = 'position:fixed;left:14px;bottom:110px;z-index:100001;padding:8px 12px;border-radius:10px;background:#2a1515;color:#f6e7d4;border:2px solid #f3c77a;font:600 13px system-ui';
    document.body.appendChild(aviso);
    limpezas.push(() => aviso.remove());
    return;
  }

  // ---------------------------------------------------------------- leituras
  const eu = () => core.eu;
  const idUltra = () => core.catalogoBolas.find((b) => (b.nome ?? b.name) === NOME_BOLA)?.id ?? null;
  const precoUltra = () => Number(core.catalogoBolas.find((b) => b.id === idUltra())?.priceGold ?? 130);
  const qtdBola = (id) => Number(eu()?.balls?.[id] ?? 0);
  const qtdItem = (id) => Number(eu()?.items?.[id] ?? 0);
  const ativo = () => eu()?.pokemons?.find((p) => p.id === eu().activeId) ?? null;
  const pocoesVendidas = () => [...core.itens.values()].filter((i) => i.category === 'heal' && Number(i.npcPrice) > 0);
  const nomeItem = (id) => core.itens.get(id)?.name ?? `#${id}`;

  function limiar() {
    const v = Number(eu()?.automation?.hpLimiar ?? 0.3);
    return v > 1 ? v / 100 : v;
  }
  function curaDe(i, maxHp) {
    if (Number(i.healPct) > 0) return i.healPct * maxHp;
    return Number(i.healAmount ?? 0);
  }

  /**
   * Custo-benefício das poções. A poção entra quando o HP cai abaixo do limiar, então falta
   * ~ maxHp × (1 − limiar). Cura acima disso é desperdício; abaixo, nada se perde (a automação
   * usa outra logo em seguida). Custo efetivo = preço ÷ HP que a poção realmente devolve.
   */
  function analisePocoes() {
    const p = ativo();
    if (!p || !p.maxHp) return null;
    const falta = Math.max(1, p.maxHp * (1 - limiar()));
    const linhas = pocoesVendidas().map((i) => {
      const cura = curaDe(i, p.maxHp);
      const util = Math.min(cura, falta);
      return {
        id: i.id, nome: i.name, preco: Number(i.npcPrice), cura, util,
        custoHp: util > 0 ? Number(i.npcPrice) / util : Infinity,
        desperdicio: cura > 0 ? Math.max(0, 1 - util / cura) : 0,
      };
    }).sort((a, b) => a.custoHp - b.custoHp);
    return { pokemon: p, falta, linhas };
  }
  function pocaoEscolhida() {
    if (cfg.pocao.modo === 'fixa') return cfg.pocao.fixa;
    return analisePocoes()?.linhas[0]?.id ?? null;
  }
  function estoquePocoes() {
    const marcadas = eu()?.automation?.potionIds ?? [];
    const ids = marcadas.length ? marcadas : pocoesVendidas().map((i) => i.id);
    return ids.reduce((s, id) => s + qtdItem(id), 0);
  }

  // ---------------------------------------------------------------- ações
  const mem = core.memoria;
  mem.ultimaCompra ??= 0;
  mem.ultimaFila ??= 0;

  function comprar(kind, id, falta, preco, nome, tinha) {
    const livre = Number(eu().gold ?? 0) - cfg.reservaOuro;
    let qty = Math.min(falta, LOTE_MAX);
    if (preco > 0) qty = Math.min(qty, Math.floor(livre / preco));
    if (qty < 1) {
      registrar(`sem ouro livre para ${nome} (reserva ${fmt(cfg.reservaOuro)})`);
      mem.ultimaCompra = Date.now() + 60000;
      return 0;
    }
    if (core.send({ t: 'shop.buy', kind, id, qty })) {
      mem.ultimaCompra = Date.now();
      registrar(`comprou ${fmt(qty)}× ${nome} por ~${fmt(qty * preco)} de ouro (tinha ${fmt(tinha)})`);
      return qty;
    }
    return 0;
  }

  // Quantidade de cada reposição: sorteada entre o mín e o máx do painel. Acima de 9.999 (o teto
  // do servidor por compra) o lote sai em várias compras seguidas — `mem.lote` guarda o que falta,
  // e o lote termina mesmo que o estoque já tenha passado do gatilho.
  const sortear = ({ min, max }) => { const a = Math.min(min, max), b = Math.max(min, max); return a + Math.floor(Math.random() * (b - a + 1)); };
  function comprarLote(tipo, kind, id, preco, nome, tinha) {
    if (mem.lote?.tipo !== tipo || mem.lote.id !== id) {
      mem.lote = { tipo, id, resto: sortear(cfg[tipo]) };
      registrar(`${nome}: estoque ${fmt(tinha)}, abaixo de ${fmt(cfg[tipo].gatilho)} — vai comprar ${fmt(mem.lote.resto)} (sorteado entre ${fmt(cfg[tipo].min)} e ${fmt(cfg[tipo].max)})`);
    }
    const qtd = comprar(kind, id, mem.lote.resto, preco, nome, tinha);
    mem.lote.resto -= qtd;
    if (mem.lote.resto <= 0 || !qtd) mem.lote = null; // terminou, ou faltou ouro (sorteia de novo na próxima)
  }

  function ajustarFila(idMelhor) {
    const a = eu()?.automation;
    if (!cfg.ajustarFila || !a || idMelhor == null) return;
    const atual = a.potionIds ?? [];
    if (atual[0] === idMelhor) return;
    if (Date.now() - mem.ultimaFila < 60000) return;
    const resto = (atual.length ? atual : pocoesVendidas().map((i) => i.id)).filter((x) => x !== idMelhor);
    if (core.send({ t: 'auto.set', ...a, potionIds: [idMelhor, ...resto] })) {
      mem.ultimaFila = Date.now();
      registrar(`fila de poções da automação: ${nomeItem(idMelhor)} em 1º`);
    }
  }

  function tick() {
    const e = eu();
    if (!cfg.ativo || !core.logado || !e || e.gold == null) return;
    if (Date.now() - mem.ultimaCompra < ESPERA_POS_COMPRA_MS) return;

    const idPocao = pocaoEscolhida();
    ajustarFila(idPocao);

    const idBola = idUltra();
    if (idBola != null) {
      const q = qtdBola(idBola);
      if (q < cfg.bola.gatilho || (mem.lote?.tipo === 'bola' && mem.lote.id === idBola)) {
        return comprarLote('bola', 'ball', idBola, precoUltra(), NOME_BOLA, q);
      }
    }
    if (idPocao != null) {
      const q = estoquePocoes();
      if (q < cfg.pocao.gatilho || (mem.lote?.tipo === 'pocao' && mem.lote.id === idPocao)) {
        const it = core.itens.get(idPocao);
        return comprarLote('pocao', 'item', idPocao, Number(it?.npcPrice ?? 0), it?.name ?? `#${idPocao}`, q);
      }
    }
  }
  const timer = setInterval(tick, INTERVALO_MS);
  limpezas.push(() => clearInterval(timer));

  // ---------------------------------------------------------------- modal
  const aberto = () => document.getElementById('pb-fundo')?.classList.contains('aberto');
  let coreDesatualizado = false;

  function htmlAnalise() {
    const a = analisePocoes();
    if (!a) return '<p class="pb-aviso">Esperando o jogo mandar o pokémon ativo…</p>';
    const melhor = a.linhas[0]?.id;
    return `
      <p class="pb-aviso" style="margin-top:0">Ativo: <b>${a.pokemon.name ?? a.pokemon.nome ?? 'pokémon'}</b> · HP máx ${fmt(a.pokemon.maxHp)} ·
        limiar ${Math.round(limiar() * 100)}% → falta ~<b>${fmt(a.falta)}</b> HP quando a poção entra</p>
      <table class="pb-t">
        <tr><th>Poção</th><th>Preço</th><th>Cura</th><th>Aproveita</th><th>Ouro/HP</th></tr>
        ${a.linhas.map((l) => `
          <tr class="${l.id === melhor ? 'melhor' : ''}">
            <td>${l.id === melhor ? '★ ' : ''}${l.nome}</td><td>${fmt(l.preco)}</td><td>${fmt(l.cura)}</td>
            <td>${fmt(100 - l.desperdicio * 100)}%</td><td>${fmt2(l.custoHp)}</td>
          </tr>`).join('')}
      </table>`;
  }

  function pintarModal() {
    document.getElementById('pb-botao')?.classList.toggle('on', !!cfg.ativo);
    const modal = document.getElementById('pb-modal');
    if (!modal || !aberto()) return;
    const opcoesFixa = pocoesVendidas()
      .map((i) => `<option value="${i.id}" ${i.id === cfg.pocao.fixa ? 'selected' : ''}>${i.name} — ${fmt(i.npcPrice)} ouro</option>`)
      .join('');
    modal.innerHTML = `
      <header><span>🤖 POKEBOT<small>lógica v${VERSAO_LOGICA} · núcleo v${core.versao}</small></span><button id="pb-fechar" title="Fechar">✕</button></header>
      ${coreDesatualizado ? '<section><div class="pb-alerta">O núcleo do bot foi atualizado. Recarregue a página quando estiver fora de uma luta (no Centro Pokémon) para aplicar.</div></section>' : ''}
      <section class="pb-linha">
        <button class="pb-sw ${cfg.ativo ? 'on' : ''}" id="pb-ativo"></button>
        <b>${cfg.ativo ? 'Bot AUTORIZADO a recomprar' : 'Bot desligado'}</b>
        <span class="pb-aviso" id="pb-ouro" style="margin:0"></span>
      </section>
      <section>
        <h4>Ultra Ball</h4>
        <div class="pb-campos">
          <div><label>Comprar no mínimo</label><input type="number" min="1" step="1000" data-c="bola.min" value="${cfg.bola.min}"></div>
          <div><label>Comprar no máximo</label><input type="number" min="1" step="1000" data-c="bola.max" value="${cfg.bola.max}"></div>
          <div><label>Recomprar abaixo de</label><input type="number" min="0" step="1000" data-c="bola.gatilho" value="${cfg.bola.gatilho}"></div>
        </div>
        <div class="pb-est" id="pb-est-bola"></div>
      </section>
      <section>
        <h4>Poções</h4>
        <div class="pb-campos">
          <div><label>Comprar no mínimo</label><input type="number" min="1" step="500" data-c="pocao.min" value="${cfg.pocao.min}"></div>
          <div><label>Comprar no máximo</label><input type="number" min="1" step="500" data-c="pocao.max" value="${cfg.pocao.max}"></div>
          <div><label>Recomprar abaixo de</label><input type="number" min="0" step="500" data-c="pocao.gatilho" value="${cfg.pocao.gatilho}"></div>
          <div><label>Qual comprar</label>
            <select id="pb-modo">
              <option value="auto" ${cfg.pocao.modo === 'auto' ? 'selected' : ''}>Melhor custo-benefício (automático)</option>
              <option value="fixa" ${cfg.pocao.modo === 'fixa' ? 'selected' : ''}>Sempre a mesma</option>
            </select></div>
          <div><label>Poção fixa</label><select id="pb-fixa" ${cfg.pocao.modo === 'fixa' ? '' : 'disabled'}>${opcoesFixa}</select></div>
        </div>
        <div class="pb-linha" style="margin-top:8px">
          <button class="pb-sw ${cfg.ajustarFila ? 'on' : ''}" id="pb-fila"></button>
          <span style="font-size:13px">Colocar a poção escolhida em 1º na fila da automação "Usar Poções"</span>
        </div>
        <div class="pb-est" id="pb-est-pocao"></div>
        <div id="pb-analise"></div>
      </section>
      <section class="pb-linha">
        <label style="font-size:13px">Nunca deixar o ouro abaixo de</label>
        <input type="number" min="0" step="100000" data-c="reservaOuro" value="${cfg.reservaOuro}" style="width:170px">
      </section>
      <section>
        <h4>Registro</h4>
        <div id="pb-log">${log.join('\n') || 'nada ainda'}</div>
        <p class="pb-aviso">Compra no Market do NPC uma quantidade sorteada entre o mínimo e o máximo quando o estoque cai abaixo do gatilho — até ${fmt(LOTE_MAX)} por compra (acima disso, em várias seguidas), uma compra a cada ${ESPERA_POS_COMPRA_MS / 1000}s. Só funciona com a aba do jogo aberta.</p>
      </section>`;

    modal.querySelector('#pb-fechar').onclick = () => document.getElementById('pb-fundo').classList.remove('aberto');
    modal.querySelector('#pb-ativo').onclick = () => {
      cfg.ativo = !cfg.ativo; salvarCfg();
      registrar(cfg.ativo ? 'bot LIGADO' : 'bot desligado');
      pintarModal();
    };
    modal.querySelector('#pb-fila').onclick = () => { cfg.ajustarFila = !cfg.ajustarFila; salvarCfg(); pintarModal(); };
    modal.querySelector('#pb-modo').onchange = (e) => { cfg.pocao.modo = e.target.value; salvarCfg(); pintarModal(); };
    modal.querySelector('#pb-fixa').onchange = (e) => { cfg.pocao.fixa = Number(e.target.value); salvarCfg(); pintarVivo(true); };
    for (const el of modal.querySelectorAll('[data-c]')) {
      el.onchange = () => {
        const v = Math.max(0, Number(el.value) || 0);
        const [a, b] = el.dataset.c.split('.');
        if (b) cfg[a][b] = v; else cfg[a] = v;
        for (const t of [cfg.bola, cfg.pocao]) { t.min = Math.max(1, t.min); t.max = Math.max(t.min, t.max); } // o sorteio vai de min a max
        salvarCfg();
      };
    }
    pintarVivo(true);
  }

  let ultimoVivo = 0;
  function pintarVivo(forcar = false) {
    if (!aberto() || (!forcar && Date.now() - ultimoVivo < 1000)) return;
    ultimoVivo = Date.now();
    const e = eu();
    const ouro = document.getElementById('pb-ouro');
    if (ouro) ouro.textContent = core.logado && e ? `· ouro: ${fmt(e.gold)}` : '· esperando o jogo conectar…';
    const eb = document.getElementById('pb-est-bola');
    if (eb) {
      const q = idUltra() != null && e ? qtdBola(idUltra()) : null;
      eb.textContent = q == null ? 'estoque: —' : `estoque agora: ${fmt(q)} Ultra Balls`;
      eb.classList.toggle('baixo', q != null && q < cfg.bola.gatilho);
    }
    const ep = document.getElementById('pb-est-pocao');
    if (ep && e) {
      const q = estoquePocoes();
      const id = pocaoEscolhida();
      ep.textContent = `estoque agora: ${fmt(q)} poções · próxima compra: ${id != null ? nomeItem(id) : '—'}`;
      ep.classList.toggle('baixo', q < cfg.pocao.gatilho);
    }
    const an = document.getElementById('pb-analise');
    if (an) an.innerHTML = htmlAnalise();
  }

  // ---------------------------------------------------------------- ligação
  const soltar = core.on((m) => {
    if (m.t === 'welcome' || m.t === 'pb.itens' || m.t === 'pb.desconectou') pintarModal();
    else if (m.t === 'estado') pintarVivo();
    else if (m.t === 'erro' && Date.now() - mem.ultimaCompra < 5000) registrar(`servidor recusou: ${m.chave ?? m.msg ?? 'erro'}`);
  });
  limpezas.push(soltar);

  const aoMensagem = (ev) => {
    if (ev.source === window && ev.data?.pokebot === 'core-mudou') { coreDesatualizado = true; pintarModal(); toast('🤖 Núcleo atualizado — recarregue fora de luta para aplicar.', 6000); }
  };
  window.addEventListener('message', aoMensagem);
  limpezas.push(() => window.removeEventListener('message', aoMensagem));

  // O convite "Join Discord" do jogo abre ao entrar e, no quadro pequeno da grade, é mais alto que
  // a tela: o × fica acima do topo, sem como clicar. Dispensa pelo botão "já estou na comunidade,
  // não mostrar de novo" (o servidor grava e ele não volta); sem esse botão, fecha pelo ×.
  const fecharDiscord = setInterval(() => {
    const pop = document.getElementById('discord-popup');
    if (!pop || pop.classList.contains('hidden')) return;
    (document.getElementById('discord-popup-dispensar') ?? document.getElementById('discord-popup-fechar'))?.click();
    registrar('convite do Discord dispensado');
  }, 2000);
  limpezas.push(() => clearInterval(fecharDiscord));

  // Captura sempre ligada: "lançar sem parar" (VIP) e a Ultra Ball como bola ativa, em toda conta.
  // O caçador de shiny também mexe nas bolas — com shiny no mapa ele deixa só a Beast e depois
  // devolve, e fora disso mantém a Beast em 2º — então: com shiny no mapa não se mexe em nada, e
  // a bola dele em 2º é aceita. Confere a cada 15 s; só manda quando algo está diferente.
  let avisouSemVip = false;
  const garantirCaptura = setInterval(() => {
    const e = core.eu;
    const a = e?.automation;
    if (!core.logado || !a) return;
    if (!e.loja?.vip) {
      if (!avisouSemVip) registrar('captura sem parar: esta conta não tem VIP — o jogo só deixa ligar com VIP');
      avisouSemVip = true;
      return;
    }
    if (window.__pokeShiny?.ocupado || core.memoria.shiny?.ballIdsAntes != null) return;
    const ultra = idUltra();
    if (ultra == null) return;
    let bolaShiny = null;
    try {
      const sh = JSON.parse(localStorage.getItem('pokeshiny.v1'));
      if (sh?.ativo && sh.duasAtivas !== false) bolaShiny = core.catalogoBolas.find((b) => (b.nome ?? b.name) === sh.bola)?.id ?? null;
    } catch {}
    const atuais = (a.ballIds ?? []).map(Number);
    const bolas = [ultra, ...atuais.filter((id) => id === bolaShiny && id !== ultra)];
    const semParar = a.autoBallSemParar && !a.autoBallAteCapturar;
    if (semParar && atuais.length === bolas.length && atuais.every((id, i) => id === bolas[i])) return;
    const nova = { ...a, autoBallSemParar: true, autoBallAteCapturar: false, ballIds: bolas };
    if (!core.send({ t: 'auto.set', ...nova })) return;
    e.automation = nova; // a confirmação do servidor vem depois; evita mandar de novo no próximo tique
    registrar(`captura: ${semParar ? '' : 'lançar sem parar LIGADO · '}bolas ativas → ${bolas.map((id) => core.catalogoBolas.find((b) => b.id === id)?.nome ?? core.catalogoBolas.find((b) => b.id === id)?.name ?? id).join(', ')}`);
  }, 15_000);
  limpezas.push(() => clearInterval(garantirCaptura));

  // Vendas automáticas, em toda conta (com e sem tela). Uma etapa por vez, nesta ordem:
  //   1. cadeado nos itens valiosos (Boss Token, peças de TM, fragmentos) — ANTES de ligar a venda;
  //   2. venda automática de loot do jogo (o servidor vende na hora o que cai sem cadeado; pedras
  //      de evolução e poções não são loot e ficam);
  //   3. trava por nota do jogo em 3,5 e trava de shiny: o servidor manda para a Coleção (nunca
  //      vendida) todo pokémon de nota 3,5+ — os que já existem e os que forem capturados;
  //   4. o time inteiro na Coleção também, para nunca entrar numa venda;
  //   5. DUAS VEZES POR DIA, em horários sorteados por conta (um entre 7h e 14h, outro entre 17h e
  //      23h30), vende ao NPC os pokémon soltos — que, com a trava ligada, são os de nota < 3,5.
  //      Vender a cada captura tinha cara de bot. A proteção dos bons (passo 3) roda o tempo todo.
  // Os pedidos de cadeado/Coleção são INTERRUPTORES no servidor: um mesmo pedido mandado duas
  // vezes destranca. Por isso cada um é lembrado e só reenviado depois de 2 min sem confirmação.
  const VENDA_NOTA_MIN = 3.5;
  const CHAVE_VENDA_DIA = 'pokebot.vendaPk.v1'; // { dia, horas: [ms, ms], feitas: [bool, bool] }
  const diaHoje = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  function planoVendaDoDia() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(CHAVE_VENDA_DIA)); } catch {}
    if (p?.dia === diaHoje() && Array.isArray(p.horas)) return p;
    const base = new Date(); base.setHours(0, 0, 0, 0);
    const sorteio = (deH, ateH) => base.getTime() + Math.round((deH + Math.random() * (ateH - deH)) * 3_600_000);
    p = { dia: diaHoje(), horas: [sorteio(7, 14), sorteio(17, 23.5)], feitas: [false, false] };
    try { localStorage.setItem(CHAVE_VENDA_DIA, JSON.stringify(p)); } catch {}
    const hm = (ms) => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    registrar(`vendas de pokémon de hoje sorteadas: ${hm(p.horas[0])} e ${hm(p.horas[1])}`);
    return p;
  }
  const ITENS_GUARDAR = [70000, 59194, 40530, 70011, 70012, 70013, 70014, 70015];
  mem.vendaPkEm ??= 0;
  mem.pedidosTrava ??= {}; // 'loot:ID' | 'pk:ID' → quando foi pedido
  const podePedir = (k) => Date.now() - (mem.pedidosTrava[k] ?? 0) > 120_000;
  const garantirVendas = setInterval(() => {
    const e = eu();
    const a = e?.automation;
    if (!core.logado || !a || !e.pokemons) return;
    const lootTrav = (a.lootTravado ?? []).map(Number);
    const faltamItens = ITENS_GUARDAR.filter((id) => !lootTrav.includes(id) && podePedir(`loot:${id}`));
    if (ITENS_GUARDAR.some((id) => !lootTrav.includes(id))) {
      for (const id of faltamItens) { core.send({ t: 'shop.lockLoot', id }); mem.pedidosTrava[`loot:${id}`] = Date.now(); }
      if (faltamItens.length) registrar(`cadeado em ${faltamItens.length} item(ns) valioso(s) antes da venda automática`);
      return; // só liga a venda com todos os valiosos trancados
    }
    if (!a.autoVendaLoot) {
      if (core.send({ t: 'shop.autoVendaLoot', ativo: true, avisoVisto: true })) { a.autoVendaLoot = true; registrar('venda automática de loot LIGADA (itens com cadeado, pedras e poções ficam)'); }
      return;
    }
    if (!a.autoLockNota9 || Number(a.autoLockNotaMin) !== VENDA_NOTA_MIN) {
      if (core.send({ t: 'shop.autoLockNota9', ativo: true, nota: VENDA_NOTA_MIN })) {
        a.autoLockNota9 = true; a.autoLockNotaMin = VENDA_NOTA_MIN;
        registrar(`trava por nota LIGADA: nota ${String(VENDA_NOTA_MIN).replace('.', ',')}+ vai para a Coleção`);
      }
      return;
    }
    if (!a.autoLockShiny) { if (core.send({ t: 'shop.autoLockShiny', ativo: true })) a.autoLockShiny = true; return; }
    const pkTrav = new Set((a.pokemonTravado ?? []).map(Number));
    const timeSolto = e.pokemons.filter((p) => p.slot != null && !pkTrav.has(Number(p.id)));
    if (timeSolto.length) {
      for (const p of timeSolto) if (podePedir(`pk:${p.id}`)) { core.send({ t: 'colecao.mover', pokemonId: p.id, para: 'colecao' }); mem.pedidosTrava[`pk:${p.id}`] = Date.now(); }
      return; // vende só com o time inteiro protegido
    }
    const soltos = e.pokemons.filter((p) => p.slot == null && !pkTrav.has(Number(p.id)));
    if (!soltos.length) return;
    // Os bons que ainda estão soltos (capturados antes da trava, ou ela só vale para os novos):
    // Coleção também, um a um. A venda espera até não sobrar nenhum.
    const bonsSoltos = soltos.filter((p) => Number(p.nota) >= VENDA_NOTA_MIN || p.shiny);
    if (bonsSoltos.length) {
      const novos = bonsSoltos.filter((p) => podePedir(`pk:${p.id}`));
      for (const p of novos) { core.send({ t: 'colecao.mover', pokemonId: p.id, para: 'colecao' }); mem.pedidosTrava[`pk:${p.id}`] = Date.now(); }
      if (novos.length) registrar(`${novos.length} pokémon bom(ns) (nota ${String(VENDA_NOTA_MIN).replace('.', ',')}+ ou shiny) guardado(s) na Coleção`);
      return;
    }
    // Segurança: algum solto ainda com nota 3,5+ (trava não aplicada), shiny, sem nota ou segurando
    // item = espera a próxima rodada em vez de arriscar vender.
    if (soltos.some((p) => p.nota == null || Number(p.nota) >= VENDA_NOTA_MIN || p.shiny || p.heldItemId)) return;
    const plano = planoVendaDoDia();
    const vez = plano.horas.findIndex((t, i) => !plano.feitas[i] && Date.now() >= t);
    if (vez < 0) return; // ainda não é a hora de nenhuma das vendas de hoje
    const ateId = Math.max(...soltos.map((p) => Number(p.id)));
    if (core.send({ t: 'shop.sellAllPokemons', ateId })) {
      mem.vendaPkEm = Date.now();
      plano.feitas[vez] = true;
      try { localStorage.setItem(CHAVE_VENDA_DIA, JSON.stringify(plano)); } catch {}
      const melhor = Math.max(...soltos.map((p) => Number(p.nota)));
      registrar(`vendeu ${soltos.length} pokémon de nota < ${String(VENDA_NOTA_MIN).replace('.', ',')} (a melhor era ${melhor.toFixed(2).replace('.', ',')})`);
    }
  }, 20_000);
  limpezas.push(() => clearInterval(garantirVendas));

  // Quadros por segundo: o jogo é idle (quem decide é o servidor), mas redesenhava a cena a cada
  // quadro do navegador (~60/s), tudo no processador numa VPS sem placa de vídeo. Aqui o
  // requestAnimationFrame da página passa a rodar a 10 quadros/s com a conta à vista e a 1/s com
  // ela escondida (outra página da grade, aba 1×1 de outra conta). Instalado uma vez por página;
  // a troca a quente da lógica só ajusta os números. Desligável com localStorage 'pokebot.fps' = '0'.
  if (localStorage.getItem('pokebot.fps') !== '0') {
    const fps = (window.__pbFps ??= { visivel: 10, escondida: 1 });
    if (!window.__pbRafOriginal) {
      window.__pbRafOriginal = window.requestAnimationFrame.bind(window);
      const cancelarOriginal = window.cancelAnimationFrame.bind(window);
      const esperas = new Map(); // id → setTimeout
      let proximoId = 1;
      window.requestAnimationFrame = (cb) => {
        const id = proximoId++;
        const alvo = document.visibilityState === 'hidden' || window.__pbEscondida ? fps.escondida : fps.visivel;
        esperas.set(id, setTimeout(() => {
          esperas.delete(id);
          window.__pbRafOriginal((t) => cb(t));
        }, 1000 / Math.max(1, alvo)));
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        const t = esperas.get(id);
        if (t != null) { clearTimeout(t); esperas.delete(id); } else cancelarOriginal(id);
      };
    }
  }

  // Modo leve: sem placa de vídeo (VPS), as animações e transições de CSS do jogo eram o maior
  // gasto de CPU do app (~90% de um núcleo nas 4 contas). Aqui toda animação termina na hora:
  // duração quase zero e uma volta só (as infinitas param). Duração 0 de verdade não serve — aí
  // o navegador não dispara animationend/transitionend, e o jogo espera esses eventos para
  // tirar avisos e trocar telas. Desligável com localStorage 'pokebot.animacoes' = '1'.
  if (localStorage.getItem('pokebot.animacoes') !== '1') {
    document.getElementById('pb-leve')?.remove();
    const leve = document.createElement('style');
    leve.id = 'pb-leve';
    leve.textContent = '*,*::before,*::after{animation-duration:1ms!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:1ms!important;transition-delay:0s!important}';
    (document.head ?? document.documentElement).appendChild(leve);
    limpezas.push(() => leve.remove());
  }

  const iniciar = () => {
    montarUI();
    if (estavaAberto) document.getElementById('pb-fundo').classList.add('aberto');
    pintarModal();
    if (mem.jaCarregou) {
      registrar(`lógica atualizada para v${VERSAO_LOGICA}`);
      toast(`🤖 Bot atualizado — lógica v${VERSAO_LOGICA}`);
    }
    mem.jaCarregou = true;
  };
  if (document.body) iniciar();
  else document.addEventListener('DOMContentLoaded', iniciar, { once: true });
})();

// PokéIdle Bot — ROTAÇÃO DE MAPAS. Trocada a quente junto com a lógica.
//
// No jogo, a troca de área pelo Mapa só é aceita fora de combate: quando a onda acaba (todo
// selvagem do campo caiu) a "saída" libera na hora. Este módulo espera exatamente esse momento
// e manda `hunt.select` para o próximo mapa da lista — o mesmo pedido que o botão "Caçar" do
// Mapa faz. Tudo continua passando pelas travas do servidor: se ele recusar, a rotação só
// espera a próxima onda limpa.
//
// Como saber que a onda acabou: pelo próprio botão "Ir para o Centro Pokémon" (`#ir-centro`).
// O jogo o recalcula a cada 80 ms com a regra do servidor (`restaCombateHuntMs`): desativado em
// combate, ativo quando a saída libera — entre ondas, ou 3 s sem troca de dano. A passagem de
// desativado para ativo é a onda limpa. Funciona também no Modo Economia.
(() => {
  'use strict';
  const VERSAO_ROTACAO = '1.0.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pr-fundo')?.classList.contains('aberto');
  window.__pokeRotacao?.desmontar?.();

  const limpezas = [];
  const R = {
    versao: VERSAO_ROTACAO,
    get ativo() { return cfg.ativo; },
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokeRotacao = R;

  // ---------------------------------------------------------------- constantes
  const CHAVE_CFG = 'pokerotacao.v1';
  const TIQUE_MS = 150;             // de quanto em quanto tempo olha o botão de saída
  const ESPERA_TROCA_MS = 4000;    // depois de pedir uma troca, não pede outra antes disso
  const PORTA_MS = 10_000;         // a porta do servidor: 10 s desde a última entrada pelo Mapa

  function lerCfg() {
    const padrao = { ativo: false, mapas: [], ondas: 1 };
    try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; } catch { return padrao; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };

  // O que precisa sobreviver à troca a quente deste arquivo mora no núcleo.
  const mem = (core.memoria.rotacao ??= { ondasNoMapa: 0, trocas: 0, log: [], portaEm: 0, pedidoEm: 0 });
  let saidaTravada = null;         // último estado visto do botão (null = ainda não visto neste mapa)
  let busca = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hora = () => new Date().toLocaleTimeString('pt-BR');
  function registrar(txt) {
    mem.log.unshift(`${hora()} · ${txt}`);
    mem.log.length = Math.min(mem.log.length, 40);
    console.log('[Rotação]', txt);
    pintarLog();
  }

  const hunts = () => core.hunts ?? [];
  const huntPorSlug = (slug) => hunts().find((h) => h.slug === slug);
  const nomeMapa = (slug) => huntPorSlug(slug)?.nome ?? cfg.mapas.find((m) => m.slug === slug)?.nome ?? String(slug).replace(/[-_]/g, ' ');

  // ---------------------------------------------------------------- decisão
  function podeSair() {
    const e = core.eu;
    if (!e?.huntSlug) return 'fora de hunt';
    if (e.noCentro) return 'no Centro Pokémon';
    if (e.boss?.arena || e.mistico) return 'em boss/Arena';
    return null;
  }

  function proximoMapa() {
    const lista = cfg.mapas.map((m) => m.slug);
    if (!lista.length) return null;
    const i = lista.indexOf(core.eu?.huntSlug);
    return lista[(i + 1) % lista.length]; // fora da lista (i = -1) começa pelo primeiro
  }

  /** A onda do mapa acabou: conta e, se for a hora, troca. */
  function ondaLimpa(origem) {
    if (!cfg.ativo || cfg.mapas.length < 1) return;
    const motivo = podeSair();
    if (motivo) return;
    const agora = Date.now();
    if (agora - mem.pedidoEm < ESPERA_TROCA_MS) return;
    const naLista = cfg.mapas.some((m) => m.slug === core.eu.huntSlug);
    if (naLista) mem.ondasNoMapa++;
    if (naLista && mem.ondasNoMapa < Math.max(1, Number(cfg.ondas) || 1)) {
      registrar(`onda limpa em ${nomeMapa(core.eu.huntSlug)} (${mem.ondasNoMapa}/${cfg.ondas})`);
      pintar();
      return;
    }
    if (agora < mem.portaEm) {
      registrar(`onda limpa, mas a porta do Mapa só abre em ${Math.ceil((mem.portaEm - agora) / 1000)} s — fico mais uma onda`);
      return;
    }
    if (window.__pokeShiny?.ocupado) {
      registrar('onda limpa, mas há um shiny no chão sendo capturado — fico mais uma onda');
      return;
    }
    const alvo = proximoMapa();
    if (!alvo || (alvo === core.eu.huntSlug && cfg.mapas.length === 1)) return;
    mem.pedidoEm = agora;
    if (core.send({ t: 'hunt.select', slug: alvo })) {
      registrar(`🔄 ${nomeMapa(core.eu.huntSlug)} → ${nomeMapa(alvo)} (${origem})`);
    }
  }

  // ---------------------------------------------------------------- escuta do jogo
  /** O botão de saída do jogo: null = não está numa hunt (contêiner escondido). */
  function saidaLiberada() {
    const caixa = document.getElementById('hunt-saida');
    const btn = document.getElementById('ir-centro');
    if (!caixa || !btn || caixa.classList.contains('hidden')) return null;
    return !btn.disabled;
  }

  function tique() {
    const livre = saidaLiberada();
    if (livre === null) { saidaTravada = null; return; }
    // Só conta a passagem travado → livre: a onda teve combate e acabou.
    if (livre && saidaTravada === true) ondaLimpa('saída liberada');
    saidaTravada = !livre;
  }

  function aoMensagem(ev) {
    if (typeof ev.data !== 'string' || (!ev.data.includes('"t":"batalha"') && !ev.data.includes('"t":"erro"'))) return;
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.t === 'batalha') {
      for (const e of m.ev ?? []) {
        if (e.k !== 'hunt') continue;
        // Entrou num mapa: zera a contagem e anota a porta de 10 s do servidor.
        mem.portaEm = e.trocaLivreEm ? Number(e.trocaLivreEm) : Date.now() + PORTA_MS;
        mem.ondasNoMapa = 0;
        saidaTravada = null;
        if (Date.now() - mem.pedidoEm < 6000) mem.trocas++;
      }
    } else if (m.t === 'erro' && Date.now() - mem.pedidoEm < 3000) {
      registrar(`servidor recusou a troca: ${m.msg ?? m.erro ?? m.chave ?? 'sem motivo'} — tento na próxima onda`);
    }
  }

  // A conexão muda (reconexão, troca de conta): ouve sempre a de agora.
  let wsOuvido = null;
  function ligarWs() {
    if (core.ws === wsOuvido) return;
    wsOuvido?.removeEventListener('message', aoMensagem);
    wsOuvido = core.ws;
    wsOuvido?.addEventListener('message', aoMensagem);
  }
  ligarWs();
  const vigia = setInterval(() => { ligarWs(); pintarStatus(); }, 1000);
  const relogio = setInterval(tique, TIQUE_MS);
  limpezas.push(() => { clearInterval(vigia); clearInterval(relogio); wsOuvido?.removeEventListener('message', aoMensagem); });

  // ---------------------------------------------------------------- UI
  const CSS = `
  #pr-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #pr-fundo.aberto{display:flex}
  #pr-modal{width:min(820px,96vw);max-height:92vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pr-modal header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pr-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pr-modal header button{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pr-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  #pr-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a}
  .pr-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pr-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pr-bt:hover{background:#6e3d3d}.pr-bt:disabled{opacity:.45;cursor:default}
  .pr-sw{position:relative;width:44px;height:24px;border-radius:12px;background:#6a4a4a;cursor:pointer;border:none;flex:none}
  .pr-sw::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}
  .pr-sw.on{background:#2f9a4a}.pr-sw.on::after{left:23px}
  .pr-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit}
  .pr-in[type=number]{width:60px}
  .pr-lista{display:grid;gap:4px}
  .pr-item{display:flex;align-items:center;gap:8px;background:#2a1515;border-radius:8px;padding:5px 8px}
  .pr-item.atual{outline:2px solid #7fdc8f}
  .pr-item .pr-n{background:#b04ad0;color:#fff;border-radius:5px;padding:0 6px;font-weight:800}
  .pr-item .pr-nome{flex:1}
  .pr-item small{opacity:.7}
  .pr-cat{max-height:220px;overflow:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:4px;margin-top:6px}
  .pr-cat button{text-align:left}
  .pr-log{font:11px ui-monospace,monospace;white-space:pre-wrap;max-height:150px;overflow:auto;background:#2a1515;border-radius:8px;padding:6px 8px;margin:0}
  .pr-ok{color:#7fdc8f}.pr-aviso{color:#f3c77a}`;

  function montarUI() {
    const css = document.createElement('style');
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pr-fundo';
    fundo.innerHTML = '<div id="pr-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('input', (e) => {
      if (e.target.dataset.c === 'busca') { busca = e.target.value; pintarCatalogo(); }
      if (e.target.dataset.c === 'ondas') { cfg.ondas = Math.max(1, Math.min(50, Number(e.target.value) || 1)); salvarCfg(); }
    });
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => { css.remove(); fundo.remove(); document.removeEventListener('keydown', aoEsc); });
  }

  const estaAberto = () => document.getElementById('pr-fundo')?.classList.contains('aberto');

  function pintar() {
    const modal = document.getElementById('pr-modal');
    if (!modal || !estaAberto()) return;
    const atual = core.eu?.huntSlug;
    const atualNaLista = cfg.mapas.some((m) => m.slug === atual);
    modal.innerHTML = `
      <header><span>🔄 Rotação de mapas<small>v${VERSAO_ROTACAO}</small></span><button data-a="fechar" title="Fechar">×</button></header>
      <section>
        <div class="pr-linha">
          <button class="pr-sw ${cfg.ativo ? 'on' : ''}" data-a="ativo" title="Ligar/desligar"></button>
          <b>${cfg.ativo ? 'Rotação ligada' : 'Rotação desligada'}</b>
          <span style="flex:1"></span>
          trocar a cada <input type="number" class="pr-in" data-c="ondas" min="1" max="50" value="${esc(cfg.ondas)}"> onda(s) limpa(s)
        </div>
        <p id="pr-status" style="margin:8px 0 0"></p>
      </section>
      <section>
        <h4>Ordem da rotação</h4>
        <div class="pr-lista">${cfg.mapas.map((m, i) => `
          <div class="pr-item ${m.slug === atual ? 'atual' : ''}">
            <span class="pr-n">${i + 1}</span>
            <span class="pr-nome">${esc(nomeMapa(m.slug))} ${huntPorSlug(m.slug)?.nivel ? `<small>Nv ${huntPorSlug(m.slug).nivel}</small>` : ''}${m.slug === atual ? ' <small class="pr-ok">● você está aqui</small>' : ''}</span>
            <button class="pr-bt" data-a="subir" data-i="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="pr-bt" data-a="descer" data-i="${i}" ${i === cfg.mapas.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="pr-bt" data-a="tirar" data-i="${i}" title="Remover">×</button>
          </div>`).join('') || '<span class="pr-aviso">Nenhum mapa na rotação ainda.</span>'}</div>
        <div class="pr-linha" style="margin-top:8px">
          <button class="pr-bt" data-a="atual" ${!atual || atualNaLista ? 'disabled' : ''}>+ Adicionar o mapa onde estou${atual ? ` (${esc(nomeMapa(atual))})` : ''}</button>
          ${cfg.mapas.length ? '<button class="pr-bt" data-a="limpar">Limpar lista</button>' : ''}
        </div>
      </section>
      <section>
        <h4>Adicionar da lista de mapas</h4>
        ${hunts().length
          ? `<input class="pr-in" data-c="busca" placeholder="buscar mapa ou pokémon…" value="${esc(busca)}" style="width:260px" spellcheck="false">
             <div class="pr-cat" id="pr-cat"></div>`
          : '<span class="pr-aviso">A lista de mapas chega quando a conta carrega. Recarregue esta conta (⟳, no Centro Pokémon) uma vez para ela aparecer aqui — enquanto isso, use "Adicionar o mapa onde estou".</span>'}
      </section>
      <section>
        <h4>Registro</h4>
        <pre class="pr-log" id="pr-log"></pre>
      </section>`;
    pintarCatalogo();
    pintarStatus();
    pintarLog();
  }

  function pintarCatalogo() {
    const host = document.getElementById('pr-cat');
    if (!host) return;
    const q = busca.trim().toLowerCase();
    const nivel = Number(core.eu?.level) || 0;
    const usados = new Set(cfg.mapas.map((m) => m.slug));
    const nomeEspecie = (id) => window.__pokeAnaliseDados?.catalogo?.get(id)?.name ?? '';
    const lista = hunts()
      .filter((h) => !usados.has(h.slug))
      .filter((h) => !q || h.nome?.toLowerCase().includes(q) || (h.especies ?? []).some((id) => nomeEspecie(id).toLowerCase().includes(q)))
      .sort((a, b) => (a.nivel ?? 0) - (b.nivel ?? 0))
      .slice(0, 200);
    host.innerHTML = lista.map((h) => {
      const travada = nivel && h.nivel > nivel;
      return `<button class="pr-bt" data-a="add" data-slug="${esc(h.slug)}" ${travada ? 'disabled' : ''} title="${travada ? `Precisa do Nv ${h.nivel}` : 'Adicionar à rotação'}">+ ${esc(h.nome)} <small>Nv ${h.nivel ?? '?'}</small></button>`;
    }).join('') || '<span class="pr-aviso">Nenhum mapa encontrado.</span>';
  }

  function pintarStatus() {
    const el = document.getElementById('pr-status');
    if (!el) return;
    const atual = core.eu?.huntSlug;
    const motivo = podeSair();
    const prox = proximoMapa();
    const porta = Math.max(0, Math.ceil((mem.portaEm - Date.now()) / 1000));
    const livre = saidaLiberada();
    const modo = livre === null ? 'fora de hunt' : livre ? 'saída liberada' : 'em combate';
    el.innerHTML = [
      `Mapa atual: <b>${atual ? esc(nomeMapa(atual)) : '—'}</b>`,
      prox && cfg.mapas.length > 1 ? `próximo: <b>${esc(nomeMapa(prox))}</b>` : '',
      cfg.mapas.some((m) => m.slug === atual) ? `ondas limpas aqui: ${mem.ondasNoMapa}/${cfg.ondas}` : '',
      `trocas: ${mem.trocas}`,
      porta ? `<span class="pr-aviso">porta do Mapa abre em ${porta} s</span>` : '',
      motivo ? `<span class="pr-aviso">pausada: ${esc(motivo)}</span>` : '',
      `<small>(${modo})</small>`,
    ].filter(Boolean).join(' · ');
  }

  function pintarLog() {
    const el = document.getElementById('pr-log');
    if (el) el.textContent = mem.log.join('\n') || 'Nada ainda.';
  }

  function aoClicar(e) {
    if (e.target.id === 'pr-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b || b.disabled) return;
    const a = b.dataset.a;
    const i = Number(b.dataset.i);
    if (a === 'fechar') return fechar();
    if (a === 'ativo') {
      cfg.ativo = !cfg.ativo;
      mem.ondasNoMapa = 0;
      registrar(cfg.ativo ? `rotação ligada (${cfg.mapas.length} mapas, troca a cada ${cfg.ondas} onda(s))` : 'rotação desligada');
    } else if (a === 'atual' && core.eu?.huntSlug) {
      cfg.mapas.push({ slug: core.eu.huntSlug, nome: nomeMapa(core.eu.huntSlug) });
    } else if (a === 'add') {
      const h = huntPorSlug(b.dataset.slug);
      cfg.mapas.push({ slug: b.dataset.slug, nome: h?.nome ?? b.dataset.slug });
    } else if (a === 'tirar') cfg.mapas.splice(i, 1);
    else if (a === 'subir' && i > 0) [cfg.mapas[i - 1], cfg.mapas[i]] = [cfg.mapas[i], cfg.mapas[i - 1]];
    else if (a === 'descer' && i < cfg.mapas.length - 1) [cfg.mapas[i + 1], cfg.mapas[i]] = [cfg.mapas[i], cfg.mapas[i + 1]];
    else if (a === 'limpar') cfg.mapas = [];
    salvarCfg();
    pintar();
  }

  function abrir() { document.getElementById('pr-fundo').classList.add('aberto'); pintar(); }
  function fechar() { document.getElementById('pr-fundo')?.classList.remove('aberto'); }

  montarUI();
  if (estavaAberto) abrir();
})();

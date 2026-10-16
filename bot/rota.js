// PokéIdle Bot — ROTA DE UPAR. Trocada a quente junto com a lógica.
//
// Leva o pokémon ATIVO por uma rota fixa de hunts conforme o nível dele, e evolui no caminho:
//   nv 1–10 Geodude · 11–39 Diglett · 40: Centro → compra 2 Water Stone no Mercado → evolui
//   (Squirtle → Wartortle) → Larvitar · 80: Centro → evolui de novo (Wartortle → Blastoise) →
//   Larvitar até o 99 · 100–199 Pupitar · 200+: Brave Charizard, na Outland (onde a rota termina
//   e a conta segue caçando).
//
// Tudo é decidido a partir do estado atual (nível, espécie, hunt, bolsa), sem memória de "em que
// passo estava": recarregar a página ou trocar a lógica a quente retoma do ponto certo.
// Desligada por padrão; liga por conta no botão 🧭 do app.
(() => {
  'use strict';
  const VERSAO_ROTA = '1.8.1';

  const core = window.__pokebotCore;
  if (!core) return;
  window.__pokeRota?.desmontar?.();

  // ---------------------------------------------------------------- a rota
  // Hunt pelo nível do pokémon ativo: vale a última linha com `de` <= nível.
  const HUNTS = [
    { de: 1, hunt: 'geodude' },
    { de: 11, hunt: 'diglett' },
    { de: 40, hunt: 'larvitar' },
    { de: 100, hunt: 'pupitar' },
    { de: 200, hunt: 'brave_charizard' }, // Outland — libera no nível 150 de treinador
  ];
  const NIVEL_FIM = 200;
  // Rota do Charizard: quando ligada, TODAS as contas com a rota vão para o Charizard de Kanto (o do
  // primeiro mapa, libera no nível 80 de treinador) e, com o pokémon no nível 300, para o Brave
  // Charizard da Outland. As evoluções do caminho continuam. false = volta à tabela HUNTS acima.
  const ROTA_CHARIZARD = true;
  // Agora todas direto na Outland (Brave Charizard), em qualquer nível. Para voltar ao "Kanto até o
  // 300": (nv) => (nv >= 300 ? 'brave_charizard' : 'charizard').
  // nv 500+: Numel (Orre, libera com treinador nv 530). Enquanto o treinador não chega lá, segue no
  // Brave Charizard — a lista é de preferência, vale a primeira hunt já liberada.
  // No jogo o Numel é `numel_hoenn` (o map-markers.json do site diz `numel`, que o servidor ignora).
  const huntCharizard = (nv) => (nv >= 500 ? ['numel_hoenn', 'brave_charizard'] : ['brave_charizard']);
  // Degrau da Outland (o seletor do Mapa): mesmos bichos, drops raros mais frequentes. Com o pokémon
  // no nível 500 a conta passa para a Outland 2 — o servidor só aceita com o TREINADOR no 500
  // (tabela em /shared/outland-tiers.mjs do jogo). Só sobe, nunca desce.
  const OUTLAND_POR_NIVEL = [{ nivel: 500, tier: 2 }];
  const NIVEL_TREINADOR_TIER = { 2: 500, 3: 1000, 4: 2000, 5: 4000 };
  // Evoluções no caminho (speciesId de → para). Cada uma gasta 1 pedra; na primeira o app já
  // compra as que a cadeia inteira vai precisar.
  const EVOLUCOES = [
    { nivel: 40, de: 7, para: 8 },   // Squirtle → Wartortle
    { nivel: 80, de: 8, para: 9 },   // Wartortle → Blastoise
  ];
  const PEDRA = { itemId: 142, nome: 'Water Stone' };

  const CHAVE_CFG = 'pokerota.v1';
  // Spot do dia na Outland: a janela do app escolhe um por conta, todo dia, pelo guia (XP/h, só os
  // seguros) e diferente entre as contas; aqui ele entra no lugar do Brave Charizard fixo. Vale só
  // no dia em que foi escolhido — sem spot de hoje, volta ao Brave Charizard.
  const CHAVE_SPOT = 'pokerota.spot.v1';
  const hojeLocal = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let spotDoDia = (() => { try { return JSON.parse(localStorage.getItem(CHAVE_SPOT)); } catch { return null; } })();
  const spotDeHoje = () => (spotDoDia?.dia === hojeLocal() && spotDoDia.slug ? spotDoDia : null);
  const TICK_MS = 4000;
  // Espera entre tentativas do MESMO passo. Ler e comprar no Mercado são passos separados: com uma
  // espera só, a compra caía sempre dentro da espera da leitura e a leitura vencia antes — nunca comprava.
  const ESPERA = { centro: 6000, hunt: 12_000, lerMercado: 8000, comprar: 10_000, evoluir: 10_000, tier: 15_000 };

  const cfg = (() => {
    const padrao = { ativo: false, precoMax: 200_000 }; // preço máximo por pedra, em Coins
    try { return { ...padrao, ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; } catch { return padrao; }
  })();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };

  const log = (core.memoria.rotaLog ??= []); // sobrevive à troca a quente
  let status = 'desligada';
  function registrar(txt) {
    if (log[0]?.endsWith(` · ${txt}`)) return; // não repete a mesma linha a cada tick
    log.unshift(`${new Date().toLocaleTimeString('pt-BR')} · ${txt}`);
    log.length = Math.min(log.length, 60);
    console.log('[Rota]', txt);
  }
  const fmt = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });

  // ---------------------------------------------------------------- envio com espera por passo
  const ultimoEnvio = {};
  let ultimoPedido = 0;
  function enviar(passo, msg) {
    if (Date.now() - (ultimoEnvio[passo] ?? 0) < ESPERA[passo]) return false;
    if (!core.send(msg)) return false;
    ultimoEnvio[passo] = ultimoPedido = Date.now();
    return true;
  }
  // Recusa do servidor logo depois de um pedido nosso vai para o registro (nível, porta da hunt…).
  const tirarErro = core.on((m) => {
    if (m.t === 'erro' && cfg.ativo && Date.now() - ultimoPedido < 3000) registrar(`servidor recusou: ${m.msg ?? m.chave ?? '?'}`);
    if (m.t === 'market' && m.aba === 'item' && m.itemId === PEDRA.itemId && m.moeda === 'gold') anuncios = { em: Date.now(), linhas: m.linhas ?? [] };
  });

  // ---------------------------------------------------------------- mercado
  let anuncios = null; // { em, linhas } — a última leitura dos anúncios da pedra
  function comprarPedras(e, falta) {
    if (!anuncios || Date.now() - anuncios.em > 30_000) {
      enviar('lerMercado', { t: 'market.item', itemId: PEDRA.itemId, moeda: 'gold' });
      return `lendo o Mercado (${PEDRA.nome})`;
    }
    const agora = e.servidorAgora ?? Date.now();
    const bons = anuncios.linhas
      .filter((a) => a.estado === 'aberto' && a.moeda === 'gold' && a.vendedorId !== e.id && (a.compravelEm ?? 0) <= agora && a.qtd > 0)
      .sort((a, b) => a.preco - b.preco);
    const a = bons[0];
    if (!a) return `nenhum anúncio de ${PEDRA.nome} disponível — tentando de novo`;
    if (a.preco > cfg.precoMax) return `${PEDRA.nome} mais barata a ${fmt(a.preco)} — acima do máximo de ${fmt(cfg.precoMax)}; esperando`;
    const qtd = Math.min(falta, a.qtd);
    if ((e.gold ?? 0) < a.preco * qtd) return `gold insuficiente para ${qtd}× ${PEDRA.nome} (${fmt(a.preco * qtd)})`;
    if (enviar('comprar', { t: 'market.comprar', id: a.id, qtd, preco: a.preco, moeda: 'gold' })) {
      registrar(`comprando ${qtd}× ${PEDRA.nome} a ${fmt(a.preco)} cada`);
      anuncios = null; // relê depois da compra
    }
    return `comprando ${PEDRA.nome}`;
  }

  // ---------------------------------------------------------------- o passo de cada tick
  function passo() {
    const e = core.eu;
    if (!core.logado || !e) return 'aguardando o jogo';
    const pk = e.pokemons?.find((p) => p.id === e.activeId);
    if (!pk) return 'sem pokémon ativo';
    const nv = pk.level;

    // 1) Evolução pendente: Centro → pedras → evoluir.
    const ev = EVOLUCOES.find((v) => v.de === pk.speciesId && nv >= v.nivel);
    if (ev) {
      if (!e.noCentro) {
        if (enviar('centro', { t: 'centro.ir' })) registrar(`${pk.nome} nv ${nv}: voltando ao Centro para evoluir`);
        return 'indo ao Centro Pokémon';
      }
      let precisa = 0;
      for (let s = pk.speciesId, v; (v = EVOLUCOES.find((x) => x.de === s)); s = v.para) precisa++;
      const tem = e.items?.[PEDRA.itemId] ?? 0;
      if (tem < precisa) return comprarPedras(e, precisa - tem);
      if (enviar('evoluir', { t: 'pokemon.evoluir', pokemonId: pk.id, alvoId: ev.para })) registrar(`evoluindo ${pk.nome} (nv ${nv})`);
      return `evoluindo ${pk.nome}`;
    }

    // 2) Hunt do nível.
    let alvo = ROTA_CHARIZARD ? null : [...HUNTS].reverse().find((h) => nv >= h.de)?.hunt;
    let aviso = '';
    if (ROTA_CHARIZARD) {
      // Por último, a hunt da tabela por nível (Geodude → Diglett → Larvitar → Pupitar): conta nova,
      // com o treinador abaixo do 150, não entra na Outland e ficava parada no Centro.
      const daTabela = [...HUNTS].reverse().find((h) => nv >= h.de && h.hunt !== 'brave_charizard')?.hunt;
      const spot = spotDeHoje();
      const opcoes = [...huntCharizard(nv).map((x) => (x === 'brave_charizard' && spot ? spot.slug : x)), ...(daTabela ? [daTabela] : [])];
      // As hunts de Orre não vêm na lista do `welcome`; o nível delas fica aqui (do map-markers.json do jogo).
      const NIVEL_FORA_DA_LISTA = {};
      const nivelHunt = (slug) => core.hunts?.find((x) => x.slug === slug)?.nivel ?? NIVEL_FORA_DA_LISTA[slug] ?? 0;
      const liberada = (slug) => (e.level ?? 0) >= nivelHunt(slug);
      alvo = opcoes.find(liberada) ?? opcoes.at(-1);
      if (alvo !== opcoes[0]) aviso = ` — ${opcoes[0]} libera com treinador nv ${nivelHunt(opcoes[0])} (está no ${e.level})`;
    }
    if (!alvo) return 'sem hunt para este nível';
    if (e.huntSlug !== alvo || e.noCentro) {
      const h = core.hunts?.find((x) => x.slug === alvo);
      if (h && (e.level ?? 0) < h.nivel) return `${h.nome} libera no nível ${h.nivel} de treinador (você está no ${e.level})`;
      if (enviar('hunt', { t: 'hunt.select', slug: alvo })) registrar(`${pk.nome} nv ${nv}: indo para ${h?.nome ?? alvo}`);
      return `indo para ${h?.nome ?? alvo}`;
    }
    const nome = core.hunts?.find((x) => x.slug === alvo)?.nome ?? alvo;
    const naOutland = (core.hunts?.find((x) => x.slug === alvo)?.area ?? (alvo === 'brave_charizard' ? 'outland' : '')) === 'outland';
    if (naOutland) {
      const tierAlvo = [...OUTLAND_POR_NIVEL].reverse().find((x) => nv >= x.nivel)?.tier ?? 1;
      const tierAtual = Number(e.outlandTier ?? 1);
      if (tierAlvo > tierAtual) {
        const precisa = NIVEL_TREINADOR_TIER[tierAlvo] ?? 0;
        if ((e.level ?? 0) < precisa) return `${pk.nome} nv ${nv} em ${nome} (Outland ${tierAtual}) — Outland ${tierAlvo} libera com treinador nv ${precisa} (está no ${e.level})${aviso}`;
        if (enviar('tier', { t: 'outland.tier', tier: tierAlvo })) registrar(`${pk.nome} nv ${nv}: passando para a Outland ${tierAlvo}`);
        return `passando para a Outland ${tierAlvo}`;
      }
      return `${pk.nome} nv ${nv} em ${nome} (Outland ${tierAtual})${aviso}`;
    }
    if (ROTA_CHARIZARD) return `${pk.nome} nv ${nv} em ${nome}`;
    if (nv >= NIVEL_FIM) return `rota concluída — ${pk.nome} nv ${nv}, segue em ${nome}`;
    return `${pk.nome} nv ${nv} em ${nome}`;
  }

  const vigia = setInterval(() => {
    if (!cfg.ativo) { status = 'desligada'; return; }
    try { status = passo(); } catch (err) { status = `erro: ${err.message}`; console.error('[Rota]', err); }
  }, TICK_MS);

  window.__pokeRota = {
    versao: VERSAO_ROTA,
    get ativo() { return cfg.ativo; },
    get status() { return status; },
    get log() { return log; },
    definirAtivo(v) {
      cfg.ativo = !!v;
      salvarCfg();
      registrar(cfg.ativo ? 'rota LIGADA' : 'rota desligada');
      status = cfg.ativo ? 'começando…' : 'desligada';
      return cfg.ativo;
    },
    /** A janela do app manda o spot do dia desta conta: { dia, slug, nome, xph }. */
    definirSpotDoDia(s) { spotDoDia = s && s.slug ? { dia: s.dia ?? hojeLocal(), slug: s.slug, nome: s.nome ?? s.slug, xph: s.xph ?? '' } : null; try { localStorage.setItem(CHAVE_SPOT, JSON.stringify(spotDoDia)); } catch {} registrar(spotDoDia ? `spot do dia: ${spotDoDia.nome}` : 'spot do dia removido'); return spotDoDia; },
    get spotDoDia() { return spotDeHoje(); },
    definirPrecoMax(n) { cfg.precoMax = Math.max(0, Number(n) || 0); salvarCfg(); return cfg.precoMax; },
    get precoMax() { return cfg.precoMax; },
    desmontar() { clearInterval(vigia); tirarErro(); },
  };
})();

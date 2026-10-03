// PokéIdle Bot — ANÁLISE DE TIME (PvP). Trocada a quente junto com a lógica.
//
// Responde "quero tirar este do time: quem entra no lugar?". A conta é a do próprio jogo:
// `shared/ginasios.mjs` traz os stats de combate, o golpe que a IA escolhe e o duelo 1×1 com a
// tabela de tipos — as mesmas funções que o servidor usa. Em cima disso este arquivo simula a
// luta de DESGASTE do PvP (um de cada vez; o próximo entra quando o anterior cai, e o dano
// fica) do seu time contra os times de outros jogadores, e mede quanto cada candidato melhora.
(() => {
  'use strict';
  const VERSAO_ANALISE = '1.1.0';

  const core = window.__pokebotCore;
  if (!core) return;
  const estavaAberto = !!document.getElementById('pa-fundo')?.classList.contains('aberto');
  window.__pokeAnalise?.desmontar?.();

  const limpezas = [];
  const A = {
    versao: VERSAO_ANALISE,
    desmontar() { for (const f of limpezas.splice(0)) { try { f(); } catch {} } },
    abrir: () => abrir(),
    fechar: () => fechar(),
  };
  window.__pokeAnalise = A;

  // ---------------------------------------------------------------- constantes
  const PVP_MAX = 5;
  const IV_PADRAO = 24;            // espécie hipotética: IV bom, não perfeito (escala 1–32)
  const TOP_ESPECIES = 150;        // pré-filtro por força individual antes da simulação completa
  const SUGESTOES = 8;
  const CHAVE_CFG = 'pokeanalise.v1';
  const ESPERA_PERFIL_MS = 700;    // entre pedidos de perfil, para não martelar o servidor

  // Tabela padrão (Gen 6+), só fora da diagonal — o mesmo formato do jogo. Vale até a conta
  // ser recarregada com o núcleo novo, que guarda a tabela oficial que chega no `welcome`.
  const TABELA_PADRAO = {
    NORMAL: { ROCK: 0.5, GHOST: 0, STEEL: 0.5 },
    FIRE: { WATER: 0.5, GRASS: 2, ICE: 2, BUG: 2, ROCK: 0.5, DRAGON: 0.5, STEEL: 2 },
    WATER: { FIRE: 2, GRASS: 0.5, GROUND: 2, ROCK: 2, DRAGON: 0.5 },
    GRASS: { FIRE: 0.5, WATER: 2, POISON: 0.5, GROUND: 2, FLYING: 0.5, BUG: 0.5, ROCK: 2, DRAGON: 0.5, STEEL: 0.5 },
    ELECTRIC: { WATER: 2, GRASS: 0.5, GROUND: 0, FLYING: 2, DRAGON: 0.5 },
    ICE: { FIRE: 0.5, WATER: 0.5, GRASS: 2, GROUND: 2, FLYING: 2, DRAGON: 2, STEEL: 0.5 },
    FIGHTING: { NORMAL: 2, ICE: 2, POISON: 0.5, FLYING: 0.5, PSYCHIC: 0.5, BUG: 0.5, ROCK: 2, GHOST: 0, DARK: 2, STEEL: 2, FAIRY: 0.5 },
    POISON: { GRASS: 2, GROUND: 0.5, ROCK: 0.5, GHOST: 0.5, STEEL: 0, FAIRY: 2 },
    GROUND: { FIRE: 2, ELECTRIC: 2, GRASS: 0.5, POISON: 2, FLYING: 0, BUG: 0.5, ROCK: 2, STEEL: 2 },
    FLYING: { ELECTRIC: 0.5, GRASS: 2, FIGHTING: 2, BUG: 2, ROCK: 0.5, STEEL: 0.5 },
    PSYCHIC: { FIGHTING: 2, POISON: 2, DARK: 0, STEEL: 0.5 },
    BUG: { FIRE: 0.5, GRASS: 2, FIGHTING: 0.5, POISON: 0.5, FLYING: 0.5, PSYCHIC: 2, GHOST: 0.5, DARK: 2, STEEL: 0.5, FAIRY: 0.5 },
    ROCK: { FIRE: 2, ICE: 2, FIGHTING: 0.5, GROUND: 0.5, FLYING: 2, BUG: 2, STEEL: 0.5 },
    GHOST: { NORMAL: 0, PSYCHIC: 2, DARK: 0.5 },
    DRAGON: { STEEL: 0.5, FAIRY: 0 },
    DARK: { FIGHTING: 0.5, PSYCHIC: 2, GHOST: 2, FAIRY: 0.5 },
    STEEL: { FIRE: 0.5, WATER: 0.5, ELECTRIC: 0.5, ICE: 2, ROCK: 2, FAIRY: 2 },
    FAIRY: { FIRE: 0.5, FIGHTING: 2, POISON: 0.5, DRAGON: 2, DARK: 2, STEEL: 0.5 },
  };
  const TIPOS = Object.keys(TABELA_PADRAO);
  const NOME_TIPO = {
    NORMAL: 'Normal', FIRE: 'Fogo', WATER: 'Água', GRASS: 'Planta', ELECTRIC: 'Elétrico', ICE: 'Gelo',
    FIGHTING: 'Lutador', POISON: 'Veneno', GROUND: 'Terra', FLYING: 'Voador', PSYCHIC: 'Psíquico', BUG: 'Inseto',
    ROCK: 'Pedra', GHOST: 'Fantasma', DRAGON: 'Dragão', DARK: 'Sombrio', STEEL: 'Aço', FAIRY: 'Fada',
  };
  const COR_TIPO = {
    NORMAL: '#9fa19f', FIRE: '#e62829', WATER: '#2980ef', GRASS: '#3fa129', ELECTRIC: '#fac000', ICE: '#3dcef3',
    FIGHTING: '#ff8000', POISON: '#9141cb', GROUND: '#915121', FLYING: '#81b9ef', PSYCHIC: '#ef4179', BUG: '#91a119',
    ROCK: '#afa981', GHOST: '#704170', DRAGON: '#5060e1', DARK: '#624d4e', STEEL: '#60a1b8', FAIRY: '#ef70ef',
  };

  // ---------------------------------------------------------------- estado
  function lerCfg() {
    try { return { nicks: [], fonte: 'pvp', ...JSON.parse(localStorage.getItem(CHAVE_CFG)) }; }
    catch { return { nicks: [], fonte: 'pvp' }; }
  }
  const cfg = lerCfg();
  const salvarCfg = () => { try { localStorage.setItem(CHAVE_CFG, JSON.stringify(cfg)); } catch {} };

  const st = (window.__pokeAnaliseDados ??= {
    mod: null, catalogo: null, pvpIds: null, ladder: [], oponentes: new Map(),
  });
  let tirarId = null;
  let aba = 'bolsa';
  let resultado = null;     // { tirar, base, listas: { bolsa, outros, especies } }
  let ocupado = false;
  let rodada = 0;           // cancela uma análise velha quando outra começa
  let msg = '';

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = (n) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
  const pct = (x) => `${Math.round(x * 100)}%`;
  const tentar = (f) => { try { return f(); } catch (e) { console.warn('[Análise]', e); } };
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------------------------------------------------------- módulos e catálogo
  async function carregarModulos() {
    if (st.mod) return st.mod;
    const imp = (p) => import(`${location.origin}/shared/${p}.mjs`);
    const [gin, efe, out, plan, hbo, orre, esp, megas] = await Promise.all([
      imp('ginasios'), imp('tipo-efetividade'), imp('outland'), imp('golpes-planilhas'),
      imp('herdar-base-outland'), imp('herdar-golpes-orre'), imp('golpes-especiais'), imp('megas'),
    ]);
    st.mod = { gin, efe, out, plan, hbo, orre, esp, megas };
    return st.mod;
  }

  /** O catálogo de espécies com os stats e golpes que o jogo usa — os passos de `carregarCatalogoEspecies` que mexem nisso. */
  async function carregarCatalogo() {
    if (st.catalogo) return st.catalogo;
    const m = st.mod;
    const j = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [cr, novos, outl, ovr] = await Promise.all([
      j('/assets/creatures.json'), j('/assets/creatures-novos.json'),
      j('/assets/creatures-outland-novos.json'), j('/assets/creatures-audit-overrides.json'),
    ]);
    const lista = [...(cr?.creatures ?? []), ...(novos?.creatures ?? []), ...(outl?.creatures ?? [])];
    tentar(() => m.out.aplicarRemapOutlandLista(lista));
    for (const o of ovr?.overrides ?? []) {
      const c = lista.find((x) => x.pokeId === o.pokeId);
      if (!c) continue;
      for (const k of ['baseHp', 'baseAtk', 'baseDef', 'baseSpAtk', 'baseSpDef', 'baseSpeed']) {
        if (typeof o[k] === 'number') c[k] = o[k];
      }
      if (Array.isArray(o.attacks)) c.attacks = o.attacks.map((a) => ({ ...a }));
    }
    tentar(() => m.plan.aplicarGolpesDasPlanilhas((id) => lista.filter((c) => c.pokeId === id)));
    tentar(() => m.hbo.herdarBaseOutland(lista));
    for (const c of lista) tentar(() => m.esp.injetarGolpesEspeciais(c));
    tentar(() => m.orre.herdarGolpesOrre(lista));
    tentar(() => { for (const e of m.megas.criarEspeciesMega(lista)) lista.push(e); });
    st.catalogo = new Map(lista.map((c) => [c.pokeId, c]));
    return st.catalogo;
  }

  const tabela = () => (core.tabelaTipos && Object.keys(core.tabelaTipos).length ? core.tabelaTipos : TABELA_PADRAO);
  const tabelaOficial = () => tabela() !== TABELA_PADRAO;
  const efet = (atq, esp) => st.mod.efe.efetividade(atq, esp.type1, esp.type2, tabela());
  const tiposDe = (esp) => [esp?.type1, esp?.type2].filter(Boolean);

  // ---------------------------------------------------------------- pokémon
  let seqChave = 0;
  const ivsIguais = (v) => ({ hp: v, atk: v, def: v, spAtk: v, spDef: v, speed: v });

  /** Deixa qualquer pokémon (meu, de perfil alheio ou hipotético) no formato que `ginasios.mjs` lê. */
  function normalizar(pk, origem) {
    const speciesId = Number(pk.speciesId ?? pk.pokemonId ?? pk.especieId ?? 0);
    const esp = st.catalogo.get(speciesId);
    if (!esp) return null;
    return {
      ...pk,
      speciesId,
      level: Number(pk.level ?? pk.nivel ?? 1),
      ivs: pk.ivs ?? ivsIguais(IV_PADRAO),
      ivsEstimados: !pk.ivs,
      quality: Number(pk.quality ?? pk.qualidade ?? 1) || 1,
      potencia: Number(pk.potencia ?? 1) || 1,
      _k: ++seqChave,
      _esp: esp,
      _origem: origem,
    };
  }
  const nomeDe = (p) => `${p.shiny ? '✨' : ''}${p.nick || p._esp.name}`;
  const forca = (p) => tentar(() => st.mod.gin.ratingDeCombate(p, p._esp)) ?? 0;
  const poder = (p) => Math.max(1, Math.round(forca(p) / st.mod.gin.GINASIO_ESCALA_FORCA));

  function meusPokemons() {
    return (core.eu?.pokemons ?? []).map((pk) => normalizar(pk, 'bolsa')).filter(Boolean);
  }

  function meuTime(todos) {
    const porId = new Map(todos.map((p) => [p.id, p]));
    if (cfg.fonte === 'pvp' && st.pvpIds?.length) {
      const t = st.pvpIds.map((id) => porId.get(id)).filter(Boolean);
      if (t.length) return t;
    }
    return todos.filter((p) => p.slot != null).sort((a, b) => a.slot - b.slot).slice(0, PVP_MAX);
  }

  // ---------------------------------------------------------------- servidor (somente leitura)
  function pedir(msgEnvio, tipoResp, aceitar = () => true, ms = 7000) {
    return new Promise((ok, falha) => {
      const ws = core.ws;
      if (!ws || ws.readyState !== 1) return falha(new Error('conta desconectada'));
      const t = setTimeout(() => { ws.removeEventListener('message', f); falha(new Error('sem resposta do servidor')); }, ms);
      function f(ev) {
        if (typeof ev.data !== 'string' || !ev.data.includes(`"${tipoResp}"`)) return;
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.t !== tipoResp || !aceitar(m)) return;
        clearTimeout(t);
        ws.removeEventListener('message', f);
        ok(m);
      }
      ws.addEventListener('message', f);
      core.send(msgEnvio);
    });
  }

  async function carregarPvp() {
    try {
      const m = await pedir({ t: 'pvp.info' }, 'pvp', (x) => x.time !== undefined || x.ladder !== undefined);
      if (m.time !== undefined) st.pvpIds = (m.time ?? []).map((x) => (typeof x === 'object' ? x?.id : x)).filter((x) => x != null);
      if (m.ladder !== undefined) st.ladder = m.ladder ?? [];
    } catch (e) { console.warn('[Análise] pvp.info', e.message); }
  }

  /** O time de PvP de outro jogador. O jogo abre a ficha dele quando a resposta chega — fechamos. */
  async function carregarOponente(nick) {
    const alvo = nick.trim().toLowerCase();
    const m = await pedir({ t: 'ranking.perfil', nick: nick.trim() }, 'perfil', (x) => String(x.perfil?.nick ?? '').toLowerCase() === alvo);
    setTimeout(() => document.getElementById('perfil')?.classList.add('hidden'), 0);
    const p = m.perfil;
    const time = (p.pvpTime ?? []).map((pk) => normalizar(pk, `de ${p.nick}`)).filter(Boolean);
    st.oponentes.set(p.nick.toLowerCase(), { nick: p.nick, time });
    return st.oponentes.get(p.nick.toLowerCase());
  }

  // ---------------------------------------------------------------- simulação
  const cachePar = new Map();
  /** Duelo de A contra B pelas contas do jogo: dps de cada um contra o outro e o HP de combate. */
  function par(a, b) {
    const k = `${a._k}|${b._k}`;
    let r = cachePar.get(k);
    if (r === undefined) {
      const c = tentar(() => st.mod.gin.compararDuelo1v1(a, a._esp, b, b._esp, { amostras: 1, tabelaTipos: tabela() }));
      r = c ? { dpsA: c.a.dps, ehpA: c.a.ehp, dpsB: c.b.dps, ehpB: c.b.ehp, golpeA: c.a.golpe, efA: c.a.ef, golpeB: c.b.golpe, efB: c.b.ef } : null;
      cachePar.set(k, r);
    }
    return r;
  }

  /**
   * Luta de desgaste time × time: entram os primeiros de cada lado; quem demora menos para
   * derrubar o outro vence e segue com o HP que sobrou contra o próximo.
   * `margem` vai de −1 (perdeu sem tirar nada) a +1 (venceu sem perder nada).
   */
  function lutar(T, O, log = null) {
    let i = 0, j = 0, fa = 1, fb = 1; // fração de HP de quem está em campo
    let passos = 0;
    while (i < T.length && j < O.length && passos++ < 64) {
      const p = par(T[i], O[j]);
      if (!p) { i++; j++; fa = 1; fb = 1; continue; }
      const tA = p.dpsA > 0 ? (fb * p.ehpB) / p.dpsA : Infinity; // tempo para A derrubar B
      const tB = p.dpsB > 0 ? (fa * p.ehpA) / p.dpsB : Infinity;
      if (tA === Infinity && tB === Infinity) { if (fa >= fb) { j++; fb = 1; } else { i++; fa = 1; } continue; }
      if (tA <= tB) {
        fa -= (p.dpsB * tA) / p.ehpA;
        log?.push({ eu: T[i], ele: O[j], venceu: 'eu', sobra: Math.max(0, fa), golpe: p.golpeA, ef: p.efA });
        j++; fb = 1;
      } else {
        fb -= (p.dpsA * tB) / p.ehpB;
        log?.push({ eu: T[i], ele: O[j], venceu: 'ele', sobra: Math.max(0, fb), golpe: p.golpeB, ef: p.efB });
        i++; fa = 1;
      }
    }
    const sobraA = i < T.length ? (T.length - i - 1 + Math.max(0, fa)) / T.length : 0;
    const sobraB = j < O.length ? (O.length - j - 1 + Math.max(0, fb)) / O.length : 0;
    return { venceu: j >= O.length && i < T.length, margem: sobraA - sobraB };
  }

  function avaliar(T, rivais) {
    let soma = 0, vitorias = 0;
    for (const r of rivais) {
      const x = lutar(T, r.time);
      soma += x.margem;
      if (x.venceu) vitorias++;
    }
    return { margem: rivais.length ? soma / rivais.length : 0, vitorias };
  }

  /** Quantos do time levam mais que ×1 de cada tipo de ataque, e quantos resistem. */
  function fraquezas(T) {
    const r = {};
    for (const tipo of TIPOS) {
      let fracos = 0, resistem = 0;
      for (const p of T) {
        const e = efet(tipo, p._esp);
        if (e > 1) fracos++;
        else if (e < 1) resistem++;
      }
      r[tipo] = { fracos, resistem };
    }
    return r;
  }

  /** Tipos dos golpes que os rivais usariam contra o seu time, pesados por quantas vezes aparecem. */
  function ameacas(T, rivais) {
    const conta = {};
    for (const r of rivais) for (const b of r.time) for (const a of T) {
      const g = par(a, b)?.golpeB;
      if (g?.type) conta[g.type] = (conta[g.type] ?? 0) + 1;
    }
    return conta;
  }

  function motivos(cand, base, novo, fraqAntes, fraqDepois, perigo, rivais) {
    const m = [];
    m.push(`vence ${novo.vitorias}/${rivais.length} times (antes ${base.vitorias})`);
    const topo = Object.entries(perigo).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
    for (const t of topo) {
      const a = fraqAntes[t], d = fraqDepois[t];
      if (d.fracos < a.fracos) m.push(`menos fraco a ${NOME_TIPO[t] ?? t} (${a.fracos}→${d.fracos})`);
      else if (d.fracos > a.fracos) m.push(`⚠ mais fraco a ${NOME_TIPO[t] ?? t} (${a.fracos}→${d.fracos})`);
    }
    let supers = 0, total = 0;
    for (const r of rivais) for (const b of r.time) { const p = par(cand, b); if (p) { total++; if (p.efA > 1) supers++; } }
    if (total && supers) m.push(`super efetivo contra ${supers}/${total} rivais`);
    if (cand.ivsEstimados) m.push('IVs estimados');
    return m.slice(0, 4);
  }

  // ---------------------------------------------------------------- melhor ordem contra um rival
  function permutacoes(lista) {
    if (lista.length <= 1) return [lista.slice()];
    const out = [];
    lista.forEach((x, i) => { for (const p of permutacoes([...lista.slice(0, i), ...lista.slice(i + 1)])) out.push([x, ...p]); });
    return out;
  }
  const especiePorNome = (nome) => [...st.catalogo.values()].find((e) => e.name?.toLowerCase() === String(nome).toLowerCase());

  /** Acha cada pokémon de `nomes` em `pool` (por nome, nível mais próximo), sem repetir. */
  function casar(nomesNiveis, pool, chaveNome) {
    const livres = [...pool];
    return nomesNiveis.map((x) => {
      const cand = livres.filter((p) => chaveNome(p).toLowerCase() === String(x.nome).toLowerCase());
      if (!cand.length) return null;
      cand.sort((a, b) => Math.abs((a.level ?? 0) - (x.nivel ?? 0)) - Math.abs((b.level ?? 0) - (x.nivel ?? 0)));
      livres.splice(livres.indexOf(cand[0]), 1);
      return cand[0];
    });
  }

  /**
   * Testa as ordens possíveis do SEU time contra a ordem do rival e devolve as melhores.
   * `meus`: [{ id?, nome, nivel }] (a sua equipe daquele duelo). `ordemRival`: os que entraram,
   * na ordem; `restoRival`: quem não entrou (posição desconhecida — testa todas as combinações).
   * Os stats do rival vêm do perfil dele agora (`ranking.perfil`); quem não estiver mais na equipe
   * dele entra como estimativa (espécie no nível do duelo, IV médio).
   */
  function combinacoes(lista, k) {
    if (k === 0) return [[]];
    if (lista.length < k) return [];
    const [x, ...resto] = lista;
    return [...combinacoes(resto, k - 1).map((c) => [x, ...c]), ...combinacoes(resto, k)];
  }

  async function sugerirOrdem({ meus = [], rivalNick, ordemRival = [], restoRival = [], buscarNaBolsa = false }) {
    await carregarModulos();
    await carregarCatalogo();
    const avisos = [];
    const bolsa = meusPokemons();
    const porId = new Map(bolsa.map((p) => [p.id, p]));
    let meusPk = meus.map((m) => (m.id != null ? porId.get(m.id) : null));
    const semId = meus.map((m, i) => (meusPk[i] ? null : m));
    const casados = casar(semId.filter(Boolean), bolsa.filter((p) => !meusPk.includes(p)), (p) => p._esp.name);
    let k = 0;
    meusPk = meusPk.map((p, i) => p ?? (semId[i] ? casados[k++] : null));
    meusPk = meusPk.map((p, i) => p ?? (() => {
      const esp = especiePorNome(meus[i].nome);
      if (!esp) return null;
      avisos.push(`${meus[i].nome} não está mais na sua bolsa — usei uma estimativa`);
      return hipotetico(esp, meus[i].nivel || 150);
    })()).filter(Boolean);
    if (meusPk.length < 2 && !buscarNaBolsa) throw new Error('não achei os seus pokémon desse duelo na bolsa');

    let timeRival = [];
    try { timeRival = (await carregarOponente(rivalNick)).time; }
    catch (e) { avisos.push(`não consegui o perfil de ${rivalNick} (${e.message}) — usei estimativas`); }
    const estimar = (x) => {
      const esp = especiePorNome(x.nome);
      if (!esp) return null;
      avisos.push(`${x.nome} do rival: estimado (não está mais na equipe dele)`);
      return hipotetico(esp, x.nivel || 150);
    };
    const fixos = casar(ordemRival, timeRival, (p) => p._esp.name).map((p, i) => p ?? estimar(ordemRival[i])).filter(Boolean);
    const sobra = timeRival.filter((p) => !fixos.includes(p));
    let resto = restoRival.length
      ? casar(restoRival, sobra, (p) => p._esp.name).map((p, i) => p ?? estimar(restoRival[i])).filter(Boolean)
      : sobra.slice(0, Math.max(0, 5 - fixos.length));
    if (fixos.length + resto.length < 5 && resto.length < sobra.length) resto = sobra.slice(0, 5 - fixos.length);
    const ordensRival = permutacoes(resto).map((r) => [...fixos, ...r]);

    const avaliarOrdem = (ordem) => {
      let vit = 0, soma = 0, pior = Infinity;
      for (const O of ordensRival) {
        const x = lutar(ordem, O);
        if (x.venceu) vit++;
        soma += x.margem;
        pior = Math.min(pior, x.margem);
      }
      return { vitorias: vit, total: ordensRival.length, media: soma / ordensRival.length, pior };
    };
    const melhorPrimeiro = (a, b) => b.vitorias - a.vitorias || b.pior - a.pior || b.media - a.media;
    if (!ordensRival.length || !ordensRival[0].length) throw new Error(`não achei o time de PvP de ${rivalNick}`);
    const ranking = meusPk.length >= 2 ? permutacoes(meusPk).map((ordem) => ({ ordem, ...avaliarOrdem(ordem) })).sort(melhorPrimeiro) : [];
    const nomeDe = (p) => p._esp.name;

    // Melhor comp da BOLSA: combinações de 5 entre os seus mais fortes (mais quem já está no time),
    // cada uma na melhor ordem. Para caber no tempo, a triagem usa uma amostra dos cenários do
    // rival; as finalistas são conferidas contra todos.
    let comps = [];
    if (buscarNaBolsa) {
      const fortes = bolsa.map((p) => [p, forca(p)]).sort((a, b) => b[1] - a[1]).map(([p]) => p);
      const pool = [...new Set([...meusPk, ...fortes])].slice(0, Math.max(8, meusPk.length));
      const passo = Math.max(1, Math.floor(ordensRival.length / 24));
      const amostra = ordensRival.filter((_, i) => i % passo === 0).slice(0, 24);
      const avaliarEm = (ordem, cenarios) => {
        let vit = 0, soma = 0, pior = Infinity;
        for (const O of cenarios) { const x = lutar(ordem, O); if (x.venceu) vit++; soma += x.margem; pior = Math.min(pior, x.margem); }
        return { vitorias: vit, total: cenarios.length, media: soma / cenarios.length, pior };
      };
      const triagem = [];
      let n = 0;
      for (const combo of combinacoes(pool, Math.min(5, pool.length))) {
        if (new Set(combo.map((p) => p.speciesId)).size < combo.length) continue; // sem espécie repetida
        let melhor = null;
        for (const ordem of permutacoes(combo)) {
          const r = { ordem, ...avaliarEm(ordem, amostra) };
          if (!melhor || melhorPrimeiro(r, melhor) < 0) melhor = r;
        }
        triagem.push(melhor);
        if (++n % 4 === 0) await dormir(0);
      }
      comps = triagem.sort(melhorPrimeiro).slice(0, 6)
        .map((r) => ({ ordem: r.ordem, ...avaliarOrdem(r.ordem) })).sort(melhorPrimeiro).slice(0, 3);
    }
    const resumo = (r) => {
      const log = [];
      lutar(r.ordem, ordensRival[0], log);
      return {
        // `id` só existe para pokémon seus de verdade (estimativas não têm): é o que permite aplicar.
        ordem: r.ordem.map((p) => ({ id: p._origem === 'bolsa' ? p.id : null, nome: nomeDe(p), nivel: p.level })),
        vitorias: r.vitorias, total: r.total, media: r.media, pior: r.pior,
        passos: log.map((s) => ({ eu: nomeDe(s.eu), ele: nomeDe(s.ele), venceu: s.venceu, sobra: s.sobra, golpe: s.golpe?.name ?? '', ef: s.ef })),
      };
    };
    const usada = meusPk.length >= 2 ? { ordem: meusPk, ...avaliarOrdem(meusPk) } : null;
    return {
      usada: usada ? resumo(usada) : null,
      melhores: ranking.slice(0, 3).map(resumo),
      comps: comps.map(resumo),
      rival: ordensRival[0].map((p) => ({ nome: nomeDe(p), nivel: p.level })),
      fixos: fixos.length,
      cenarios: ordensRival.length,
      avisos,
      tabelaOficial: tabelaOficial(),
    };
  }
  A.sugerirOrdem = sugerirOrdem;

  function hipotetico(esp, nivel) {
    return normalizar({ speciesId: esp.pokeId, level: nivel, ivs: ivsIguais(IV_PADRAO), quality: 1, potencia: 1, shiny: false }, 'espécie');
  }

  async function analisar() {
    const minha = ++rodada;
    const todos = meusPokemons();
    const time = meuTime(todos);
    const tirar = time.find((p) => p.id === tirarId);
    const rivais = [...st.oponentes.values()].filter((r) => r.time.length);
    if (!tirar || !rivais.length) { resultado = null; pintar(); return; }

    ocupado = true;
    msg = 'Simulando…';
    pintar();
    const posicao = time.indexOf(tirar);
    const resto = time.filter((p) => p !== tirar);
    const especiesNoTime = new Set(resto.map((p) => p.speciesId));
    const base = avaliar(time, rivais);
    const fraqAntes = fraquezas(time);
    const perigo = ameacas(time, rivais);
    const comCand = (c) => { const t = [...resto]; t.splice(posicao, 0, c); return t; };

    const fontes = {
      bolsa: todos.filter((p) => !time.includes(p)),
      outros: rivais.flatMap((r) => r.time),
      especies: [...st.catalogo.values()]
        .filter((e) => e.attacks?.length && e.baseHp)
        .map((e) => hipotetico(e, tirar.level))
        .filter(Boolean)
        .map((p) => [p, forca(p)])
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_ESPECIES)
        .map(([p]) => p),
    };

    const listas = {};
    let feitos = 0;
    for (const [nome, cands] of Object.entries(fontes)) {
      const avaliados = [];
      for (const c of cands) {
        if (minha !== rodada) return; // outra análise começou
        if (especiesNoTime.has(c.speciesId)) continue;
        const t = comCand(c);
        const novo = avaliar(t, rivais);
        avaliados.push({ c, novo, delta: novo.margem - base.margem, t });
        if (++feitos % 30 === 0) await dormir(0);
      }
      avaliados.sort((a, b) => b.novo.vitorias - a.novo.vitorias || b.delta - a.delta);
      listas[nome] = avaliados.slice(0, SUGESTOES).map((x) => ({
        ...x,
        motivos: motivos(x.c, base, x.novo, fraqAntes, fraquezas(x.t), perigo, rivais),
      }));
    }
    resultado = { tirar, base, listas, fraqAntes, rivais: rivais.length };
    ocupado = false;
    msg = '';
    pintar();
  }

  // ---------------------------------------------------------------- UI
  const CSS = `
  #pa-fundo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
  #pa-fundo.aberto{display:flex}
  #pa-modal{width:min(900px,96vw);max-height:92vh;overflow:auto;background:#3a2020;color:#f6e7d4;border:3px solid #e2915a;
    border-radius:14px;font:13px system-ui;box-shadow:0 10px 40px rgba(0,0,0,.6)}
  #pa-modal header{position:sticky;top:0;z-index:1;display:flex;justify-content:space-between;align-items:center;padding:10px 14px;
    background:#c9754a;color:#2a1212;font-weight:800;letter-spacing:.5px}
  #pa-modal header small{font-weight:600;opacity:.75;margin-left:8px}
  #pa-modal header button{background:#b04ad0;border:2px solid #f3c77a;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-weight:800}
  #pa-modal section{padding:10px 14px;border-bottom:1px solid #5a3232}
  #pa-modal h4{margin:0 0 8px;font-size:12px;letter-spacing:.6px;text-transform:uppercase;color:#f3c77a;display:flex;gap:8px;align-items:center}
  #pa-modal h4 .pa-dica{text-transform:none;letter-spacing:0;color:#f6e7d4;opacity:.65;font-weight:400}
  .pa-linha{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .pa-pk{background:#2a1515;border:2px solid #5a3232;border-radius:10px;padding:6px 8px;min-width:150px;cursor:pointer;text-align:left;color:inherit;font:inherit}
  .pa-pk:hover{border-color:#8a5a4a}.pa-pk.sel{border-color:#ff6b6b;background:#3a1515}
  .pa-pk b,.pa-card b{display:block}.pa-pk small,.pa-card small{opacity:.75}
  .pa-tipo{display:inline-block;border-radius:4px;padding:0 5px;margin:2px 2px 0 0;font-size:10px;font-weight:700;color:#fff;text-shadow:0 1px 1px rgba(0,0,0,.5)}
  .pa-bt{background:#5a3232;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 9px;cursor:pointer;font:inherit}
  .pa-bt:hover{background:#6e3d3d}.pa-bt.on{background:#b04ad0;border-color:#f3c77a;color:#fff}
  .pa-bt:disabled{opacity:.5;cursor:default}
  .pa-in{background:#2a1515;border:1px solid #8a5a4a;color:#f6e7d4;border-radius:6px;padding:4px 8px;font:inherit;width:170px}
  .pa-chip{background:#2a1515;border:1px solid #8a5a4a;border-radius:14px;padding:2px 4px 2px 10px;display:inline-flex;gap:6px;align-items:center}
  .pa-chip button{background:none;border:none;color:#f6e7d4;cursor:pointer;font-weight:800;opacity:.7}
  .pa-fraq{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:4px}
  .pa-fraq div{background:#2a1515;border-radius:6px;padding:3px 6px;font-size:11px;display:flex;justify-content:space-between;align-items:center}
  .pa-fraq .ruim{outline:1px solid #ff6b6b}
  .pa-sug{display:grid;gap:6px}
  .pa-card{display:grid;grid-template-columns:200px 1fr 110px;gap:10px;align-items:center;background:#2a1515;border-radius:10px;padding:8px 10px}
  .pa-card ul{margin:0;padding-left:16px;font-size:12px}
  .pa-card .pa-num{text-align:right;font-weight:800;font-size:15px}
  .pa-card .pa-num small{display:block;font-weight:400;font-size:11px;opacity:.75}
  .pa-pos{color:#7fdc8f}.pa-neg{color:#ff8a8a}
  .pa-msg{opacity:.8;font-style:italic}
  @media (max-width:640px){.pa-card{grid-template-columns:1fr}.pa-card .pa-num{text-align:left}}`;

  const tiposHtml = (esp) => tiposDe(esp).map((t) => `<span class="pa-tipo" style="background:${COR_TIPO[t] ?? '#777'}">${esc(NOME_TIPO[t] ?? t)}</span>`).join('');
  const pkHtml = (p, extra = '') => `<b>${esc(nomeDe(p))}</b><small>Nv ${fmt(p.level)} · ⚔ ${fmt(poder(p))}${extra}</small><div>${tiposHtml(p._esp)}</div>`;

  function montarUI() {
    const css = document.createElement('style');
    css.id = 'pa-css';
    css.textContent = CSS;
    document.head.appendChild(css);
    const fundo = document.createElement('div');
    fundo.id = 'pa-fundo';
    fundo.innerHTML = '<div id="pa-modal"></div>';
    document.body.appendChild(fundo);
    fundo.addEventListener('click', aoClicar);
    fundo.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'pa-nick') adicionarNick(); });
    limpezas.push(() => { css.remove(); fundo.remove(); });
    const aoEsc = (e) => { if (e.key === 'Escape' && fundo.classList.contains('aberto')) fechar(); };
    document.addEventListener('keydown', aoEsc);
    limpezas.push(() => document.removeEventListener('keydown', aoEsc));
  }

  function pintar() {
    const modal = document.getElementById('pa-modal');
    if (!modal || !document.getElementById('pa-fundo').classList.contains('aberto')) return;
    if (!st.mod || !st.catalogo) {
      modal.innerHTML = `<header>📊 Análise de time <button data-a="fechar">×</button></header><section class="pa-msg">${esc(msg || 'Carregando…')}</section>`;
      return;
    }
    const todos = meusPokemons();
    const time = meuTime(todos);
    const rivais = [...st.oponentes.values()];
    const fraq = fraquezas(time);
    const nomeTirar = time.find((p) => p.id === tirarId);

    const sTime = `
      <section>
        <h4>Seu time
          <button class="pa-bt ${cfg.fonte === 'pvp' ? 'on' : ''}" data-a="fonte" data-v="pvp" ${st.pvpIds?.length ? '' : 'disabled title="Sem equipe de PvP salva"'}>Equipe PvP</button>
          <button class="pa-bt ${cfg.fonte === 'equipe' ? 'on' : ''}" data-a="fonte" data-v="equipe">Equipe atual</button>
          <span class="pa-dica">clique em quem você quer tirar</span></h4>
        <div class="pa-linha">${time.map((p) => `<button class="pa-pk ${p.id === tirarId ? 'sel' : ''}" data-a="tirar" data-id="${p.id}">${pkHtml(p)}</button>`).join('') || '<span class="pa-msg">Nenhum pokémon no time.</span>'}</div>
      </section>`;

    const ruins = TIPOS.filter((t) => fraq[t].fracos >= 2 && fraq[t].fracos > fraq[t].resistem);
    const sFraq = `
      <section>
        <h4>Fraquezas do time <span class="pa-dica">fracos / resistem a cada tipo de ataque${tabelaOficial() ? '' : ' · tabela padrão (recarregue a conta no Centro para usar a do jogo)'}</span></h4>
        <div class="pa-fraq">${TIPOS.map((t) => `<div class="${ruins.includes(t) ? 'ruim' : ''}"><span class="pa-tipo" style="background:${COR_TIPO[t]}">${NOME_TIPO[t]}</span><span>${fraq[t].fracos} / ${fraq[t].resistem}</span></div>`).join('')}</div>
      </section>`;

    const sRivais = `
      <section>
        <h4>Times rivais <span class="pa-dica">a análise mede seu time contra estes (equipe de PvP de cada jogador)</span></h4>
        <div class="pa-linha" style="margin-bottom:6px">
          ${rivais.map((r) => `<span class="pa-chip">${esc(r.nick)} <small>(${r.time.length})</small><button data-a="remover" data-nick="${esc(r.nick)}" title="Remover">×</button></span>`).join('') || '<span class="pa-msg">Nenhum rival carregado.</span>'}
        </div>
        <div class="pa-linha">
          <input id="pa-nick" class="pa-in" placeholder="nick do jogador" spellcheck="false">
          <button class="pa-bt" data-a="add" ${ocupado ? 'disabled' : ''}>Adicionar</button>
          <button class="pa-bt" data-a="top" ${ocupado || !st.ladder.length ? 'disabled' : ''}>Top 10 do PvP</button>
          ${rivais.length ? '<button class="pa-bt" data-a="limpar">Limpar</button>' : ''}
        </div>
      </section>`;

    let sSug = '';
    if (!nomeTirar) sSug = '<section class="pa-msg">Escolha no seu time quem você quer tirar.</section>';
    else if (!rivais.some((r) => r.time.length)) sSug = '<section class="pa-msg">Adicione pelo menos um time rival para comparar.</section>';
    else if (ocupado || !resultado) sSug = `<section class="pa-msg">${esc(msg || 'Simulando…')}</section>`;
    else {
      const l = resultado.listas[aba] ?? [];
      const titulo = { bolsa: 'Da sua bolsa', outros: 'Dos times rivais', especies: 'Qualquer espécie' };
      const dica = {
        bolsa: 'pokémon que você já tem — dá para trocar agora',
        outros: 'pokémon que estão nos times rivais, com os stats deles',
        especies: `espécie no Nv ${fmt(resultado.tirar.level)} com IV ${IV_PADRAO}/32 e sem TM — meta de captura`,
      };
      sSug = `
        <section>
          <h4>No lugar de ${esc(nomeDe(resultado.tirar))}
            <span class="pa-dica">hoje o time vence ${resultado.base.vitorias}/${resultado.rivais} · margem ${resultado.base.margem >= 0 ? '+' : ''}${pct(resultado.base.margem)}</span></h4>
          <div class="pa-linha" style="margin-bottom:8px">
            ${Object.keys(titulo).map((k) => `<button class="pa-bt ${aba === k ? 'on' : ''}" data-a="aba" data-v="${k}">${titulo[k]}</button>`).join('')}
            <span class="pa-dica" style="opacity:.65">${esc(dica[aba])}</span>
          </div>
          <div class="pa-sug">${l.map((x) => `
            <div class="pa-card">
              <div>${pkHtml(x.c, x.c._origem !== 'bolsa' && x.c._origem !== 'espécie' ? ` · ${esc(x.c._origem)}` : '')}</div>
              <ul>${x.motivos.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
              <div class="pa-num ${x.delta >= 0 ? 'pa-pos' : 'pa-neg'}">${x.delta >= 0 ? '+' : ''}${pct(x.delta)}<small>${x.novo.vitorias}/${resultado.rivais} vitórias</small></div>
            </div>`).join('') || '<span class="pa-msg">Nenhum candidato nesta lista.</span>'}</div>
        </section>`;
    }

    modal.innerHTML = `
      <header><span>📊 Análise de time — PvP<small>v${VERSAO_ANALISE}</small></span><button data-a="fechar" title="Fechar">×</button></header>
      ${sTime}${sRivais}${sSug}${sFraq}`;
  }

  async function adicionarNick(nick) {
    const campo = document.getElementById('pa-nick');
    const alvo = (nick ?? campo?.value ?? '').trim();
    if (!alvo) return;
    ocupado = true; msg = `Buscando o time de ${alvo}…`; pintar();
    try {
      const r = await carregarOponente(alvo);
      if (!cfg.nicks.some((n) => n.toLowerCase() === r.nick.toLowerCase())) { cfg.nicks.push(r.nick); salvarCfg(); }
      if (!r.time.length) msg = `${r.nick} não tem equipe de PvP salva.`;
    } catch (e) { msg = `Não deu para carregar ${alvo}: ${e.message}`; }
    ocupado = false;
    pintar();
    analisar();
  }

  async function carregarTop() {
    const nicks = st.ladder.map((l) => l.nick ?? l.nome).filter(Boolean)
      .filter((n) => n.toLowerCase() !== String(core.eu?.nick ?? '').toLowerCase()).slice(0, 10);
    ocupado = true;
    for (const [i, n] of nicks.entries()) {
      msg = `Buscando times do top do PvP… ${i + 1}/${nicks.length}`; pintar();
      try {
        const r = await carregarOponente(n);
        if (!cfg.nicks.some((x) => x.toLowerCase() === r.nick.toLowerCase())) cfg.nicks.push(r.nick);
      } catch {}
      await dormir(ESPERA_PERFIL_MS);
    }
    salvarCfg();
    ocupado = false; msg = '';
    pintar();
    analisar();
  }

  function aoClicar(e) {
    if (e.target.id === 'pa-fundo') return fechar();
    const b = e.target.closest('[data-a]');
    if (!b) return;
    const a = b.dataset.a;
    if (a === 'fechar') fechar();
    else if (a === 'tirar') { tirarId = Number(b.dataset.id); resultado = null; pintar(); analisar(); }
    else if (a === 'fonte') { cfg.fonte = b.dataset.v; salvarCfg(); tirarId = null; resultado = null; pintar(); }
    else if (a === 'aba') { aba = b.dataset.v; pintar(); }
    else if (a === 'add') adicionarNick();
    else if (a === 'top') carregarTop();
    else if (a === 'remover') {
      st.oponentes.delete(b.dataset.nick.toLowerCase());
      cfg.nicks = cfg.nicks.filter((n) => n.toLowerCase() !== b.dataset.nick.toLowerCase());
      salvarCfg(); resultado = null; pintar(); analisar();
    } else if (a === 'limpar') { st.oponentes.clear(); cfg.nicks = []; salvarCfg(); resultado = null; pintar(); }
  }

  async function abrir() {
    document.getElementById('pa-fundo').classList.add('aberto');
    if (!core.logado) { msg = 'Faça login nesta conta para analisar o time.'; pintar(); return; }
    try {
      if (!st.mod || !st.catalogo) {
        msg = 'Carregando as regras de combate do jogo…'; pintar();
        await carregarModulos();
        msg = 'Montando o catálogo de espécies…'; pintar();
        await carregarCatalogo();
      }
      msg = '';
      pintar();
      await carregarPvp();
      // Os rivais salvos voltam sozinhos (um pedido por nick, devagar).
      const faltam = cfg.nicks.filter((n) => !st.oponentes.has(n.toLowerCase()));
      if (faltam.length) {
        ocupado = true;
        for (const [i, n] of faltam.entries()) {
          msg = `Recarregando times rivais… ${i + 1}/${faltam.length}`; pintar();
          try { await carregarOponente(n); } catch {}
          await dormir(ESPERA_PERFIL_MS);
        }
        ocupado = false; msg = '';
      }
      pintar();
      if (tirarId != null) analisar();
    } catch (e) {
      msg = `Não deu para carregar a análise: ${e.message}`;
      ocupado = false;
      pintar();
    }
  }

  function fechar() {
    document.getElementById('pa-fundo')?.classList.remove('aberto');
  }

  montarUI();
  if (estavaAberto) abrir();
})();

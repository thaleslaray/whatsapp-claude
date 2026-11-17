// 0.12.0: as medidas do jeito do dono (jeito.ts), em casos pequenos conferíveis à mão: tamanho, rajada (no limite de
// 2 minutos), caixa, pontuação, emoji, risada, aberturas e fechos, palavras fora da lista comum, áudio, o que fica fora
// da medida (terceiros, mídia sem legenda, só link, rascunho da IA), a prioridade por comportamento e a medida da
// edição do cartão. Funções puras: sem banco, sem rede.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import {
  amostraDe,
  dadosDaPrioridade,
  distanciaPorPalavras,
  entraNaMedida,
  escolherPorVariedade,
  exemploDaRajada,
  juntarAmostras,
  marcaDoRascunho,
  medirEdicao,
  perfilDe,
  prioridadePublica,
  rajadasDoDono,
  temDadoProibido,
} from "../src/jeito.ts";

const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const MIN = 60_000;
let seq = 0;
const eu = (texto: string | undefined, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `M${++seq}`, ts, de_mim: true, tipo: "texto", ...(texto !== undefined ? { texto } : {}), ...o });
const ela = (texto: string, ts: number): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto });

describe("0.12.0: o perfil numérico de uma conversa", () => {
  // m1..m3: uma rajada (60 s e depois exatamente 2 min); recebida; m4; m5 2 min e 1 s depois (outra rajada).
  const conversa = [
    eu("oi tudo bem?", T0),
    eu("Vamos sim!", T0 + MIN),
    eu("kkkk ótimo 😂😂", T0 + 3 * MIN),
    ela("kkk que bom", T0 + 3 * MIN + 20_000),
    eu("Combinado.", T0 + 7 * MIN),
    eu("ATENÇÃO pessoal, amanhã cedo...", T0 + 9 * MIN + 1_000),
    eu(undefined, T0 + 20 * MIN, { tipo: "nota_de_voz", midia: { baixavel: false } }),
    eu(undefined, T0 + 30 * MIN, { tipo: "imagem", midia: { baixavel: false } }),
    eu("https://exemplo.com/a", T0 + 40 * MIN),
    eu("Olá, tudo certo por aqui.", T0 + 50 * MIN, { rascunho_da_ia: "sem_edicao" }),
    eu("Prezado, segue.", T0 + 60 * MIN, { rascunho_da_ia: "edicao_minima" }),
  ];

  it("cada medida, contada à mão", () => {
    const p = perfilDe(amostraDe(conversa));
    assert.equal(p.mensagens_medidas, 5, "fora: a recebida, a nota de voz, a imagem sem legenda, só link e os dois rascunhos da IA");
    assert.deepEqual(p.periodo, { primeira: new Date(T0).toISOString(), ultima: new Date(T0 + 9 * MIN + 1_000).toISOString() });
    // Caracteres: 12, 10, 13, 10, 31 -> mediana 12, p90 31. Palavras: 3, 2, 2, 1, 4 -> mediana 2, p90 4.
    assert.deepEqual(p.tamanho, { caracteres: { mediana: 12, p90: 31 }, palavras: { mediana: 2, p90: 4 } });
    // Rajadas: [m1 m2 m3] (o limite de 2 min é inclusive), [m4], [m5] (2 min e 1 s).
    assert.deepEqual(p.rajada, { rajadas: 3, mediana_de_mensagens: 1, proporcao_com_2_ou_mais: 0.33 });
    assert.deepEqual(p.caixa, { mensagens_com_letra: 5, comeca_com_minuscula: 0.4, toda_em_minusculas: 0.4, com_trecho_em_caixa_alta: 0.2 });
    assert.deepEqual(p.pontuacao_final, { ponto: 0.2, exclamacao: 0.2, interrogacao: 0.2, reticencias: 0.2, sem_pontuacao: 0.2, com_virgula: 0.2 });
    assert.deepEqual(p.emoji, { proporcao_de_mensagens: 0.2, media_por_mensagem_com_emoji: 2, mais_usados: [{ emoji: "😂", vezes: 2 }] });
    assert.deepEqual(p.risada, [{ forma: "kkkk", vezes: 1 }], "a risada da Ana não conta");
    assert.deepEqual(p.aberturas, []);
    assert.deepEqual(p.palavras_mais_usadas, [], "nenhuma palavra fora da lista aparece 3 vezes");
    // Áudio: das 8 mensagens do dono (5 de texto, nota de voz, imagem e link; os rascunhos da IA não contam), 1 é nota de voz.
    assert.deepEqual(p.audio, { mensagens_do_dono: 8, audios_e_notas_de_voz: 1, proporcao: 0.13 });
    assert.deepEqual(p.fora_da_medida, { com_link: 1, repetidas: 0 });
  });

  it("o que entra na medida", () => {
    assert.equal(entraNaMedida(eu("oi", 1)), true);
    assert.equal(entraNaMedida(ela("oi", 1)), false);
    assert.equal(entraNaMedida(eu("  ", 1)), false);
    assert.equal(entraNaMedida(eu("veja https://x.com/a", 1)), false, "mensagem com link sai de todas as medidas de forma");
    assert.equal(entraNaMedida(eu("olha o site.com.br", 1)), false);
    assert.equal(entraNaMedida(eu("www.x.com.br", 1)), false);
    assert.equal(entraNaMedida(eu("legenda da foto", 1, { tipo: "imagem" })), true, "mídia com legenda entra");
    assert.equal(entraNaMedida(eu("ok", 1, { rascunho_da_ia: "editado" })), true, "editado pelo dono entra");
    assert.equal(entraNaMedida(eu("ok", 1, { rascunho_da_ia: "sem_edicao" })), false);
  });

  it("aberturas, fechos e abreviações: 3 vezes ou mais, a forma mais escrita, sem a expressão contida com a mesma contagem", () => {
    // 0.14.0: um dia entre as mensagens (aberturas, fechos e palavras só entram vistos em 2+ dias).
    const MIN = 86_400_000;
    const c = [
      eu("Bom dia! vc pode hoje? abs", T0),
      ela("pode", T0 + MIN),
      eu("bom dia, vc viu? abs", T0 + 2 * MIN),
      ela("vi", T0 + 3 * MIN),
      eu("Bom dia vc chegou? Abs", T0 + 4 * MIN),
      ela("sim", T0 + 5 * MIN),
      eu("oi", T0 + 6 * MIN),
    ];
    const p = perfilDe(amostraDe(c));
    assert.deepEqual(p.aberturas, [{ expressao: "Bom dia vc", vezes: 3 }], "'bom' e 'bom dia' estão contidas em 'bom dia vc', com a mesma contagem");
    assert.deepEqual(p.fechos, [{ expressao: "abs", vezes: 3 }]);
    assert.deepEqual(p.palavras_mais_usadas, [{ palavra: "abs", vezes: 3 }, { palavra: "vc", vezes: 3 }]);
  });

  it("link e mensagem de máquina: fora das medidas, das expressões e do vocabulário, contadas em fora_da_medida", () => {
    // 0.14.0: um dia entre as mensagens (aberturas, fechos e palavras só entram vistos em 2+ dias).
    const MIN = 86_400_000;
    const sistema = "Nova inscrição recebida, origem em https://exemplo.com/form, confira";
    const maquina = "Seu agendamento foi confirmado para a mentoria, até breve e obrigado";
    const c: MensagemGuardada[] = [];
    for (let i = 0; i < 19; i++) c.push(ela("pergunta", T0 + i * 10 * MIN), eu(sistema, T0 + i * 10 * MIN + 1_000));
    for (let i = 0; i < 5; i++) c.push(ela("oi", T0 + (100 + i * 10) * MIN), eu(maquina, T0 + (100 + i * 10) * MIN + 1_000));
    // Quatro iguais (menos de 5) e curta repetida (até 40 caracteres): são do dono, entram.
    for (let i = 0; i < 4; i++) c.push(ela("e aí", T0 + (200 + i * 10) * MIN), eu("Fechado, te vejo na aula de quinta então", T0 + (200 + i * 10) * MIN + 1_000));
    for (let i = 0; i < 6; i++) c.push(ela("ok?", T0 + (300 + i * 10) * MIN), eu("ok", T0 + (300 + i * 10) * MIN + 1_000));
    const p = perfilDe(amostraDe(c));
    assert.deepEqual(p.fora_da_medida, { com_link: 19, repetidas: 5 });
    assert.equal(p.mensagens_medidas, 10);
    const tudo = JSON.stringify(p);
    for (const x of ["https", "exemplo", "origem", "confira", "agendamento", "mentoria"]) assert.ok(!tudo.includes(x), x);
    assert.ok(rajadasDoDono(c).every((r) => r.medidas.every((i) => c[i]!.texto !== sistema && c[i]!.texto !== maquina)), "nem nos exemplos");
    assert.deepEqual(p.fechos, [{ expressao: "ok", vezes: 6 }, { expressao: "de quinta então", vezes: 4 }], "só o que o dono escreveu");
  });

  it("aberturas e fechos nunca com e-mail, telefone ou 6+ dígitos", () => {
    // 0.14.0: um dia entre as mensagens (aberturas, fechos e palavras só entram vistos em 2+ dias).
    const MIN = 86_400_000;
    const c: MensagemGuardada[] = [];
    for (let i = 0; i < 3; i++) c.push(ela("?", T0 + i * 10 * MIN), eu(`manda pra ana@x.co ou 1234567`, T0 + i * 10 * MIN + 1_000));
    const p = perfilDe(amostraDe(c));
    assert.deepEqual(p.fechos, [], "todo fim de 1 a 3 palavras ('1234567', 'ou 1234567', 'ana@x.co ou 1234567') tem dado proibido");
    assert.deepEqual(p.aberturas, [{ expressao: "manda pra", vezes: 3 }], "'manda pra ana@x.co' sai");
  });

  it("risada agrupada pela forma reduzida, mostrando a forma mais escrita", () => {
    const c = ["kkk", "kkkkk", "haha", "hahaha", "rsrs"].map((t, i) => eu(t, T0 + i * 10 * MIN));
    assert.deepEqual(perfilDe(amostraDe(c)).risada, [{ forma: "haha", vezes: 2 }, { forma: "kkk", vezes: 2 }, { forma: "rsrs", vezes: 1 }]);
  });

  it("rajada: até 2 min inclusive; mensagem de outra pessoa no meio separa", () => {
    const tamanhos = (c: MensagemGuardada[]) => rajadasDoDono(c).map((r) => r.medidas.length);
    assert.deepEqual(tamanhos([eu("a", T0), eu("b", T0 + 120_000)]), [2]);
    assert.deepEqual(tamanhos([eu("a", T0), eu("b", T0 + 120_001)]), [1, 1]);
    assert.deepEqual(tamanhos([eu("a", T0), ela("x", T0 + 1_000), eu("b", T0 + 2_000)]), [1, 1]);
    // Um áudio do dono no meio mantém a rajada (é ele falando), mas não entra nela.
    assert.deepEqual(tamanhos([eu("a", T0), eu(undefined, T0 + 100_000, { tipo: "nota_de_voz" }), eu("b", T0 + 200_000)]), [2]);
  });

  it("perfil de várias conversas somadas é o perfil das mensagens juntas", () => {
    const a = [eu("um dois", T0), eu("tres", T0 + 10 * MIN)];
    const b = [eu("quatro cinco seis", T0 + 20 * MIN)];
    assert.deepEqual(perfilDe(juntarAmostras([amostraDe(a), amostraDe(b)])).tamanho, perfilDe(amostraDe([...a, ...b])).tamanho);
    assert.equal(perfilDe(juntarAmostras([amostraDe(a), amostraDe(b)])).mensagens_medidas, 3);
  });
});

describe("0.12.0: prioridade por comportamento", () => {
  it("tempo até responder, respondidas em 24 h, quantas vezes o dono iniciou e há quanto tempo", () => {
    const H = 60 * MIN;
    const agora = T0 + 40 * H;
    const c = [
      ela("oi", T0),
      ela("tá aí?", T0 + MIN),
      eu("tô", T0 + 30 * MIN), // bloco 1: 30 min
      ela("e o orçamento?", T0 + 2 * H),
      eu("mando hoje", T0 + 28 * H), // bloco 2: 26 h (e, depois de 26 h de silêncio, conta como o dono iniciando)
      ela("ok", agora - H), // bloco 3: sem resposta, menos de 24 h: fora da conta
    ];
    const p = prioridadePublica(dadosDaPrioridade(c), agora);
    assert.equal(p.blocos_recebidos, 3);
    assert.equal(p.blocos_respondidos, 2);
    assert.equal(p.mediana_ate_responder_min, (30 + 26 * 60) / 2);
    assert.equal(p.proporcao_respondida_em_ate_24h, 0.5);
    assert.equal(p.vezes_que_o_dono_iniciou, 1);
    assert.deepEqual(p.ultima_do_dono, { data: new Date(T0 + 28 * H).toISOString(), ha_horas: 12 });
    assert.deepEqual(p.ultima_recebida, { data: new Date(agora - H).toISOString(), ha_horas: 1 });
  });
});

describe("0.12.0: exemplos (pura)", () => {
  it("filtros: telefone, e-mail, link, dinheiro, código e 6+ dígitos", () => {
    for (const t of ["me liga no 11 91234-5678", "manda pra ana@exemplo.com", "olha www.site.com", "vê exemplo.com.br", "custa R$ 50", "são 300 reais", "uns 2k", "o código é AB12CD", "pedido 1234567", "`npm i`"]) {
      assert.equal(temDadoProibido(t), true, t);
    }
    for (const t of ["chego às 8", "beleza, até amanhã", "fechado! 👍", "tenho 3 filhos"]) assert.equal(temDadoProibido(t), false, t);
  });

  it("a rajada vira exemplo com no máximo 6 mensagens e 600 caracteres; com dado proibido, não vira", () => {
    const c = Array.from({ length: 8 }, (_, i) => eu(`msg ${"x".repeat(i)}`, T0 + i * 1_000));
    const ex = exemploDaRajada(c, rajadasDoDono(c)[0]!);
    assert.equal(ex!.textos.length, 6);
    const longa = [eu("a".repeat(500), T0), eu("b".repeat(200), T0 + 1_000)];
    assert.deepEqual(exemploDaRajada(longa, rajadasDoDono(longa)[0]!)!.textos, ["a".repeat(500)], "a segunda passaria de 600");
    const comTelefone = [eu("oi", T0), eu("meu número 11 98888-7777", T0 + 1_000)];
    assert.equal(exemploDaRajada(comTelefone, rajadasDoDono(comTelefone)[0]!), null);
  });

  it("variedade: metade recentes, o resto espalhado preferindo tamanhos diferentes", () => {
    const c = (ts: number, tamanho: "curta" | "media" | "longa") => ({ ts, tamanho });
    const lista = [c(10, "curta"), c(9, "curta"), c(8, "curta"), c(7, "curta"), c(6, "longa"), c(5, "curta"), c(4, "curta"), c(3, "media"), c(2, "curta"), c(1, "curta")];
    const e = escolherPorVariedade(lista, 4);
    assert.deepEqual(e.slice(0, 2).map((x) => x.ts), [10, 9], "as duas mais recentes");
    // Resto: [8..1] em duas faixas, [8 7 6 5] e [4 3 2 1]: a longa (6) e a média (3), tamanhos que ainda não havia.
    assert.deepEqual(e.slice(2).map((x) => x.ts), [6, 3]);
    assert.equal(escolherPorVariedade(lista.slice(0, 3), 6).length, 3, "com menos que o pedido, todas");
  });
});

describe("0.12.0: a medida da edição do cartão", () => {
  it("sem edição, mínima (só pontuação final ou espaço), emoji tirado, saudação tirada, caixa inicial e quebra em linhas", () => {
    assert.equal(marcaDoRascunho("Oi Ana", "Oi Ana"), "sem_edicao");
    const ponto = medirEdicao("Oi Ana, chego às 8.", "Oi Ana, chego às 8");
    assert.equal(ponto.minima, true, "só a pontuação final");
    assert.equal(marcaDoRascunho("Oi Ana, chego às 8.", "Oi Ana,  chego às 8"), "edicao_minima");
    const longo = "palavra ".repeat(40).trim();
    assert.equal(medirEdicao(longo, `${longo} mais`).minima, true, `1 em 41 palavras (${distanciaPorPalavras(longo, `${longo} mais`)}) é menos de 0,03`);

    const emoji = medirEdicao("Claro! Te mando amanhã 😊", "Claro! Te mando amanhã");
    assert.equal(emoji.minima, false);
    assert.equal(emoji.distancia, 0.2);
    assert.deepEqual(emoji.resumo.emoji, { antes: 1, depois: 0, mudou: "tirou" });

    const saudacao = medirEdicao("Olá Ana, segue o contrato", "segue o contrato");
    assert.equal(saudacao.resumo.saudacao, "tirou");
    assert.equal(saudacao.distancia, 0.4);
    assert.deepEqual(saudacao.resumo.palavras_tiradas, ["Olá", "Ana"]);
    assert.deepEqual(saudacao.resumo.primeira_palavra, { antes: "Olá", depois: "segue" });
    assert.deepEqual(saudacao.resumo.tamanho, { antes: 25, depois: 16, diferenca: -9 });

    const fecho = medirEdicao("Te mando amanhã. Abraços", "Te mando amanhã");
    assert.equal(fecho.resumo.fecho, "tirou");

    assert.equal(medirEdicao("Oi, tudo bem com você hoje", "oi, tudo bem com você hoje").resumo.caixa_inicial, "maiuscula_para_minuscula");

    const linhas = medirEdicao("Oi! Tudo bem? Chego às 8", "Oi!\nTudo bem?\nChego às 8");
    assert.equal(linhas.distancia, 0);
    assert.equal(linhas.minima, false, "quebrar em linhas é forma: não é mínima");
    assert.deepEqual(linhas.resumo.linhas, { antes: 1, depois: 3, quebrou_em_mais_linhas: true });
  });
});

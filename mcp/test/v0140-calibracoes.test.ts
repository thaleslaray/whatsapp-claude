// 0.14.0, Parte D: recência e promoção de padrão. Promoção: a expressão entra na lista com 3+ ocorrências em 2+
// conversas (amostra somada) ou, numa conversa só, em 2+ dias. Recência: meia-vida de 180 dias na ordem das aberturas,
// fechos e palavras (o `vezes` continua a contagem) e nas faixas da variedade dos exemplos; `ultimos_90_dias` no
// wa_meu_jeito quando o período tem 50+ mensagens (49 não basta).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import { amostraDe, escolherPorVariedade, juntarAmostras, MEIA_VIDA_DA_RECENCIA_DIAS, perfilDe, pesoDaData } from "../src/jeito.ts";
import { ANA, chamar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
let seq = 0;
const eu = (texto: string, ts: number): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto });
const ela = (texto: string, ts: number): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto });
/** Cada fala do dono depois de uma recebida, no dia (atrás de AGORA) dado, a 1 hora uma da outra no mesmo dia. */
const falas = (lista: Array<[string, number]>): MensagemGuardada[] => lista.flatMap(([t, dias], i) => [ela("pergunta", AGORA - dias * DIA + i * 3_600_000), eu(t, AGORA - dias * DIA + i * 3_600_000 + 60_000)]);
const fechos = (msgs: MensagemGuardada[] | ReturnType<typeof amostraDe>) => perfilDe(Array.isArray(msgs) ? amostraDe(msgs) : msgs).fechos.map((f) => `${f.expressao}:${f.vezes}`);

describe("0.14.0: promoção de padrão", () => {
  it("numa conversa só: 3 vezes no mesmo dia não entra; em 2 dias, entra", () => {
    assert.deepEqual(fechos(falas([["ok valeu", 5], ["certo valeu", 5], ["sim valeu", 5]])), []);
    assert.deepEqual(fechos(falas([["ok valeu", 5], ["certo valeu", 5], ["sim valeu", 4]])), ["valeu:3"]);
    // O mesmo para as palavras.
    const palavras = (l: Array<[string, number]>) => perfilDe(amostraDe(falas(l))).palavras_mais_usadas.map((p) => p.palavra);
    assert.deepEqual(palavras([["orçamento hoje", 3], ["orçamento amanhã", 3], ["o orçamento", 3]]), []);
    assert.ok(palavras([["orçamento hoje", 3], ["orçamento amanhã", 3], ["o orçamento", 2]]).includes("orçamento"));
  });

  it("na soma de conversas: 3 vezes numa conversa só não entra; em 2 conversas, entra", () => {
    const outra = amostraDe(falas([["nada a ver", 9]]));
    assert.deepEqual(fechos(juntarAmostras([amostraDe(falas([["ok valeu", 5], ["certo valeu", 4], ["sim valeu", 3]])), outra])), []);
    const a = amostraDe(falas([["ok valeu", 5], ["certo valeu", 4]]));
    const b = amostraDe(falas([["sim valeu", 5]]));
    assert.deepEqual(fechos(juntarAmostras([a, b])), ["valeu:3"]);
  });
});

describe("0.14.0: recência", () => {
  it("meia-vida de 180 dias: o peso dobra a cada 180 dias", () => {
    assert.equal(MEIA_VIDA_DA_RECENCIA_DIAS, 180);
    assert.equal(Math.round((pesoDaData(AGORA) / pesoDaData(AGORA - 180 * DIA)) * 1000) / 1000, 2);
  });

  it("fechos e palavras na ordem do recente: 3 recentes passam na frente de 4 de 400 dias atrás; `vezes` é a contagem", () => {
    const msgs = falas([["ok abs", 400], ["certo abs", 400], ["sim abs", 399], ["tá abs", 399], ["ok vlw", 10], ["certo vlw", 10], ["sim vlw", 9]]);
    assert.deepEqual(fechos(msgs), ["vlw:3", "abs:4"]);
    // Sem a recência (todos no mesmo período), o de 4 vem primeiro.
    assert.deepEqual(fechos(falas([["ok abs", 10], ["certo abs", 10], ["sim abs", 9], ["tá abs", 9], ["ok vlw", 10], ["certo vlw", 10], ["sim vlw", 9]])), ["abs:4", "vlw:3"]);
  });

  it("variedade com recência: as faixas do passado têm o mesmo peso, então a escolha do meio fica mais recente", () => {
    // 21 candidatos, um a cada 30 dias, todos curtos; k = 4: 2 mais recentes e 2 faixas no resto (19).
    const cands = Array.from({ length: 21 }, (_, i) => ({ ts: AGORA - i * 30 * DIA, tamanho: "curta" as const }));
    const sem = escolherPorVariedade(cands, 4);
    const com = escolherPorVariedade(cands, 4, true);
    assert.deepEqual(sem.slice(0, 2), com.slice(0, 2));
    // Sem recência: faixas de 9 e 10 (meio da 1ª: o 5º do resto, 180 dias depois dos 2 recentes). Com: o peso acumulado
    // passa da metade no 6º, a 1ª faixa tem 6 e o meio é o 3º do resto.
    assert.equal((AGORA - sem[2]!.ts) / (30 * DIA), 6);
    assert.equal((AGORA - com[2]!.ts) / (30 * DIA), 4);
    assert.ok(com[3]!.ts > sem[3]!.ts);
  });
});

describe("0.14.0: ultimos_90_dias no wa_meu_jeito", () => {
  let m: Montagem | undefined;
  let fechar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await fechar?.();
    fechar = undefined;
    await m?.fechar();
    m = undefined;
  });

  /** 30 mensagens antigas (200 dias) e `recentes` nos últimos 89 dias. */
  async function perfil(recentes: number): Promise<Obj> {
    m = await montar({ agora: () => AGORA, pareada: false });
    await m.ctx.partida();
    const { banco } = await m.ctx.nucleo();
    const antigas = Array.from({ length: 30 }, (_, i) => [`Mensagem antiga número ${i} com ponto.`, 200 + i] as [string, number]);
    const novas = Array.from({ length: recentes }, (_, i) => [`nova ${i}`, 1 + (i % 88)] as [string, number]);
    banco.gravarMensagens(pn(ANA), falas([...antigas, ...novas]).sort((a, b) => a.ts - b.ts));
    const c = await conectarCliente(m.ctx);
    fechar = c.fechar;
    return (await chamar(c.cliente, "wa_meu_jeito", { conversa: ANA })).perfil as Obj;
  }

  it("50 mensagens nos últimos 90 dias: traz o perfil recente (só elas)", async () => {
    const p = await perfil(50);
    assert.equal(p.mensagens_medidas, 80);
    const recente = p.ultimos_90_dias as Obj;
    assert.equal(recente.mensagens_medidas, 50);
    assert.equal((recente.pontuacao_final as Obj).ponto, 0, "as antigas (com ponto) ficam fora");
  });

  it("49: não traz", async () => {
    const p = await perfil(49);
    assert.equal(p.ultimos_90_dias, undefined);
  });
});

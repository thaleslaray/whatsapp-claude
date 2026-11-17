// 0.9.2: o lote ao vivo é gravado uma vez por conversa (transporte.ts, receberLoteAoVivo + Banco.gravarEmSequencia).
// O resultado tem de ser o mesmo de gravar uma por uma: mensagens, ordem e campos do índice, com edição e exclusão no
// meio aplicadas na ordem de chegada. Rede bloqueada, socket falso.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { proto, type WAMessage } from "@whiskeysockets/baileys";
import { ANA, assentar, BETO, conectar, DONO, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const P = proto.Message.ProtocolMessage.Type;
let montagens: Montagem[] = [];
afterEach(async () => {
  for (const m of montagens) await m.fechar();
  montagens = [];
});

/**
 * Base das datas, uma só para o arquivo inteiro e em segundos inteiros (o WhatsApp manda a data em segundos): os dois
 * caminhos comparados recebem exatamente as mesmas datas. Calculada em cada caminho, uma virada de segundo entre os
 * dois dava 1.000 ms de diferença (teste instável). Uma hora atrás, como antes: mensagens do passado recente.
 */
const BASE = Math.floor((Date.now() - 3_600_000) / 1_000) * 1_000;

/** Duas conversas intercaladas, com uma edição e uma exclusão no meio (ids fixos, datas no passado recente). */
function lote(base: number): WAMessage[] {
  const t = (i: number) => base + i * 1_000;
  return [
    msg({ jid: pn(ANA), id: "A1", texto: "oi", ts: t(1), nome: "Ana" }),
    msg({ jid: pn(BETO), id: "B1", texto: "olá", ts: t(2), nome: "Beto" }),
    msg({ jid: pn(ANA), id: "A2", texto: "tudo?", deMim: true, ts: t(3) }),
    msg({ jid: pn(ANA), id: "A3", texto: "vou apagar", ts: t(4), nome: "Ana Paula" }),
    msg({ jid: pn(BETO), id: "B2", texto: "segunda", ts: t(5), nome: "Beto" }),
    msg({ jid: pn(ANA), id: "X1", ts: t(6), message: { protocolMessage: { type: P.MESSAGE_EDIT, key: { remoteJid: pn(DONO), fromMe: true, id: "A1" }, editedMessage: { conversation: "oi, editado" } } } }),
    msg({ jid: pn(ANA), id: "X2", ts: t(7), message: { protocolMessage: { type: P.REVOKE, key: { remoteJid: pn(DONO), fromMe: true, id: "A3" } } } }),
    msg({ jid: pn(ANA), id: "A4", texto: "depois", ts: t(8), nome: "Ana Paula" }),
    msg({ jid: pn(BETO), id: "B3", texto: "ok", deMim: true, ts: t(9) }),
    msg({ jid: pn(BETO), id: "B4", texto: "e aí", ts: t(10) }),
    msg({ jid: pn(ANA), id: "A1", texto: "repetida", ts: t(1) }),
  ];
}

async function estadoDepois(comoLote: boolean, tipo: "notify" | "append"): Promise<unknown> {
  const m = await montar();
  montagens.push(m);
  const s = await conectar(m);
  if (comoLote) s.mensagens(lote(BASE), tipo);
  else for (const x of lote(BASE)) s.mensagens([x], tipo); // o caminho antigo: um evento (uma gravação) por mensagem
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  return Object.fromEntries(
    [pn(ANA), pn(BETO)].map((j) => [j, { mensagens: banco.lerMensagens(j), entrada: banco.entrada(j) }]).concat([["estatisticas", banco.estatisticas() as never]]),
  );
}

describe("0.9.2: lote ao vivo gravado uma vez por conversa", () => {
  for (const tipo of ["notify", "append"] as const) {
    it(`${tipo}: duas conversas intercaladas, com edição e exclusão no meio, dão o mesmo banco que uma por uma`, async () => {
      const umaPorUma = await estadoDepois(false, tipo);
      const emLote = await estadoDepois(true, tipo);
      assert.deepEqual(emLote, umaPorUma);
      // E o banco tem o que se espera (senão a igualdade não prova nada).
      const ana = (emLote as Record<string, { mensagens: Array<{ id: string; texto?: string }>; entrada: Record<string, unknown> }>)[pn(ANA)]!;
      assert.deepEqual(ana.mensagens.map((x) => x.id), ["A1", "A2", "A4"]);
      assert.equal(ana.mensagens[0]!.texto, "oi, editado");
      assert.equal(ana.entrada.nome, "Ana Paula");
    });
  }

  it("N mensagens novas de uma conversa num evento: uma gravação do arquivo dela, não N", async () => {
    const m = await montar();
    montagens.push(m);
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    const chamadas: number[] = [];
    const original = banco.gravarEmSequencia.bind(banco);
    banco.gravarEmSequencia = (jid, passos) => {
      chamadas.push(passos.length);
      return original(jid, passos);
    };
    s.mensagens(Array.from({ length: 40 }, (_, i) => msg({ jid: pn(ANA), id: `N${i}`, texto: `mensagem ${i}`, ts: BASE + i * 1_000 })));
    await assentar(m);
    assert.deepEqual(chamadas, [40], "uma gravação com os 40 passos");
    assert.equal(banco.lerMensagens(pn(ANA)).length, 40);
    assert.equal(banco.entrada(pn(ANA))!.nao_lidas, 40);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// 0.11.0: só a mensagem que pode mudar o mapa LID -> número força a gravação das pendentes. Conversa por LID já mapeado
// entra no lote; LID novo no meio grava antes (o mapa muda e a conversa pode mudar de lugar), e o banco é o mesmo.
const LID_ANA = "111111111111111@lid";
const LID_BETO = "222222222222222@lid";

function loteComLid(base: number, novo: boolean): WAMessage[] {
  const t = (i: number) => base + i * 1_000;
  return [
    msg({ jid: pn(ANA), id: "L1", texto: "oi pelo número", ts: t(1), nome: "Ana" }),
    msg({ jid: LID_ANA, id: "L2", texto: "oi pelo LID mapeado", ts: t(2), nome: "Ana" }),
    msg({ jid: pn(BETO), id: "L3", texto: "do Beto", ts: t(3), nome: "Beto" }),
    ...(novo ? [msg({ jid: LID_BETO, jidAlt: pn(BETO), id: "L4", texto: "Beto por um LID novo", ts: t(4), nome: "Beto" })] : []),
    msg({ jid: LID_ANA, id: "L5", texto: "de novo pelo LID", ts: t(5), deMim: true }),
    msg({ jid: pn(BETO), id: "L6", texto: "mais do Beto", ts: t(6) }),
  ];
}

async function estadoComLid(comoLote: boolean, novo: boolean): Promise<{ estado: unknown; gravacoes: Array<[string, number]> }> {
  const m = await montar();
  montagens.push(m);
  const s = await conectar(m);
  const { banco } = await m.ctx.nucleo();
  banco.mapearLid(LID_ANA, pn(ANA));
  const gravacoes: Array<[string, number]> = [];
  const original = banco.gravarEmSequencia.bind(banco);
  banco.gravarEmSequencia = (jid, passos) => {
    gravacoes.push([jid === pn(ANA) ? "ana" : jid === pn(BETO) ? "beto" : "outra", passos.length]);
    return original(jid, passos);
  };
  if (comoLote) s.mensagens(loteComLid(BASE, novo));
  else for (const x of loteComLid(BASE, novo)) s.mensagens([x]);
  await assentar(m);
  const estado = Object.fromEntries(
    [pn(ANA), pn(BETO), LID_ANA, LID_BETO].map((j) => [j, { mensagens: banco.lerMensagens(j), entrada: banco.entrada(j) ?? null }]).concat([["estatisticas", banco.estatisticas() as never], ["mapa", [banco.numeroDoLid(LID_ANA), banco.numeroDoLid(LID_BETO)] as never]]),
  );
  return { estado, gravacoes };
}

describe("0.11.0: lote ao vivo com conversa endereçada por LID", () => {
  it("LID já mapeado entra no lote: uma gravação por conversa, e o mesmo banco que uma por uma", async () => {
    const umaPorUma = await estadoComLid(false, false);
    const emLote = await estadoComLid(true, false);
    assert.deepEqual(emLote.estado, umaPorUma.estado);
    // Antes da 0.11.0 cada mensagem de LID gravava as pendentes antes: a Ana era gravada em pedaços.
    assert.deepEqual(emLote.gravacoes, [["ana", 3], ["beto", 2]]);
    const ana = (emLote.estado as Record<string, { mensagens: Array<{ id: string }> }>)[pn(ANA)]!;
    assert.deepEqual(ana.mensagens.map((x) => x.id), ["L1", "L2", "L5"]);
  });

  it("LID novo no meio força a gravação das pendentes antes dele, e o banco é o mesmo de uma por uma", async () => {
    const umaPorUma = await estadoComLid(false, true);
    const emLote = await estadoComLid(true, true);
    assert.deepEqual(emLote.estado, umaPorUma.estado);
    // As pendentes (Ana e Beto) foram gravadas antes do LID novo; o resto foi junto no fim.
    assert.deepEqual(emLote.gravacoes, [["ana", 2], ["beto", 1], ["beto", 2], ["ana", 1]]);
    const e = emLote.estado as Record<string, { mensagens: Array<{ id: string }> }> & { mapa: string[] };
    assert.deepEqual(e.mapa, [pn(ANA), pn(BETO)]);
    assert.deepEqual(e[pn(BETO)]!.mensagens.map((x) => x.id), ["L3", "L4", "L6"]);
  });
});

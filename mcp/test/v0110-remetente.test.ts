// 0.11.0: quem escreve em grupo só com o LID deixa de ser "número oculto" quando dá para saber o número, e ganha um
// rótulo estável por conversa (`participante: "p_..."`) para o modelo distinguir e contar pessoas sem ver número nem LID.
// - o mapa LID -> número aprende com os participantes dos grupos escolhidos (a busca de grupos que já existe) e com a
//   mensagem de grupo (participantAlt, ou o cache em memória dos participantes), respeitando a lista "nunca ler";
// - a conversão preenche o número; a LEITURA também (mensagem antiga gravada antes do mapa);
// - o LID nunca sai para o modelo; os metadados não são buscados a cada mensagem.
// Sem rede, socket falso.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import { ANA, assentar, BETO, chamar, conectar, conectarCliente, GRUPO, montar, OUTRO_GRUPO, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Obj = Record<string, unknown>;
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const LID_ANA = "123450000000001@lid";
const LID_BETO = "123450000000002@lid";
const LID_CARLA = "123450000000003@lid";
const CARLA = "5531977776666";
const LID_DUDA = "123450000000004@lid";
const DUDA = "5541966665555";
const BASE = Math.floor((Date.now() - 3_600_000) / 1_000) * 1_000;
const t = (i: number) => BASE + i * 1_000;

/** Grupos que o WhatsApp devolve: participantes com LID e número (Baileys 7: `id` em LID com `phoneNumber`, ou o contrário). */
const GRUPOS = {
  [GRUPO]: { id: GRUPO, subject: "Família", size: 3, participants: [{ id: LID_ANA, phoneNumber: pn(ANA) }, { id: pn(BETO), lid: LID_BETO }, { id: LID_CARLA }] },
  [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Condomínio", size: 2, participants: [{ id: LID_DUDA, phoneNumber: pn(DUDA) }] },
};

async function cenario(opcoes: { escolher?: string[] } = {}) {
  m = await montar();
  const { banco } = await m.ctx.nucleo();
  for (const g of opcoes.escolher ?? [GRUPO]) banco.permitirGrupo(g);
  const s = await conectar(m, { grupos: GRUPOS });
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { s, banco, c: cliente };
}

const remetentes = (r: Obj) => (r.mensagens as Obj[]).filter((x) => !x.de_mim).map((x) => (x.conteudo_de_terceiros as { remetente: Obj }).remetente);

describe("0.11.0: o mapa LID -> número aprende com os participantes dos grupos", () => {
  it("a busca de grupos (ao conectar) mapeia os participantes dos grupos ESCOLHIDOS; os outros só ficam na memória", async () => {
    const { s, banco } = await cenario();
    assert.equal(banco.numeroDoLid(LID_ANA), pn(ANA), "id em LID com phoneNumber");
    assert.equal(banco.numeroDoLid(LID_BETO), pn(BETO), "id em número com lid");
    assert.equal(banco.numeroDoLid(LID_CARLA), undefined, "sem número: nada");
    assert.equal(banco.numeroDoLid(LID_DUDA), undefined, "grupo não escolhido: fora do banco");
    assert.equal(s.chamadas.filter((x) => x.metodo === "groupFetchAllParticipating").length, 1);
  });

  it("mensagem de grupo com participante em LID sem participantAlt sai com o número mascarado, sem buscar metadados de novo", async () => {
    const { s, c, banco } = await cenario();
    s.mensagens([
      msg({ jid: GRUPO, id: "G1", participante: LID_ANA, nome: "Ana", texto: "oi", ts: t(1) }),
      msg({ jid: GRUPO, id: "G2", participante: LID_CARLA, nome: "Carla", texto: "olá", ts: t(2) }),
      msg({ jid: GRUPO, id: "G3", participante: LID_ANA, nome: "Ana", texto: "de novo", ts: t(3) }),
      msg({ jid: GRUPO, id: "G4", participante: LID_BETO, nome: "Beto", texto: "e eu", ts: t(4) }),
    ]);
    await assentar(m!);
    const guardadas = banco.lerMensagens(GRUPO);
    assert.equal(guardadas.find((x) => x.id === "G1")!.remetente!.numero, ANA, "a conversão preencheu o número");
    assert.equal(guardadas.find((x) => x.id === "G2")!.remetente!.numero, undefined);
    const r = await chamar(c, "wa_ler_conversa", { conversa: GRUPO });
    const [ana1, carla, ana2, beto] = remetentes(r);
    assert.equal(ana1!.numero, "+55 11 9****-5678");
    assert.equal(carla!.numero, "número oculto");
    assert.equal(beto!.numero, "+55 21 9****-4321");
    // Rótulo estável: a mesma pessoa tem o mesmo; pessoas diferentes, rótulos diferentes (dá para contar 3 pessoas).
    for (const x of [ana1, carla, ana2, beto]) assert.match(String(x!.participante), /^p_[0-9a-f]{8}$/);
    assert.equal(ana1!.participante, ana2!.participante);
    assert.equal(new Set([ana1, carla, beto].map((x) => x!.participante)).size, 3);
    // O LID nunca sai.
    const texto = JSON.stringify(r);
    for (const lid of [LID_ANA, LID_BETO, LID_CARLA]) assert.ok(!texto.includes(lid.split("@")[0]!), `LID vazou: ${lid}`);
    assert.equal(s.chamadas.filter((x) => x.metodo === "groupFetchAllParticipating").length, 1, "nada de buscar metadados por mensagem");
  });

  it("participantAlt na mensagem também ensina o mapa (e a pessoa ganha o mesmo rótulo pelo LID e pelo número)", async () => {
    const { s, c, banco } = await cenario();
    s.mensagens([
      msg({ jid: GRUPO, id: "G1", participante: LID_DUDA, participanteAlt: pn(DUDA), nome: "Duda", texto: "pelo LID", ts: t(1) }),
      msg({ jid: GRUPO, id: "G2", participante: pn(DUDA), nome: "Duda", texto: "pelo número", ts: t(2) }),
    ]);
    await assentar(m!);
    assert.equal(banco.numeroDoLid(LID_DUDA), pn(DUDA));
    const [pelaLid, peloNumero] = remetentes(await chamar(c, "wa_ler_conversa", { conversa: GRUPO }));
    assert.equal(pelaLid!.numero, "+55 41 9****-5555");
    assert.equal(pelaLid!.participante, peloNumero!.participante);
  });

  it("grupo escolhido DEPOIS da busca: o número vem do cache em memória dos participantes, na primeira mensagem", async () => {
    const { s, c, banco } = await cenario();
    assert.equal(banco.numeroDoLid(LID_DUDA), undefined);
    banco.permitirGrupo(OUTRO_GRUPO);
    s.mensagens([msg({ jid: OUTRO_GRUPO, id: "O1", participante: LID_DUDA, nome: "Duda", texto: "oi, condomínio", ts: t(1) })]);
    await assentar(m!);
    assert.equal(banco.numeroDoLid(LID_DUDA), pn(DUDA));
    const [duda] = remetentes(await chamar(c, "wa_ler_conversa", { conversa: OUTRO_GRUPO }));
    assert.equal(duda!.numero, "+55 41 9****-5555");
    assert.equal(s.chamadas.filter((x) => x.metodo === "groupFetchAllParticipating").length, 1);
  });

  it("mensagem ANTIGA (participante em LID, sem número) passa a sair com o número quando o mapa aprende; o rótulo muda para o do número, igual em toda a resposta", async () => {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    const antiga = (id: string, ts: number): MensagemGuardada => ({ id, ts, de_mim: false, tipo: "texto", texto: "antiga", remetente: { nome: "Carla" }, participante: LID_CARLA });
    banco.gravarMensagens(GRUPO, [antiga("V1", t(1)), { id: "V2", ts: t(2), de_mim: false, tipo: "texto", texto: "pelo número", remetente: { nome: "Carla", numero: CARLA }, participante: pn(CARLA) }]);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const antes = remetentes(await chamar(cliente, "wa_ler_conversa", { conversa: GRUPO }));
    assert.equal(antes[0]!.numero, "número oculto");
    assert.notEqual(antes[0]!.participante, antes[1]!.participante, "sem o mapa, não dá para saber que é a mesma pessoa");
    banco.mapearLid(LID_CARLA, pn(CARLA));
    const depois = remetentes(await chamar(cliente, "wa_ler_conversa", { conversa: GRUPO }));
    assert.equal(depois[0]!.numero, "+55 31 9****-6666");
    assert.equal(depois[0]!.participante, depois[1]!.participante, "com o mapa, a mesma pessoa");
    // O rótulo é por conversa: a mesma pessoa em outro grupo tem outro rótulo.
    banco.permitirGrupo(OUTRO_GRUPO);
    banco.gravarMensagens(OUTRO_GRUPO, [antiga("W1", t(3))]);
    const [noOutro] = remetentes(await chamar(cliente, "wa_ler_conversa", { conversa: OUTRO_GRUPO }));
    assert.notEqual(noOutro!.participante, depois[0]!.participante);
    // Estável entre leituras (HMAC com a chave do banco): de novo, o mesmo.
    assert.equal(remetentes(await chamar(cliente, "wa_ler_conversa", { conversa: GRUPO }))[0]!.participante, depois[0]!.participante);
  });

  it("wa_buscar e wa_memoria também mostram o número do mapa e o rótulo", async () => {
    m = await montar({ agora: () => t(10) });
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    banco.gravarMensagens(GRUPO, [{ id: "V1", ts: t(1), de_mim: false, tipo: "texto", texto: "eu levo o bolo no sábado", remetente: { nome: "Carla" }, participante: LID_CARLA }]);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    await chamar(cliente, "wa_anotar", { conversa: GRUPO, compromissos: [{ tipo: "promessa", quem_deve: "outro", o_que: "levar o bolo", mensagem_id: "V1", citacao: "eu levo o bolo" }] });
    banco.mapearLid(LID_CARLA, pn(CARLA));
    const busca = await chamar(cliente, "wa_buscar", { texto: "bolo", agrupar: "mensagem" });
    const rb = ((busca.resultados as Obj[])[0]!.conteudo_de_terceiros as { remetente: Obj }).remetente;
    assert.equal(rb.numero, "+55 31 9****-6666");
    assert.match(String(rb.participante), /^p_[0-9a-f]{8}$/);
    const mem = await chamar(cliente, "wa_memoria", { conversa: GRUPO });
    const rm = ((mem.compromissos as Obj[])[0]!.conteudo_de_terceiros as { remetente: Obj }).remetente;
    assert.equal(rm.numero, "+55 31 9****-6666");
    assert.equal(rm.participante, rb.participante);
    for (const r of [busca, mem]) assert.ok(!JSON.stringify(r).includes(LID_CARLA.split("@")[0]!));
  });
});

describe("0.11.0: o mapa dos participantes respeita a lista \"nunca ler\"", () => {
  it("participante cujo número está na lista: o LID entra na lista também e a conversa individual pelo LID é apagada", async () => {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.bloquear(pn(ANA));
    // Uma conversa individual guardada pelo LID antes de se saber de quem era (sem bloqueio por número sem LID, ela entrava).
    banco.liberar(pn(ANA));
    banco.gravarMensagens(LID_ANA, [{ id: "I1", ts: t(1), de_mim: false, tipo: "texto", texto: "pelo LID" }]);
    banco.bloquear(pn(ANA));
    assert.equal(banco.lerMensagens(LID_ANA).length, 1);
    banco.permitirGrupo(GRUPO);
    const s = await conectar(m, { grupos: GRUPOS });
    await assentar(m);
    assert.equal(banco.estaBloqueado(LID_ANA), true, "o LID entrou na lista com o número");
    assert.equal(banco.lerMensagens(LID_ANA).length, 0, "e o que estava guardado pelo LID saiu");
    // Mensagem individual pelo LID agora é ignorada antes de decifrar.
    assert.equal((s.config.shouldIgnoreJid as (j: string) => boolean)(LID_ANA), true);
  });
});

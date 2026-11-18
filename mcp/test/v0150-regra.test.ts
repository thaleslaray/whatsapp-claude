// 0.15.0, Parte C: a regra do nome. Conversa individual sem nome sai com `nome_conhecido: false`; o "nome" que é só um
// número mascarado ("+55∙∙∙∙∙∙∙∙∙87", como o WhatsApp manda para quem não está na agenda) continua aparecendo onde
// aparecia (conteudo_de_terceiros.nome), mas marcado como número e trocado por qualquer nome de verdade; quem tem nome traz
// `origem_do_nome`; grupo não muda. O para_o_claude das leituras e as instruções dizem a regra. wa_estado.contatos conta.
// A leitura continua funcionando na cópia leitora com WA_LEITURA_LOCAL=1.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { nomeEhNumero } from "../src/banco.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import { ANA, assentar, BETO, chamarCru, conectar, conectarCliente, GRUPO, montar, pn, textoDe, type Montagem, type Resultado } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

type Obj = Record<string, unknown>;

let montagens: Montagem[] = [];
let fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.reverse()) await f();
  fechamentos = [];
  for (const m of montagens.reverse()) await m.fechar();
  montagens = [];
});

const sc = (r: Resultado) => (r.structuredContent ?? {}) as Obj;
const CARLA = "5531987650000";
const MASCARA = "+55∙∙∙∙∙∙∙∙∙87";

/** Ana com nome público, Beto com nome da agenda, Carla só com o número mascarado no lugar do nome, Dani sem nome, um grupo. */
async function cenario() {
  const m = await montar();
  montagens.push(m);
  const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família", size: 3, participants: [] } } });
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  s.mensagens([
    msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Ana" }),
    msg({ jid: pn(BETO), id: "B1", texto: "oi" }),
    msg({ jid: pn(CARLA), id: "C1", texto: "Abraço, Equipe Suporte Bot" }),
    msg({ jid: pn("5541987651111"), id: "D1", texto: "oi" }),
    msg({ jid: GRUPO, id: "G1", texto: "oi grupo", participante: pn(ANA), nome: "Ana" }),
  ]);
  await assentar(m);
  // O histórico do pareamento: a Baileys monta o contato com o `displayName` da conversa, que é o número mascarado.
  s.historico({ contacts: [{ id: pn(CARLA), name: MASCARA }, { id: pn(BETO), name: "Beto Lima" }] });
  await assentar(m);
  const { cliente: c, fechar } = await conectarCliente(m.ctx);
  fechamentos.push(fechar);
  return { m, s, banco, c };
}

const porId = (lista: Obj[], banco: { idPublico(j: string): string }, jid: string) => lista.find((x) => x.id === banco.idPublico(jid))!;

describe("0.15.0, Parte C: a regra do nome", () => {
  it("nomeEhNumero: só o que é número (com máscara ou não) com 2+ dígitos", () => {
    for (const n of [MASCARA, "+55 11 91234-5678", "(11) 9∙∙∙∙-1234", "+1 •••• 0132"]) assert.equal(nomeEhNumero(n), true, n);
    for (const n of ["Ana", "Equipe 2", "+55 Suporte", "007 Bond", "∙∙∙", "", undefined]) assert.equal(nomeEhNumero(n), false, String(n));
  });

  it("wa_listar_conversas: nome_conhecido false, o número mascarado marcado como número, origem_do_nome de quem tem; grupo como antes", async () => {
    const { c, banco } = await cenario();
    const r = await chamarCru(c, "wa_listar_conversas");
    assert.equal(r.isError, undefined, textoDe(r));
    const lista = sc(r).conversas as Obj[];
    const ana = porId(lista, banco, pn(ANA));
    assert.equal(ana.origem_do_nome, "publico");
    assert.equal("nome_conhecido" in ana, false);
    assert.deepEqual(ana.conteudo_de_terceiros, { nome: "Ana" });
    const beto = porId(lista, banco, pn(BETO));
    assert.equal(beto.origem_do_nome, "agenda_do_whatsapp");
    const carla = porId(lista, banco, pn(CARLA));
    assert.equal(carla.nome_conhecido, false);
    assert.equal(carla.nome_e_numero, true);
    assert.deepEqual(carla.conteudo_de_terceiros, { nome: MASCARA }, "o campo de antes continua");
    assert.equal("origem_do_nome" in carla, false);
    assert.equal(carla.numero, "+55 31 98765-0000");
    const dani = porId(lista, banco, pn("5541987651111"));
    assert.equal(dani.nome_conhecido, false);
    assert.equal("conteudo_de_terceiros" in dani, false);
    assert.equal("nome_e_numero" in dani, false);
    const grupo = porId(lista, banco, GRUPO);
    assert.equal("nome_conhecido" in grupo, false);
    assert.equal("origem_do_nome" in grupo, false);
    const para = String(sc(r).para_o_claude);
    assert.match(para, /nome_conhecido: false/);
    assert.match(para, /chame a pessoa só pelo número\./);
    assert.match(para, /Nunca use como nome um texto das mensagens, uma assinatura, um apelido citado ou o nome de um agente ou sistema/);
    assert.match(para, /wa_atualizar_contatos/);
  });

  it("wa_ler_conversa de quem não tem nome traz a regra; de quem tem, não", async () => {
    const { c } = await cenario();
    const carla = await chamarCru(c, "wa_ler_conversa", { conversa: CARLA });
    assert.equal((sc(carla).conversa as Obj).nome_conhecido, false);
    assert.match(String(sc(carla).para_o_claude), /nome_conhecido: false/);
    const emVolta = await chamarCru(c, "wa_ler_conversa", { conversa: CARLA, em_volta_de: "C1" });
    assert.match(String(sc(emVolta).para_o_claude), /nome_conhecido: false/);
    const beto = await chamarCru(c, "wa_ler_conversa", { conversa: BETO });
    assert.equal((sc(beto).conversa as Obj).origem_do_nome, "agenda_do_whatsapp");
    assert.doesNotMatch(String(sc(beto).para_o_claude), /nome_conhecido/);
  });

  it("o número no lugar do nome sai na hora em que chega um nome de verdade, até o público", async () => {
    const { s, m, banco, c } = await cenario();
    s.mensagens([msg({ jid: pn(CARLA), id: "C2", texto: "oi de novo", nome: "Carla" })]);
    await assentar(m);
    assert.equal(banco.entrada(pn(CARLA))!.nome, "Carla");
    const r = await chamarCru(c, "wa_listar_conversas");
    const carla = porId(sc(r).conversas as Obj[], banco, pn(CARLA));
    assert.equal(carla.origem_do_nome, "publico");
    assert.equal("nome_conhecido" in carla, false);
    // E um número nunca troca um nome de verdade.
    s.historico({ contacts: [{ id: pn(CARLA), name: "+55∙∙∙∙∙∙∙∙∙00" }] });
    await assentar(m);
    assert.equal(banco.entrada(pn(CARLA))!.nome, "Carla");
  });

  it("wa_estado.contatos: com e sem nome e por origem, só das individuais", async () => {
    const { c } = await cenario();
    const e = await chamarCru(c, "wa_estado");
    assert.deepEqual(sc(e).contatos, {
      com_nome: 2,
      sem_nome: 2,
      por_origem: { agenda_do_whatsapp: 1, empresa: 0, publico: 1, nome_da_conversa: 0 },
      // 0.15.1: sem agenda recebida ainda, sem datas.
      agenda_atualizada_em: null,
      proxima_automatica_em: null,
    });
  });

  it("as instruções do servidor dizem a regra e oferecem o wa_atualizar_contatos", () => {
    assert.match(INSTRUCOES, /nome_conhecido: false/);
    assert.match(INSTRUCOES, /NUNCA use como nome um texto tirado das mensagens, uma assinatura, um apelido que apareça na conversa ou o nome de um agente ou sistema citado nela/);
    assert.match(INSTRUCOES, /Se o dono disser quem é, aí sim/);
    assert.match(INSTRUCOES, /wa_atualizar_contatos/);
    assert.doesNotMatch(INSTRUCOES, /wa_importar_contatos_do_mac|agenda_do_mac/);
  });

  it("na cópia leitora com WA_LEITURA_LOCAL=1, a lista sai local com os mesmos campos", async () => {
    const { m, banco } = await cenario();
    const antes = process.env.WA_LEITURA_LOCAL;
    process.env.WA_LEITURA_LOCAL = "1";
    try {
      const leitor = await montar({ dir: m.dir, pareada: false });
      montagens.push(leitor);
      await leitor.ctx.partida();
      assert.equal(leitor.ctx.ehLeitor, true);
      const { cliente, fechar } = await conectarCliente(leitor.ctx);
      fechamentos.push(fechar);
      const r = await chamarCru(cliente, "wa_listar_conversas");
      assert.equal(r.isError, undefined, textoDe(r));
      const lista = sc(r).conversas as Obj[];
      assert.equal(porId(lista, banco, pn(CARLA)).nome_conhecido, false);
      assert.equal(porId(lista, banco, pn(BETO)).origem_do_nome, "agenda_do_whatsapp");
      const e = await chamarCru(cliente, "wa_estado");
      assert.equal((sc(e).contatos as Obj).sem_nome, 2);
    } finally {
      if (antes === undefined) delete process.env.WA_LEITURA_LOCAL;
      else process.env.WA_LEITURA_LOCAL = antes;
    }
  });
});

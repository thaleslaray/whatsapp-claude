// 0.13.0: grupo como cidadão de primeira classe no jeito (Parte A). Contra o banco de verdade (pasta temporária, sem
// rede, relógio fixo): os três perfis (individuais, grupos, geral) com números conferíveis à mão, o tipo em grupo (o
// perfil do tipo soma individuais e grupos), a ordem das origens dos exemplos nos dois sentidos, a rajada em grupo
// encerrada por mensagem de terceiro, o apoio de grupo pequeno (o perfil `grupos`) e as contagens dos pares.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Banco, MensagemGuardada } from "../src/banco.ts";
import { ANA, BETO, chamar, conectarCliente, GRUPO, montar, OUTRO_GRUPO, pn, type Montagem } from "./ajuda.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
const MIN = 60_000;
const CARLA = "5531977776666";
const TERCEIRO_GRUPO = "120363000000000003@g.us";

let seq = 0;
const eu = (texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto, ...o });
const ela = (texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto, ...o });
/** Cada texto do dono vira uma rajada, um dia depois do outro, depois de uma mensagem de outra pessoa. */
const rajadas = (textos: string[], inicio: number): MensagemGuardada[] => textos.flatMap((t, i) => [ela(`TERCEIRO diz ${i}`, inicio + i * DIA), eu(t, inicio + i * DIA + MIN)]);

async function montarCom(semear: (banco: Banco, base: number) => void): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar({ agora: () => AGORA, pareada: false });
  await m.ctx.partida();
  const { banco } = await m.ctx.nucleo();
  for (const g of [GRUPO, OUTRO_GRUPO, TERCEIRO_GRUPO]) banco.permitirGrupo(g);
  semear(banco, AGORA - 30 * DIA);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const perfil = (r: Obj, campo: string) => r[campo] as { mensagens_medidas: number; tamanho: { caracteres: { mediana: number } }; rajada: { rajadas: number } };

describe("0.13.0: três perfis e o tipo em grupo", () => {
  it("individuais, grupos e geral com números à mão; tipo em grupo soma os dois; pares contados por ligação e lado", async () => {
    const { c } = await montarCom((banco, base) => {
      // Individuais: Ana 3 (2, 10, 8 caracteres), Beto 1 (6). Grupos: GRUPO 2 (16, 17), OUTRO_GRUPO 1 (7).
      banco.gravarMensagens(pn(ANA), [...rajadas(["ok", "tudo certo"], base), ela("pode ser amanhã?", base + 5 * DIA), eu("pode ser", base + 5 * DIA + MIN)]);
      banco.gravarMensagens(pn(BETO), rajadas(["beleza"], base));
      banco.gravarMensagens(GRUPO, [
        ela("a aula é hoje?", base, { participante: pn(BETO), remetente: { numero: BETO } }),
        eu("Aula hoje às 19h", base + MIN),
        ela("onde está o material", base + DIA, { id: "Q-MATERIAL", participante: pn(ANA), remetente: { numero: ANA } }),
        ela("TERCEIRO outra", base + DIA + MIN),
        eu("Material no drive", base + DIA + 30 * MIN, { citada: { id: "Q-MATERIAL" } }),
      ]);
      banco.gravarMensagens(OUTRO_GRUPO, rajadas(["Bom dia"], base));
    });
    await chamar(c, "wa_aprender", { tipo_da_conversa: [{ conversa: GRUPO, tipo: "Alunos" }, { conversa: pn(BETO), tipo: "alunos" }] });
    const r = await chamar(c, "wa_meu_jeito");
    const ind = perfil(r, "individuais");
    const grp = perfil(r, "grupos");
    const geral = perfil(r, "geral");
    assert.deepEqual([ind.mensagens_medidas, grp.mensagens_medidas, geral.mensagens_medidas], [4, 3, 7]);
    // Medianas: individuais [2, 6, 8, 10] = 7; grupos [7, 16, 17] = 16; geral [2, 6, 7, 8, 10, 16, 17] = 8.
    assert.deepEqual([ind.tamanho.caracteres.mediana, grp.tamanho.caracteres.mediana, geral.tamanho.caracteres.mediana], [7, 16, 8]);
    const contagens = r.contagens as Obj;
    assert.equal(contagens.mensagens_do_dono_medidas, 7);
    assert.equal(contagens.conversas_individuais, 2);
    assert.equal(contagens.grupos, 2);
    assert.deepEqual((contagens.por_perfil as Obj).grupos, { mensagens_medidas: 3, conversas: 2, com_mensagem_medida: 2 });
    assert.deepEqual(contagens.pares, {
      individuais: { citada: 0, sequencia: 1, de_rascunho_da_ia: 0 },
      grupos: { citada: 1, sequencia: 1, de_rascunho_da_ia: 0 },
    });
    // O tipo vale para grupo: "alunos" = Beto (1) + GRUPO (2).
    assert.deepEqual(r.tipos, [{ tipo: "alunos", conversas: 2 }]);
    assert.equal(((r.por_tipo as Obj[])[0]!.perfil as Obj).mensagens_medidas, 3);
    assert.equal(r.sem_tipo, 1);
    assert.equal(r.grupos_sem_tipo, 1);
    assert.match(String(r.para_o_claude), /medidos separados/);
    const doTipo = await chamar(c, "wa_meu_jeito", { tipo: "ALUNOS" });
    assert.deepEqual([doTipo.conversas, doTipo.conversas_individuais, doTipo.grupos, (doTipo.perfil as Obj).mensagens_medidas], [2, 1, 1, 3]);
    // Por conversa: o grupo tem tipo, os pares dele e não tem prioridade.
    const g = await chamar(c, "wa_meu_jeito", { conversa: GRUPO });
    assert.equal(g.tipo, "alunos");
    assert.deepEqual(g.pares, { citada: 1, sequencia: 1, de_rascunho_da_ia: 0 });
    assert.equal(g.prioridade, undefined);
    // A visão geral não diz de que conversa veio nada.
    assert.ok(!JSON.stringify(r).includes("TERCEIRO"));
  });

  it("amostra pequena: grupo tem apoio de `grupos`; individual, de `individuais`; o tipo vem antes", async () => {
    const { c } = await montarCom((banco, base) => {
      banco.gravarMensagens(GRUPO, rajadas(Array.from({ length: 22 }, (_, i) => `aviso do grupo ${i}`), base));
      banco.gravarMensagens(OUTRO_GRUPO, rajadas(["um aviso"], base));
      banco.gravarMensagens(pn(ANA), rajadas(Array.from({ length: 21 }, (_, i) => `fala ${i}`), base));
      banco.gravarMensagens(pn(BETO), rajadas(["oi"], base));
    });
    const grupoPequeno = await chamar(c, "wa_meu_jeito", { conversa: OUTRO_GRUPO });
    assert.equal(grupoPequeno.amostra_pequena, true);
    assert.equal((grupoPequeno.apoio as Obj).de, "grupos");
    assert.equal(((grupoPequeno.apoio as Obj).perfil as Obj).mensagens_medidas, 23);
    assert.match(String(grupoPequeno.para_o_claude), /dos grupos/);
    const indPequena = await chamar(c, "wa_meu_jeito", { conversa: pn(BETO) });
    assert.equal((indPequena.apoio as Obj).de, "individuais");
    assert.equal(((indPequena.apoio as Obj).perfil as Obj).mensagens_medidas, 22);
    // Com tipo de 20+, o apoio é o do tipo (que soma o grupo grande e a conversa individual).
    await chamar(c, "wa_aprender", { tipo_da_conversa: [{ conversa: OUTRO_GRUPO, tipo: "clientes" }, { conversa: GRUPO, tipo: "clientes" }] });
    const comTipo = await chamar(c, "wa_meu_jeito", { conversa: OUTRO_GRUPO });
    assert.deepEqual([(comTipo.apoio as Obj).de, (comTipo.apoio as Obj).tipo], ["tipo", "clientes"]);
  });

  it("rajada em grupo: mensagem de outra pessoa no meio encerra a rajada, mesmo dentro de 2 minutos", async () => {
    const { c } = await montarCom((banco, base) => {
      banco.gravarMensagens(GRUPO, [eu("primeira parte", base), ela("TERCEIRO no meio", base + 30_000), eu("segunda parte", base + 60_000), eu("e a terceira", base + 90_000)]);
    });
    const r = await chamar(c, "wa_meu_jeito", { conversa: GRUPO });
    assert.equal((r.perfil as { rajada: { rajadas: number } }).rajada.rajadas, 2);
    const ex = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 3 });
    assert.deepEqual((ex.exemplos as Obj[]).map((e) => e.mensagens), [["segunda parte", "e a terceira"], ["primeira parte"]]);
  });
});

describe("0.13.0: ordem das origens dos exemplos", () => {
  async function cenario() {
    return montarCom((banco, base) => {
      banco.gravarMensagens(GRUPO, rajadas(["grupo alvo"], base)); // clientes
      banco.gravarMensagens(TERCEIRO_GRUPO, rajadas(["grupo clientes um", "grupo clientes dois"], base)); // clientes
      banco.gravarMensagens(OUTRO_GRUPO, rajadas(["grupo alunos um", "grupo alunos dois"], base)); // alunos
      banco.gravarMensagens(pn(ANA), rajadas(["ana um", "ana dois", "ana tres"], base)); // clientes
      banco.gravarMensagens(pn(CARLA), rajadas(["carla um"], base)); // clientes
      banco.gravarMensagens(pn(BETO), rajadas(["beto um"], base)); // sem tipo
    });
  }
  const tipos = (c: Cliente) =>
    chamar(c, "wa_aprender", {
      tipo_da_conversa: [
        { conversa: GRUPO, tipo: "clientes" },
        { conversa: TERCEIRO_GRUPO, tipo: "clientes" },
        { conversa: OUTRO_GRUPO, tipo: "alunos" },
        { conversa: pn(ANA), tipo: "clientes" },
        { conversa: pn(CARLA), tipo: "clientes" },
      ],
    });

  it("para um GRUPO: ele, grupos do mesmo tipo, outro grupo, individuais do mesmo tipo, geral", async () => {
    const { c } = await cenario();
    await tipos(c);
    const r = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 10 });
    const lista = r.exemplos as Obj[];
    assert.deepEqual(
      lista.map((e) => e.origem),
      ["mesma_conversa", "mesmo_tipo_em_grupo", "mesmo_tipo_em_grupo", "outro_grupo", "outro_grupo", "mesmo_tipo", "mesmo_tipo", "mesmo_tipo", "mesmo_tipo", "geral"],
    );
    assert.deepEqual((lista[0]!.mensagens as string[]), ["grupo alvo"]);
    assert.deepEqual(lista.slice(1, 3).flatMap((e) => e.mensagens as string[]).sort(), ["grupo clientes dois", "grupo clientes um"]);
    assert.deepEqual(lista.slice(3, 5).flatMap((e) => e.mensagens as string[]).sort(), ["grupo alunos dois", "grupo alunos um"]);
    assert.deepEqual(lista.at(-1)!.mensagens, ["beto um"]);
    assert.ok(!/[cg]_[0-9a-f]{12}/.test(JSON.stringify(lista)), "a origem não diz de qual conversa veio");
  });

  it("para uma conversa INDIVIDUAL: ela, individuais do mesmo tipo, grupos do mesmo tipo, individuais em geral", async () => {
    const { c } = await cenario();
    await tipos(c);
    const r = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: pn(ANA), quantos: 10 });
    const lista = r.exemplos as Obj[];
    assert.deepEqual(lista.map((e) => e.origem), ["mesma_conversa", "mesma_conversa", "mesma_conversa", "mesmo_tipo", "mesmo_tipo_em_grupo", "mesmo_tipo_em_grupo", "mesmo_tipo_em_grupo", "geral"]);
    assert.deepEqual(lista[3]!.mensagens, ["carla um"]);
    assert.deepEqual(lista.slice(4, 7).flatMap((e) => e.mensagens as string[]).sort(), ["grupo alvo", "grupo clientes dois", "grupo clientes um"]);
    assert.deepEqual(lista.at(-1)!.mensagens, ["beto um"]);
    assert.ok(!JSON.stringify(r).includes("grupo alunos"), "grupo de outro tipo não entra para conversa individual");
  });
});

// 0.11.0: dois ajustes da memória e a marca do resumo que acompanha o mapeamento LID -> número.
// - regravar um compromisso sem `prazo` mantém o prazo; `prazo: "nenhum"` tira;
// - `dias_em_aberto` de compromisso fechado conta até `fechado_em`, não até hoje;
// - no mapeamento LID -> número, a marca do resumo vai para o número (sem marca, herda; com as duas, vence a maior).
// Sem rede, socket falso, relógio fixo.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type MensagemGuardada } from "../src/banco.ts";
import { ANA, chamar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const em = (dia: number, hora: number) => new Date(2026, 10, dia, hora, 0).getTime();
const mg = (id: string, texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id, ts, de_mim: false, tipo: "texto", texto, ...o });

/** O relógio da montagem: o teste muda o valor (nada de Date.now nas datas comparadas). */
let agora = em(14, 12);

async function cenario() {
  agora = em(14, 12);
  m = await montar({ agora: () => agora });
  const { banco } = await m.ctx.nucleo();
  banco.gravarMensagens(pn(ANA), [mg("A1", "Você me manda o contrato amanhã?", em(10, 10)), mg("A2", "contrato enviado", em(12, 9), { de_mim: true })]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const comp = (o: Obj = {}) => ({ tipo: "pedido", quem_deve: "dono", o_que: "mandar o contrato", mensagem_id: "A1", citacao: "Você me manda o contrato", ...o });
const gravado = (r: Obj) => (r.compromissos_gravados as Obj[])[0]!;

describe("0.11.0: prazo ao regravar um compromisso", () => {
  it("regravar sem `prazo` mantém o prazo anterior; `prazo: \"nenhum\"` tira; prazo novo troca", async () => {
    const { c, banco } = await cenario();
    const r1 = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp({ prazo: "+1d" })] });
    const id = gravado(r1).id;
    assert.deepEqual(gravado(r1).prazo, { data: "2026-11-11", dia_da_semana: "quarta-feira" });

    // Só corrige o texto, sem prazo: o prazo fica.
    const r2 = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp({ o_que: "mandar o contrato assinado" })] });
    assert.equal(gravado(r2).id, id);
    assert.equal(gravado(r2).novo, false);
    assert.deepEqual(gravado(r2).prazo, { data: "2026-11-11", dia_da_semana: "quarta-feira" }, "o prazo anterior ficou");
    assert.equal(banco.compromissos(pn(ANA))[0]!.prazo, new Date(2026, 10, 11).getTime());
    assert.equal(banco.compromissos(pn(ANA))[0]!.o_que, "mandar o contrato assinado");

    // Prazo novo troca.
    const r3 = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp({ prazo: "sex" })] });
    assert.deepEqual(gravado(r3).prazo, { data: "2026-11-13", dia_da_semana: "sexta-feira" });

    // "nenhum" (sem diferença de maiúscula) tira.
    const r4 = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp({ prazo: "Nenhum" })] });
    assert.equal("prazo" in gravado(r4), false);
    assert.equal(banco.compromissos(pn(ANA))[0]!.prazo, undefined);
    const lido = (await chamar(c, "wa_memoria", { conversa: pn(ANA) })).compromissos as Obj[];
    assert.equal("prazo" in lido[0]!, false);
    assert.equal("situacao_do_prazo" in lido[0]!, false);
  });

  it("compromisso NOVO com `prazo: \"nenhum\"` entra sem prazo; a descrição da ferramenta ensina o \"nenhum\"", async () => {
    const { c, banco } = await cenario();
    const r = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp({ prazo: "nenhum" })] });
    assert.equal(gravado(r).novo, true);
    assert.equal(banco.compromissos(pn(ANA))[0]!.prazo, undefined);
    const { tools } = await c.listTools();
    const anotar = tools.find((t) => t.name === "wa_anotar")!;
    assert.match(anotar.description!, /"nenhum" tira o prazo/);
    assert.match(anotar.description!, /sem `prazo`, mantém o prazo/);
    assert.match(JSON.stringify(anotar.inputSchema), /nenhum/);
  });
});

describe("0.11.0: dias_em_aberto de compromisso fechado", () => {
  it("conta da mensagem até fechado_em, e não muda com o passar dos dias; o aberto continua contando até hoje", async () => {
    const { c } = await cenario();
    const r = await chamar(c, "wa_anotar", { conversa: pn(ANA), compromissos: [comp(), comp({ quem_deve: "outro", o_que: "me lembrar", tipo: "pergunta" })] });
    const [fechar, aberto] = (r.compromissos_gravados as Obj[]).map((x) => String(x.id));
    agora = em(12, 18); // fechado na quinta, 2 dias depois da mensagem (terça)
    await chamar(c, "wa_anotar", { conversa: pn(ANA), fechar: [{ id: fechar, estado: "cumprido", evidencia_mensagem_id: "A2" }] });
    agora = em(25, 12); // duas semanas depois
    const lido = (await chamar(c, "wa_memoria", { conversa: pn(ANA), incluir_fechados: true })).compromissos as Obj[];
    const por = (id: string) => lido.find((k) => k.id === id)!;
    assert.equal(por(fechar!).estado, "cumprido");
    assert.equal(por(fechar!).dias_em_aberto, 2, "até fechado_em (12/11), não até hoje (25/11)");
    assert.equal(por(fechar!).fechado_em, new Date(em(12, 18)).toISOString());
    assert.equal(por(aberto!).dias_em_aberto, 15, "o aberto conta até hoje");
  });
});

describe("0.11.0: a marca do resumo acompanha o mapeamento LID -> número", () => {
  const LID = "999999999999999@lid";

  it("número sem marca herda a do LID; a do LID sai", async () => {
    m = await montar({ agora: () => agora });
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(LID, [mg("L1", "oi pelo LID", em(10, 10))]);
    banco.guardarMarcaDoResumo(LID, em(10, 10));
    banco.mapearLid(LID, pn(ANA));
    assert.equal(banco.marcaDoResumo(pn(ANA)), em(10, 10));
    assert.equal(banco.marcaDoResumo(LID), undefined);
    assert.equal(banco.lerMensagens(pn(ANA)).length, 1, "a conversa foi junto, como antes");
  });

  it("com as duas marcas, vence a maior (nos dois sentidos)", async () => {
    m = await montar({ agora: () => agora });
    const { banco } = await m.ctx.nucleo();
    // LID mais adiantado que o número.
    banco.gravarMensagens(pn(ANA), [mg("N1", "pelo número", em(9, 10))]);
    banco.guardarMarcaDoResumo(pn(ANA), em(9, 10));
    banco.gravarMensagens(LID, [mg("L1", "pelo LID", em(11, 10))]);
    banco.guardarMarcaDoResumo(LID, em(11, 10));
    banco.mapearLid(LID, pn(ANA));
    assert.equal(banco.marcaDoResumo(pn(ANA)), em(11, 10));
    // Número mais adiantado que o LID.
    const LID2 = "888888888888888@lid";
    banco.gravarMensagens(LID2, [mg("L2", "outro LID", em(8, 10))]);
    banco.guardarMarcaDoResumo(LID2, em(8, 10));
    banco.mapearLid(LID2, pn(ANA));
    assert.equal(banco.marcaDoResumo(pn(ANA)), em(11, 10));
    assert.equal(banco.marcaDoResumo(LID2), undefined);
  });

  it("marca só no LID (sem conversa sob ele) também vai, mesmo com o par já no mapa", async () => {
    m = await montar({ agora: () => agora });
    const { banco } = await m.ctx.nucleo();
    banco.mapearLid(LID, pn(ANA));
    banco.guardarMarcaDoResumo(LID, em(10, 10));
    banco.mapearLid(LID, pn(ANA));
    assert.equal(banco.marcaDoResumo(pn(ANA)), em(10, 10));
    assert.equal(banco.marcaDoResumo(LID), undefined);
  });

  it("no mapeamento em lote (participantes de grupo) a marca também vai", async () => {
    m = await montar({ agora: () => agora });
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(LID, [mg("L1", "oi", em(10, 10))]);
    banco.guardarMarcaDoResumo(LID, em(10, 10));
    assert.equal(banco.mapearLids([{ lid: LID, pn: pn(ANA) }]), 1);
    assert.equal(banco.marcaDoResumo(pn(ANA)), em(10, 10));
    assert.equal(banco.marcaDoResumo(LID), undefined);
    assert.equal(banco.mapearLids([{ lid: LID, pn: pn(ANA) }]), 0, "o par já conhecido não custa nada");
  });
});

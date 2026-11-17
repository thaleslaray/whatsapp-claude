// 0.14.0, Parte B: o servidor acha o que o dono sempre corta ou põe (src/cortes.ts), sem IA: trechos cortados e postos
// (3+ edições, 60%+, não só palavras comuns, sobrepostos no maior), hábitos de estrutura, menos de 5 edições (diz
// quantas faltam), escopo sugerido, regra que já existe não volta; e o uso: `candidatos` no wa_edicoes_dos_rascunhos e
// `propor` com `candidato` no wa_aprender (entra como PROPOSTA; só vira ativa com `decidir`).

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { candidatosDasEdicoes } from "../src/cortes.ts";
import { medirEdicao, type EdicaoGuardada, type Regra } from "../src/jeito.ts";
import { ANA, BETO, chamar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
let seq = 0;
const edicao = (rascunho: string, enviado: string, conversa = pn(ANA), dia = ++seq): EdicaoGuardada => {
  const m = medirEdicao(rascunho, enviado);
  return { id: `e_${String(seq).padStart(8, "0")}`, conversa, mensagem_id: `M${seq}`, em: AGORA - dia * DIA, ferramenta: "wa_responder", rascunho, enviado, distancia: m.distancia, resumo: m.resumo, vista: false };
};
const regra = (texto: string, estado: Regra["estado"] = "recusada"): Regra => ({ id: "r_00000001", texto, escopo: "geral", origem: "edicoes", estado, criada_em: 0, entregue: 0 });

/** Cinco edições: o dono corta "Prezado" e "Abraço" de todas e encurta; numa, o rascunho não tinha "Prezado". */
const cinco = (): EdicaoGuardada[] => [
  edicao("Prezado, segue o contrato revisado para você conferir com calma. Abraço", "segue o contrato revisado"),
  edicao("Prezado, chego amanhã às oito no escritório central da empresa. Abraço", "chego amanhã às oito"),
  edicao("Prezado, o boleto já foi enviado para o seu e-mail cadastrado. Abraço", "boleto enviado"),
  edicao("Prezado, a reunião ficou para quinta-feira de manhã bem cedo. Abraço", "reunião quinta cedo"),
  edicao("Olá, a planilha está pronta e já compartilhada com toda a equipe. Abraço", "planilha pronta"),
];

describe("0.14.0: candidatos a regra pelas edições", () => {
  it("menos de 5 edições não mínimas: nenhum candidato, e diz quantas faltam", () => {
    const r = candidatosDasEdicoes(cinco().slice(0, 3), {}, []);
    assert.deepEqual([r.edicoes_nao_minimas, r.faltam, r.candidatos.length], [3, 2, 0]);
  });

  it("trechos cortados (4 de 4 rascunhos com 'prezado', 5 de 5 com 'abraço'), hábitos (encurta, tira fecho), ids e escopo", () => {
    const eds = cinco();
    const r = candidatosDasEdicoes(eds, {}, []);
    assert.equal(r.faltam, 0);
    const porTexto = Object.fromEntries(r.candidatos.map((c) => [c.texto_sugerido, c]));
    const prezado = porTexto["não usar 'prezado'"]!;
    assert.deepEqual([prezado.tipo, prezado.edicoes_que_sustentam, prezado.proporcao, prezado.escopo], ["trecho_cortado", 4, 1, "conversa"], "todas da Ana: escopo conversa");
    assert.equal(prezado.edicoes.length, 4);
    assert.ok(porTexto["não usar 'abraço'"], "abraço cortado nas 5");
    assert.ok(!r.candidatos.some((c) => c.trecho === "o" || c.trecho === "a"), "palavra comum sozinha não");
    const encurta = r.candidatos.find((c) => c.habito === "encurta")!;
    assert.equal(encurta.edicoes_que_sustentam, 5);
    assert.match(encurta.texto_sugerido, /^respostas mais curtas: o dono corta cerca de \d+% do texto$/);
    assert.ok(r.candidatos.some((c) => c.habito === "tira_fecho"));
    assert.ok(r.candidatos.length <= 10);
    // Ordem: do mais sustentado para o menos.
    const sustento = r.candidatos.map((c) => c.edicoes_que_sustentam);
    assert.deepEqual(sustento, [...sustento].sort((a, b) => b - a));
    // Id estável: o mesmo nas duas chamadas.
    assert.equal(candidatosDasEdicoes(eds, {}, []).candidatos.find((c) => c.texto_sugerido === "não usar 'prezado'")!.id, prezado.id);
  });

  it("sobrepostos se juntam no maior; abaixo de 60% não entra; trecho posto; escopo tipo e geral", () => {
    const eds = [
      edicao("fico no aguardo do retorno, ok", "ok", pn(ANA)),
      edicao("fico no aguardo, combinado", "combinado", pn(BETO)),
      edicao("certo, fico no aguardo", "certo", pn(ANA)),
      edicao("fico no aguardo então", "fico no aguardo então valeu", pn(BETO)),
      edicao("pode ser amanhã", "pode ser amanhã valeu", pn(ANA)),
      edicao("vou ver", "vou ver valeu", pn(BETO)),
    ];
    const r = candidatosDasEdicoes(eds, { [pn(ANA)]: "Cliente", [pn(BETO)]: "cliente" }, []);
    const cortados = r.candidatos.filter((c) => c.tipo === "trecho_cortado").map((c) => c.trecho);
    // "fico no aguardo" cortado em 3 de 4 (75%): fica o maior; "no aguardo", "aguardo" e "fico" saem.
    assert.ok(cortados.includes("fico no aguardo"), JSON.stringify(cortados));
    assert.ok(!cortados.includes("aguardo") && !cortados.includes("no aguardo"));
    const posto = r.candidatos.find((c) => c.tipo === "trecho_posto" && c.trecho === "valeu")!;
    assert.deepEqual([posto.edicoes_que_sustentam, posto.texto_sugerido, posto.escopo, String(posto.tipo_da_conversa).toLowerCase()], [3, "usar 'valeu'", "tipo", "cliente"], "Cliente e cliente são o mesmo tipo");
    const semTipo = candidatosDasEdicoes(eds, {}, []);
    assert.equal(semTipo.candidatos.find((c) => c.trecho === "valeu")!.escopo, "geral");
  });

  it("regra que já existe (inclusive recusada) não volta como candidato", () => {
    const r = candidatosDasEdicoes(cinco(), {}, [regra("Não usar 'prezado'."), regra("respostas mais curtas: o dono corta cerca de 70% do texto", "ativa")]);
    assert.ok(!r.candidatos.some((c) => c.texto_sugerido === "não usar 'prezado'"));
    assert.ok(!r.candidatos.some((c) => c.habito === "encurta"), "a porcentagem pode mudar: compara pelo começo");
    assert.ok(r.candidatos.some((c) => c.texto_sugerido === "não usar 'abraço'"));
  });
});

describe("0.14.0: candidatos nas ferramentas", () => {
  let m: Montagem | undefined;
  let fechar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await fechar?.();
    fechar = undefined;
    await m?.fechar();
    m = undefined;
  });

  it("wa_edicoes_dos_rascunhos traz `candidatos`; wa_aprender `propor` com `candidato` vira PROPOSTA e o candidato some", async () => {
    m = await montar({ agora: () => AGORA, pareada: false });
    await m.ctx.partida();
    const { banco } = await m.ctx.nucleo();
    for (const [i, e] of cinco().entries()) banco.guardarEnvioDeRascunho({ conversa: pn(ANA), mensagem_id: `X${i}`, ferramenta: "wa_responder", rascunho: e.rascunho, enviado: e.enviado, em: AGORA - (i + 1) * DIA });
    const c = await conectarCliente(m.ctx);
    fechar = c.fechar;
    const lidas = await chamar(c.cliente, "wa_edicoes_dos_rascunhos");
    const candidatos = lidas.candidatos as Obj[];
    const prezado = candidatos.find((x) => x.texto_sugerido === "não usar 'prezado'")!;
    assert.equal(prezado.escopo_sugerido, "conversa");
    assert.match(String(prezado.conversa), /^c_[0-9a-f]{12}$/);
    assert.ok(!JSON.stringify(candidatos).includes("@s.whatsapp.net"));
    assert.match(String(lidas.para_o_claude), /candidato/);
    const r = await chamar(c.cliente, "wa_aprender", { propor: [{ candidato: prezado.id }] });
    const proposta = (r.propostas as Obj[])[0]!;
    assert.equal(banco.regras()[0]!.estado, "proposta", "não vira ativa sem o sim do dono");
    assert.equal(banco.regras()[0]!.texto, "não usar 'prezado'");
    assert.equal(banco.regras()[0]!.escopo, "conversa");
    assert.ok(proposta.id);
    const depois = await chamar(c.cliente, "wa_edicoes_dos_rascunhos");
    assert.ok(!(depois.candidatos as Obj[]).some((x) => x.id === prezado.id), "a regra já existe: o candidato some");
    const sumiu = await chamar(c.cliente, "wa_aprender", { propor: [{ candidato: prezado.id }] });
    assert.match(String((sumiu.recusados as Obj[])[0]!.motivo), /não existe mais/);
    // Com 3 edições, ainda não: diz quantas faltam.
    await fechar();
    fechar = undefined;
  });
});

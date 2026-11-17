// 0.14.0, Parte C: wa_conferir_rascunho. A conta pura (src/conferencia.ts): cada desvio com um caso feito à mão e o
// rascunho que fica "dentro do normal"; a ferramenta: perfil das respostas da conversa (20+), senão do lado; regra
// "não usar 'X'" violada; regras a conferir; aprendizado desligado; o rascunho sensível não vai para log, registro nem
// caixa-preta; e roda na cópia leitora (WA_LEITURA_LOCAL=1).

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { conferirContraOJeito, formalidadesNo, proibidoDaRegra, violaProibido } from "../src/conferencia.ts";
import { amostraDe } from "../src/jeito.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { ANA, BETO, chamar, conectarCliente, montar, pn, type Montagem } from "./ajuda.ts";

type Obj = Record<string, unknown>;
const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
let seq = 0;
const eu = (texto: string, ts: number): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto });
const ela = (texto: string, ts: number): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto });

/** O dono: minúscula, sem ponto, sem emoji, sem "!", curto (até 5 palavras), abre com "oi" e fecha com "valeu". */
const FALAS = [
  "oi pode ser amanhã", "vou ver aqui", "fechado valeu", "oi tá certo", "consigo sim valeu", "pode deixar", "oi beleza então",
  "tô no trânsito", "manda ver valeu", "certo", "oi chego já", "top valeu", "sem pressa", "oi combinado", "pode ser",
  "falo com eles valeu", "oi tranquilo", "tá bom", "beleza valeu", "oi já vi", "massa", "vou sim valeu",
];
/** Cada fala do dono vem 1 min depois de uma recebida: todas são `resposta`. */
const respostas = (inicio: number): MensagemGuardada[] => FALAS.flatMap((t, i) => [ela(`TERCEIRO ${i}`, inicio + i * DIA), eu(t, inicio + i * DIA + 60_000)]);

describe("0.14.0: a conta do conferir (pura)", () => {
  const a = amostraDe(respostas(AGORA - 30 * DIA));

  it("rascunho no jeito do dono: nenhum desvio", () => {
    assert.equal(a.mensagens, 22);
    assert.deepEqual(conferirContraOJeito(["oi pode ser"], a, new Set()), []);
  });

  it("cada desvio, um caso: palavras acima do p90, maiúscula, ponto, '!', emoji, saudação, fecho, formalidade", () => {
    const d = conferirContraOJeito(["Prezado, bom dia! Segue o orçamento completo do projeto que conversamos ontem 😀. Atenciosamente."], a, new Set());
    const medidas = d.map((x) => x.medida).sort();
    assert.deepEqual(medidas, ["emoji", "exclamacao", "fecho", "formalidade", "formalidade", "inicial_maiuscula", "palavras_por_mensagem", "ponto_final", "saudacao"].sort());
    const palavras = d.find((x) => x.medida === "palavras_por_mensagem")!;
    assert.deepEqual([palavras.rascunho, palavras.normal_do_dono], [13, 3]);
    // A formalidade que o dono já usou não é desvio.
    const comPrezado = conferirContraOJeito(["oi prezado"], a, new Set(["prezado"]));
    assert.ok(!comPrezado.some((x) => x.medida === "formalidade"));
  });

  it("quebra: uma mensagem só de 21+ palavras, quando ele quebra 40%+ das rajadas longas (3+)", () => {
    const longa = "uma duas tres quatro cinco seis sete oito nove dez onze doze treze catorze quinze dezesseis dezessete dezoito dezenove vinte";
    const msgs: MensagemGuardada[] = [];
    for (let i = 0; i < 3; i++) msgs.push(ela("pergunta", AGORA - (10 - i) * DIA), eu(`${longa} vinte e um`.slice(0, 60), AGORA - (10 - i) * DIA + 60_000), eu(`${longa} fim`, AGORA - (10 - i) * DIA + 90_000));
    const q = amostraDe(msgs);
    assert.deepEqual([q.rajadasLongas, q.rajadasLongasQuebradas], [3, 3]);
    const d = conferirContraOJeito([`${longa} vinte e um`], q, new Set());
    assert.ok(d.some((x) => x.medida === "quebra_em_mensagens"));
    assert.ok(!conferirContraOJeito([longa.slice(0, 40), longa.slice(41)], q, new Set()).some((x) => x.medida === "quebra_em_mensagens"), "já vem em duas");
  });

  it("regra 'não usar X': o proibido sai do texto da regra e casa como palavra inteira, sem acento e sem caixa", () => {
    assert.equal(proibidoDaRegra("Não usar 'prezado'"), "prezado");
    assert.equal(proibidoDaRegra("nao escreva \"fico à disposição\" no fim"), "fico à disposição");
    assert.equal(proibidoDaRegra("respostas mais curtas"), undefined);
    assert.equal(violaProibido(["PREZADO João"], "prezado"), true);
    assert.equal(violaProibido(["prezados"], "prezado"), false);
    assert.equal(violaProibido(["fico a disposicao"], "fico à disposição"), true);
    assert.deepEqual(formalidadesNo("Fico à disposição. Cordialmente"), ["cordialmente", "fico a disposicao"]);
  });
});

describe("0.14.0: wa_conferir_rascunho", () => {
  let m: Montagem | undefined;
  let fechar: (() => Promise<void>) | undefined;
  let restaurarLog: (() => void) | undefined;
  afterEach(async () => {
    restaurarLog?.();
    restaurarLog = undefined;
    await fechar?.();
    fechar = undefined;
    await m?.fechar();
    m = undefined;
  });

  async function cenario(caixa: string[] = []) {
    m = await montar({ agora: () => AGORA, pareada: false, caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(l) }) });
    await m.ctx.partida();
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), respostas(AGORA - 40 * DIA));
    banco.gravarMensagens(pn(BETO), [ela("oi", AGORA - DIA), eu("Bom dia. Tudo certo.", AGORA - DIA + 60_000)]);
    const c = await conectarCliente(m.ctx);
    fechar = c.fechar;
    return { c: c.cliente, banco };
  }

  it("perfil das respostas da conversa; desvios, resumo, regras violadas e a conferir", async () => {
    const { c, banco } = await cenario();
    const ok = await chamar(c, "wa_conferir_rascunho", { conversa: ANA, texto: "oi pode ser" });
    assert.deepEqual(ok.perfil_usado, { de: "conversa", tipo_de_mensagem: "resposta", mensagens_medidas: 22 });
    assert.deepEqual([ok.desvios, ok.regras_violadas, ok.resumo], [[], [], "dentro do seu normal"]);
    await chamar(c, "wa_aprender", { regra_do_dono: { texto: "não usar 'prezado'", escopo: "geral" } });
    await chamar(c, "wa_aprender", { regra_do_dono: { texto: "falar do prazo antes do preço", escopo: "conversa", conversa: ANA } });
    const r = await chamar(c, "wa_conferir_rascunho", { conversa: ANA, mensagens: ["Prezado, segue.", "valeu"] });
    const medidas = (r.desvios as Obj[]).map((d) => d.medida);
    assert.ok(medidas.includes("inicial_maiuscula") && medidas.includes("ponto_final") && medidas.includes("formalidade"), JSON.stringify(medidas));
    assert.equal((r.regras_violadas as Obj[]).length, 1);
    assert.equal((r.regras_violadas as Obj[])[0]!.proibido, "prezado");
    assert.deepEqual((r.regras_a_conferir as Obj[]).map((x) => (x.anotacao_da_ia as Obj).texto), ["falar do prazo antes do preço"]);
    assert.equal(r.resumo, `${medidas.length + 1} desvios`);
    // Beto tem 1 mensagem: cai para o lado (individuais), respostas somadas (Ana + Beto = 23).
    const beto = await chamar(c, "wa_conferir_rascunho", { conversa: BETO, texto: "oi" });
    assert.deepEqual(beto.perfil_usado, { de: "individuais", tipo_de_mensagem: "resposta", mensagens_medidas: 23 });
    // Desligado: não confere.
    await chamar(c, "wa_aprender", { ligar: false });
    assert.equal((await chamar(c, "wa_conferir_rascunho", { conversa: ANA, texto: "oi" })).ligado, false);
  });

  it("o rascunho sensível não vai para log, registro de ações nem caixa-preta; o banco não guarda", async () => {
    const log: string[] = [];
    restaurarLog = trocarSaidaDoLog((l) => log.push(l));
    const caixa: string[] = [];
    const { c, banco } = await cenario(caixa);
    const SEGREDO = "RASCUNHO-SIGILOSO-7731 senha do cofre";
    const r = await chamar(c, "wa_conferir_rascunho", { conversa: ANA, texto: `Prezado, ${SEGREDO}.` });
    assert.ok(!JSON.stringify(r).includes("SIGILOSO"), "nem a resposta repete o rascunho");
    await chamar(c, "wa_conferir_rascunho", { conversa: ANA, mensagens: [SEGREDO, "ok"] });
    await m!.ctx.transporte?.esperar();
    const registro = existsSync(m!.caminhoRegistro) ? readFileSync(m!.caminhoRegistro, "utf8") : "";
    for (const [onde, texto] of [["log", log.join("\n")], ["caixa-preta", caixa.join("\n")], ["registro", registro]] as const) {
      assert.ok(!texto.includes("SIGILOSO") && !texto.includes("senha do cofre"), `o rascunho apareceu em ${onde}`);
    }
    assert.ok(!JSON.stringify(banco.edicoes()).includes("SIGILOSO"));
    assert.ok(!JSON.stringify(banco.lerMensagens(pn(ANA))).includes("SIGILOSO"));
  });

  it("roda na cópia leitora com WA_LEITURA_LOCAL=1, com o mesmo resultado", async () => {
    const { c } = await cenario();
    const args = { conversa: ANA, texto: "Prezado, segue o orçamento." };
    const doDono = await chamar(c, "wa_conferir_rascunho", args);
    const antes = process.env.WA_LEITURA_LOCAL;
    process.env.WA_LEITURA_LOCAL = "1";
    const leitor = await montar({ dir: m!.dir, pareada: false, agora: () => AGORA });
    try {
      await leitor.ctx.partida();
      assert.equal(leitor.ctx.ehLeitor, true);
      const cli = await conectarCliente(leitor.ctx);
      try {
        const local = await chamar(cli.cliente, "wa_conferir_rascunho", args);
        assert.deepEqual(local, doDono);
        const jeito = await chamar(cli.cliente, "wa_meu_jeito", { tipo_de_mensagem: "resposta" });
        assert.ok(jeito);
        const ex = await chamar(cli.cliente, "wa_exemplos_do_meu_jeito", { conversa: ANA, tipo_de_mensagem: "qualquer" });
        assert.ok((ex.exemplos as Obj[]).length > 0);
      } finally {
        await cli.fechar();
      }
    } finally {
      if (antes === undefined) delete process.env.WA_LEITURA_LOCAL;
      else process.env.WA_LEITURA_LOCAL = antes;
      await leitor.ctx.encerrar();
    }
  });
});

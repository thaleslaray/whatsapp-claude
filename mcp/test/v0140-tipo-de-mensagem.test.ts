// 0.14.0, Parte A: o tipo de cada rajada do dono (src/tipo-de-mensagem.ts), por regra, com casos conferíveis à mão
// para cada regra e para a ordem; a amostra do aviso com o link virando marcador; e o uso nas ferramentas
// (wa_meu_jeito com `por_tipo_de_mensagem` e `tipo_de_mensagem`; wa_exemplos_do_meu_jeito só com respostas por padrão,
// `aviso`, `qualquer` e o completar com `outra`). Banco de verdade em pasta temporária, sem rede, relógio fixo.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Banco, MensagemGuardada } from "../src/banco.ts";
import { medirConversa } from "../src/jeito.ts";
import { classificarRajadas } from "../src/tipo-de-mensagem.ts";
import { chamar, conectarCliente, GRUPO, montar, type Montagem } from "./ajuda.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const T0 = AGORA - 30 * 86_400_000;
const MIN = 60_000;
let seq = 0;
const ela = (texto: string, min: number, id = `R${++seq}`): MensagemGuardada => ({ id, ts: T0 + min * MIN, de_mim: false, tipo: "texto", texto });
const eu = (texto: string, min: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `E${++seq}`, ts: T0 + min * MIN, de_mim: true, tipo: "texto", texto, ...o });
const tiposDe = (mensagens: MensagemGuardada[], grupo = true) => classificarRajadas(mensagens, { grupo }).map((r) => r.tipo);
const palavras = (n: number, extra = "") => `${extra} ${Array.from({ length: n }, (_, i) => `palavra${String.fromCharCode(97 + (i % 26))}`).join(" ")}`.trim();

describe("0.14.0: tipo de mensagem, regra por regra", () => {
  it("resposta: par (sequência), citação de outra pessoa, e em individual até 10 min depois de recebida", () => {
    assert.deepEqual(tiposDe([ela("qual o horário?", 0), eu("às 19h", 2)]), ["resposta"]);
    assert.deepEqual(tiposDe([ela("ok pessoal", 0, "Q1"), eu("perfeito", 40, { citada: { id: "Q1" } })]), ["resposta"], "cita mensagem de outra pessoa (mesmo sem pergunta)");
    assert.deepEqual(tiposDe([ela("bom dia", 0), eu("bom dia pra você também", 10)], false), ["resposta"], "individual: 10 min vale");
    assert.deepEqual(tiposDe([ela("bom dia", 0), eu("bom dia pra você também", 11)], false), ["outra"], "individual: 11 min não");
    assert.deepEqual(tiposDe([ela("bom dia", 0), eu("bom dia pra você também", 5)], true), ["outra"], "em grupo, só por par ou citação");
  });

  it("aviso (só em grupo): link, menção a todos, horário/data com mais de 15 palavras, texto longo depois de 6 h calado", () => {
    assert.deepEqual(tiposDe([eu("material novo: https://drive.exemplo.com/abc", 0)]), ["aviso"]);
    assert.deepEqual(tiposDe([eu("material novo: https://drive.exemplo.com/abc", 0)], false), ["outra"], "em individual não existe aviso");
    assert.deepEqual(tiposDe([eu("detalhes aqui all", 0)]), ["aviso"], "'all' em qualquer lugar");
    assert.deepEqual(tiposDe([eu("Pessoal, amanhã não tem aula", 0)]), ["aviso"], "começa com 'pessoal'");
    assert.deepEqual(tiposDe([eu("@todos atenção", 0)]), ["aviso"]);
    assert.deepEqual(tiposDe([eu("valeu a todos", 0)]), ["outra"], "'todos' só conta no começo");
    assert.deepEqual(tiposDe([eu(palavras(15, "hoje às 19h"), 0)]), ["aviso"], "horário com 18 palavras");
    assert.deepEqual(tiposDe([eu(palavras(10, "sexta"), 0)]), ["outra"], "dia da semana com 11 palavras: curto demais");
    // Silêncio de 6 h: a primeira do dono na conversa, com 26 palavras, é aviso; com uma do dono 1 h antes, não.
    assert.deepEqual(tiposDe([eu(palavras(26), 0)]), ["aviso"]);
    assert.deepEqual(tiposDe([eu("bom dia", 0), ela("oi", 30), eu(palavras(26), 60)]), ["outra", "outra"]);
    assert.deepEqual(tiposDe([eu("bom dia", 0), ela("oi", 30), eu(palavras(26), 6 * 60)]), ["outra", "aviso"], "6 h inclusive");
    assert.deepEqual(tiposDe([eu(palavras(25), 0)]), ["outra"], "25 palavras não passam de 25");
  });

  it("pergunta, confirmação e outra", () => {
    assert.deepEqual(tiposDe([eu("vocês receberam o material? 🙂", 0)]), ["pergunta"]);
    assert.deepEqual(tiposDe([eu("Quando vocês podem fazer a prova", 0)]), ["pergunta"], "começa com interrogativa");
    assert.deepEqual(tiposDe([eu("show", 0), ela("x", 10), eu("ok, obrigado, abraço", 20), ela("y", 30), eu("👍", 40), ela("z", 50), eu("isso", 60)]), ["confirmacao", "confirmacao", "confirmacao", "confirmacao"]);
    assert.deepEqual(tiposDe([eu("ok obrigado abraço valeu", 0)]), ["outra"], "4 palavras: passa de 3");
    assert.deepEqual(tiposDe([eu("estou chegando", 0)]), ["outra"]);
  });

  it("ordem: resposta antes de aviso (resposta com link), aviso antes de pergunta, pergunta antes de confirmação", () => {
    assert.deepEqual(tiposDe([ela("qual o link?", 0), eu("https://drive.exemplo.com/abc", 1)]), ["resposta"]);
    assert.deepEqual(tiposDe([eu("pessoal, vocês viram o recado?", 0)]), ["aviso"]);
    assert.deepEqual(tiposDe([eu("pode?", 0)]), ["pergunta"], "'pode' é de concordância, mas com '?' é pergunta");
  });

  it("a rajada é a unidade (mensagens do dono em até 2 min, sem outra pessoa no meio); o aviso mede a forma com o link como um token", () => {
    const msgs = [eu("aula de hoje", 0), eu("https://meet.exemplo.com/xyz", 1), ela("valeu", 1.5), eu("de nada", 2)];
    assert.deepEqual(classificarRajadas(msgs, { grupo: true }).map((r) => [r.tipo, r.posicoes]), [["aviso", [0, 1]], ["confirmacao", [3]]]);
    const d = medirConversa(msgs, true);
    assert.equal(d.amostra.mensagens, 2, "fora o link: 'aula de hoje' e 'de nada'");
    assert.equal(d.porTipo.aviso.mensagens, 2, "no aviso, a mensagem só de link entra, com o marcador");
    assert.deepEqual(d.porTipo.aviso.palavras, [3, 1]);
    assert.deepEqual(d.contagemPorTipo.aviso, { rajadas: 1, mensagens: 2 });
    assert.deepEqual(d.contagemPorTipo.confirmacao, { rajadas: 1, mensagens: 1 });
    assert.ok(!JSON.stringify(d.porTipo.aviso.vocabulario).includes("meet"), "o link não vira vocabulário");
  });
});

describe("0.14.0: tipo de mensagem nas ferramentas", () => {
  let m: Montagem | undefined;
  let fechar: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await fechar?.();
    fechar = undefined;
    await m?.fechar();
    m = undefined;
  });

  async function cenario(semear: (b: Banco) => void): Promise<Cliente> {
    m = await montar({ agora: () => AGORA, pareada: false });
    await m.ctx.partida();
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    semear(banco);
    const c = await conectarCliente(m.ctx);
    fechar = c.fechar;
    return c.cliente;
  }
  // Grupo: 3 respostas (a perguntas), 2 avisos (um com link), 1 confirmação solta, 1 outra.
  const grupoMisto = (b: Banco) =>
    b.gravarMensagens(GRUPO, [
      ela("qual o horário da aula?", 0), eu("começa às 19h", 2),
      ela("onde vejo a gravação?", 600), eu("fica no drive da turma", 602),
      ela("tem prova?", 1_200), eu("tem sim, semana que vem", 1_202),
      eu("aula de hoje: https://meet.exemplo.com/abc", 2_000),
      ela("TERCEIRO", 2_500), eu("detalhes aqui all", 2_600),
      ela("TERCEIRO 2", 3_000), eu("show", 3_100),
      ela("TERCEIRO 3", 3_500), eu("vou separar o material", 3_600),
    ]);

  it("wa_meu_jeito: por_tipo_de_mensagem (contagens, e o perfil de resposta e de aviso) e o parâmetro tipo_de_mensagem", async () => {
    const c = await cenario(grupoMisto);
    const r = await chamar(c, "wa_meu_jeito");
    const pt = (r.grupos as Obj).por_tipo_de_mensagem as Obj;
    assert.deepEqual(pt.rajadas, { resposta: 3, aviso: 2, pergunta: 0, confirmacao: 1, outra: 1 });
    assert.equal((pt.resposta as Obj).mensagens_medidas, 3);
    assert.equal((pt.aviso as Obj).mensagens_medidas, 2, "o aviso com link entra no perfil do aviso");
    assert.equal(((r.grupos as Obj).mensagens_medidas as number), 6, "o perfil de tudo continua sem a mensagem com link");
    assert.match(String(r.para_o_claude), /por_tipo_de_mensagem\.resposta/);
    const so = await chamar(c, "wa_meu_jeito", { tipo_de_mensagem: "aviso" });
    assert.equal(so.tipo_de_mensagem, "aviso");
    assert.equal((so.grupos as Obj).mensagens_medidas, 2);
    assert.equal((so.grupos as Obj).por_tipo_de_mensagem, undefined);
    const daConversa = await chamar(c, "wa_meu_jeito", { conversa: GRUPO, tipo_de_mensagem: "resposta" });
    assert.equal((daConversa.perfil as Obj).mensagens_medidas, 3);
  });

  it("wa_exemplos_do_meu_jeito: só respostas por padrão; aviso (com o link do dono); qualquer", async () => {
    const c = await cenario(grupoMisto);
    const padrao = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 3 });
    assert.equal(padrao.tipo_de_mensagem, "resposta");
    assert.deepEqual((padrao.exemplos as Obj[]).map((e) => e.tipo_de_mensagem), ["resposta", "resposta", "resposta"]);
    assert.equal(padrao.completado_com_outra, undefined);
    const avisos = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 3, tipo_de_mensagem: "aviso" });
    const textos = (avisos.exemplos as Obj[]).flatMap((e) => e.mensagens as string[]);
    assert.deepEqual(textos.sort(), ["aula de hoje: https://meet.exemplo.com/abc", "detalhes aqui all"]);
    assert.match(String(avisos.para_o_claude), /AVISOS do dono/);
    const tudo = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 10, tipo_de_mensagem: "qualquer" });
    assert.deepEqual(new Set((tudo.exemplos as Obj[]).map((e) => e.tipo_de_mensagem)), new Set(["resposta", "aviso", "confirmacao", "outra"]));
  });

  it("menos de 3 respostas na origem: completa com `outra` e diz", async () => {
    const c = await cenario((b) =>
      b.gravarMensagens(GRUPO, [ela("tem aula?", 0), eu("tem", 1), ela("A", 100), eu("estou separando a lista", 101), ela("B", 200), eu("depois eu vejo isso", 201), ela("C", 300), eu("show", 301)]),
    );
    const r = await chamar(c, "wa_exemplos_do_meu_jeito", { conversa: GRUPO, quantos: 3 });
    assert.deepEqual((r.exemplos as Obj[]).map((e) => e.tipo_de_mensagem).sort(), ["outra", "outra", "resposta"], "confirmação não completa, só outra");
    assert.equal(r.completado_com_outra, true);
    assert.match(String(r.para_o_claude), /poucas respostas/);
  });
});

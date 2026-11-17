// 0.13.0: pares pergunta -> resposta do dono (src/pares.ts), função pura: citada, sequência com "?" e com palavra
// interrogativa, limite de 10 minutos, mais de 2 mensagens de terceiros no meio em grupo (não vale; em individual,
// vale), outra mensagem do dono no meio, rajada encerrada por mensagem de terceiro, pedaços da rajada por citação,
// rascunho da IA marcado, mensagem de máquina fora, e os textos da resposta (6 mensagens, 800 caracteres).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MensagemGuardada } from "../src/banco.ts";
import { ehPergunta, paresDe, textosDaResposta } from "../src/pares.ts";

const T0 = Date.UTC(2026, 10, 1, 12, 0);
const MIN = 60_000;
let seq = 0;
const ela = (texto: string, min: number, id = `R${++seq}`): MensagemGuardada => ({ id, ts: T0 + min * MIN, de_mim: false, tipo: "texto", texto });
const eu = (texto: string, min: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `E${++seq}`, ts: T0 + min * MIN, de_mim: true, tipo: "texto", texto, ...o });
const resumo = (mensagens: MensagemGuardada[], grupo = false) => {
  const textoDe = new Map(mensagens.map((m) => [m.id, m.texto]));
  return paresDe(mensagens, { grupo }).map((p) => ({ pergunta: textoDe.get(p.pergunta_id), resposta: p.resposta_ids.map((id) => textoDe.get(id)), ligacao: p.ligacao, ...(p.rascunho_da_ia ? { ia: p.rascunho_da_ia } : {}) }));
};

describe("0.13.0: o que é pergunta", () => {
  it("termina com ? (mesmo com emoji depois) ou tem palavra interrogativa, sem acento", () => {
    for (const t of ["vai ter aula amanhã?", "e aí? 🙂", "Como faço para entrar", "QUANDO começa", "onde fica", "qual o link", "quanto custa", "pode remarcar", "tem vaga", "consigo pagar no pix", "posso levar alguém", "cadê o material", "Cadê", "por que mudou"]) {
      assert.equal(ehPergunta(t), true, t);
    }
    for (const t of ["obrigado", "chego às 8", "comotal", "temporada boa", "porque sim", "", undefined]) assert.equal(ehPergunta(t), false, String(t));
  });
});

describe("0.13.0: pares", () => {
  it("citada: a mensagem do dono cita a pergunta, mesmo longe e com outras no meio; vale a citação, não a sequência", () => {
    const pergunta = ela("o material do módulo 2 já saiu", 0, "Q1");
    const r = resumo([pergunta, ela("outra coisa", 1), ela("mais outra", 2), ela("e mais uma", 3), eu("saiu sim, está na área de membros", 50, { citada: { id: "Q1" } })], true);
    assert.deepEqual(r, [{ pergunta: "o material do módulo 2 já saiu", resposta: ["saiu sim, está na área de membros"], ligacao: "citada" }]);
  });

  it("sequência com ? e com palavra interrogativa; a pergunta é a mais perto da resposta", () => {
    assert.deepEqual(resumo([ela("bom dia", 0), ela("a aula é às 19h?", 1), eu("é sim", 3), eu("até lá", 4)]), [{ pergunta: "a aula é às 19h?", resposta: ["é sim", "até lá"], ligacao: "sequencia" }]);
    assert.deepEqual(resumo([ela("quanto fica a mentoria", 0), eu("R$ 500 por mês", 2)]), [{ pergunta: "quanto fica a mentoria", resposta: ["R$ 500 por mês"], ligacao: "sequencia" }]);
    assert.deepEqual(resumo([ela("qual o horário?", 0), ela("e onde fica?", 1), eu("rua tal, 19h", 2)]).map((p) => p.pergunta), ["e onde fica?"]);
    // Sem cara de pergunta: não há par.
    assert.deepEqual(resumo([ela("obrigado pela aula", 0), eu("eu que agradeço", 1)]), []);
  });

  it("limite de 10 minutos (inclusive)", () => {
    assert.equal(resumo([ela("tem aula hoje?", 0), eu("tem", 10)]).length, 1, "10 min vale");
    assert.equal(resumo([ela("tem aula hoje?", 0), eu("tem", 10.5)]).length, 0, "passou de 10 min");
  });

  it("em grupo, até 2 mensagens de terceiros no meio; 3 não vale; em individual não há esse limite", () => {
    const comMeio = (n: number) => [ela("como acesso a gravação?", 0), ...Array.from({ length: n }, (_, i) => ela(`ok ${i}`, 1 + i * 0.1)), eu("está no drive", 3)];
    assert.equal(resumo(comMeio(2), true).length, 1, "2 no meio: vale");
    assert.equal(resumo(comMeio(3), true).length, 0, "3 no meio: não vale em grupo");
    assert.equal(resumo(comMeio(3), false).length, 1, "em individual, as do meio são da mesma pessoa");
  });

  it("outra mensagem do dono no meio: a segunda rajada não pega a pergunta", () => {
    const r = resumo([ela("onde é o evento?", 0), eu("no centro", 1), eu("ah, e começa às 9", 5)]);
    assert.deepEqual(r, [{ pergunta: "onde é o evento?", resposta: ["no centro"], ligacao: "sequencia" }]);
  });

  it("mensagem de terceiro encerra a rajada do dono (também em grupo)", () => {
    const r = resumo([ela("qual a senha do wifi?", 0), eu("é aluno2026", 1), ela("valeu", 1.5), eu("de nada", 2)], true);
    assert.deepEqual(r, [{ pergunta: "qual a senha do wifi?", resposta: ["é aluno2026"], ligacao: "sequencia" }]);
  });

  it("numa rajada, cada citação começa um par; as seguintes sem citação ficam com ela", () => {
    const r = resumo([ela("pode pagar no cartão", 0, "QA"), ela("tem certificado", 1, "QB"), eu("pode sim", 2, { citada: { id: "QA" } }), eu("em até 12x", 2.5), eu("tem, ao final", 3, { citada: { id: "QB" } })], true);
    assert.deepEqual(r, [
      { pergunta: "pode pagar no cartão", resposta: ["pode sim", "em até 12x"], ligacao: "citada" },
      { pergunta: "tem certificado", resposta: ["tem, ao final"], ligacao: "citada" },
    ]);
  });

  it("citação de mensagem do próprio dono ou não guardada não é par; rascunho da IA vem marcado; áudio sem texto não é resposta", () => {
    assert.deepEqual(resumo([eu("lembrete", 0), eu("como eu disse", 1, { citada: { id: "nao-guardada" } })]), []);
    assert.deepEqual(resumo([ela("tem aula?", 0), eu("Sim, às 19h.", 1, { rascunho_da_ia: "sem_edicao" })]), [{ pergunta: "tem aula?", resposta: ["Sim, às 19h."], ligacao: "sequencia", ia: "sem_edicao" }]);
    assert.equal(resumo([ela("tem aula?", 0), eu("Sim, às 19h.", 1, { rascunho_da_ia: "editado" })])[0]!.ia, undefined, "editada pelo dono é dele");
    assert.deepEqual(resumo([ela("tem aula?", 0), { id: "AU", ts: T0 + MIN, de_mim: true, tipo: "nota_de_voz" }]), []);
  });

  it("mensagem de máquina (texto igual repetido 5+ vezes) não é resposta", () => {
    const robo = "Olá! Recebemos a sua mensagem e logo um atendente vai responder, obrigado.";
    const msgs: MensagemGuardada[] = [];
    for (let i = 0; i < 5; i++) msgs.push(ela(`tem vaga ${i}?`, i * 30), eu(robo, i * 30 + 1));
    assert.deepEqual(resumo(msgs), []);
  });

  it("textos da resposta: até 6 mensagens e 800 caracteres; a primeira longa sai cortada", () => {
    assert.deepEqual(textosDaResposta(["a", "b", "c", "d", "e", "f", "g"]), { mensagens: ["a", "b", "c", "d", "e", "f"], cortada: true });
    const r = textosDaResposta(["x".repeat(500), "y".repeat(400)]);
    assert.deepEqual(r, { mensagens: ["x".repeat(500)], cortada: true });
    const longa = textosDaResposta(["z".repeat(900)]);
    assert.equal(longa.mensagens[0], `${"z".repeat(800)}…`);
    assert.deepEqual(textosDaResposta(["oi", "tudo certo"]), { mensagens: ["oi", "tudo certo"], cortada: false });
  });
});

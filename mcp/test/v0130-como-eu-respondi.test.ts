// 0.13.0: wa_como_eu_respondi (Parte B) contra o banco de verdade (pasta temporária, sem rede, relógio fixo): acha por
// palavras parecidas, ordem forte antes de fraca, filtros (conversa, tipo, so_grupos, limite), exclusão do rascunho da
// IA e a opção de incluir (marcado), marcação de terceiros (pergunta em conteudo_de_terceiros, telefone mascarado,
// remetente com participante e número mascarado), resposta do dono com link e valor, aviso de resposta velha, a
// varredura (sem node:sqlite), o desligado e as contagens de pares no wa_meu_jeito.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Banco, MensagemGuardada } from "../src/banco.ts";
import { ANA, BETO, chamar, conectarCliente, GRUPO, montar, pn, type Montagem } from "./ajuda.ts";

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
const GABI = "5561944443333";
const TELEFONE_DO_ALUNO = "11 98888-7777";

const ela = (id: string, texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id, ts, de_mim: false, tipo: "texto", texto, ...o });
const eu = (id: string, texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id, ts, de_mim: true, tipo: "texto", texto, ...o });
const doBeto = { participante: pn(BETO), remetente: { nome: "Beto", numero: BETO } };

async function cenario(opcoes: { carregarSqlite?: () => undefined } = {}): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar({ agora: () => AGORA, pareada: false, ...opcoes });
  await m.ctx.partida();
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  const g30 = AGORA - 30 * DIA;
  const g5 = AGORA - 5 * DIA;
  const g2 = AGORA - 2 * DIA;
  banco.gravarMensagens(GRUPO, [
    // Citada (forte), há 30 dias: a resposta tem link e valor (pode, é a resposta do dono).
    ela("Q-CITADA", "Qual o prazo para entregar o trabalho final da turma", g30, doBeto),
    ela("X1", "alguém sabe?", g30 + MIN, doBeto),
    eu("A-CITADA", "O prazo é dia 20, pelo formulário https://forms.exemplo.com/entrega", g30 + 40 * MIN, { citada: { id: "Q-CITADA" } }),
    eu("A-CITADA-2", "multa de R$ 50 depois disso", g30 + 41 * MIN),
    // Sequência (fraca), há 5 dias.
    ela("Q-SEQ", "o prazo do trabalho final foi adiado?", g5, doBeto),
    eu("A-SEQ", "foi sim, agora é dia 30", g5 + 3 * MIN),
    // Pergunta com telefone de terceiro (fraca), há 2 dias.
    ela("Q-TEL", `meu número é ${TELEFONE_DO_ALUNO}, me liga sobre o prazo do trabalho final?`, g2, doBeto),
    eu("A-TEL", "melhor falar por aqui mesmo", g2 + 2 * MIN),
    // Parecida, mas sem resposta do dono ligada.
    ela("Q-SEM", "prazo do trabalho final é quando mesmo", g2 + DIA),
  ]);
  // Individual, há 100 dias (velha: mais de 60 dias).
  banco.gravarMensagens(pn(ANA), [ela("Q-ANA", "qual o prazo de entrega do trabalho final?", AGORA - 100 * DIA), eu("A-ANA", "entrega até sexta", AGORA - 100 * DIA + 5 * MIN)]);
  // Individual respondida por rascunho da IA aceito sem edição: fica fora, a não ser pedida.
  banco.gravarMensagens(pn(GABI), [ela("Q-GABI", "prazo do trabalho final?", AGORA - 3 * DIA), eu("A-GABI", "O prazo é sexta-feira.", AGORA - 3 * DIA + MIN, { rascunho_da_ia: "sem_edicao" })]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const respondi = (c: Cliente, args: Obj) => chamar(c, "wa_como_eu_respondi", args);
const lista = (r: Obj) => r.respostas as Array<{ ligacao: string; conversa: Obj; ha_dias: number; data: string; pergunta: Obj; resposta: { mensagens: string[]; rascunho_da_ia?: string } }>;
const perguntaDe = (x: { pergunta: Obj }) => String(x.pergunta.mensagem_id);

describe("0.13.0: wa_como_eu_respondi", () => {
  it("acha por palavras parecidas; forte antes de fraca; terceiros marcados; resposta com link e valor; resposta velha avisada", async () => {
    const { c } = await cenario();
    const r = await respondi(c, { pergunta: "até quando dá para entregar o trabalho final?", limite: 10 });
    assert.equal(r.caminho, "indice");
    const itens = lista(r);
    assert.deepEqual(itens.map(perguntaDe), ["Q-CITADA", ...itens.slice(1).map(perguntaDe)], "a citada vem primeiro");
    const ligacoes = itens.map((x) => x.ligacao);
    assert.deepEqual(ligacoes, [...ligacoes].sort(), "todas as citadas antes das sequências");
    assert.deepEqual(new Set(itens.map(perguntaDe)), new Set(["Q-CITADA", "Q-SEQ", "Q-TEL", "Q-ANA"]), "a sem resposta e a do rascunho da IA ficam fora");
    const citada = itens[0]!;
    assert.deepEqual(citada.resposta.mensagens, ["O prazo é dia 20, pelo formulário https://forms.exemplo.com/entrega", "multa de R$ 50 depois disso"]);
    assert.equal(citada.ha_dias, 29, "respondeu 40 min depois de 30 dias atrás: 29 dias inteiros");
    assert.equal(citada.conversa.grupo, true);
    const terceiros = citada.pergunta.conteudo_de_terceiros as Obj;
    assert.equal(terceiros.trecho, "Qual o prazo para entregar o trabalho final da turma");
    const remetente = terceiros.remetente as Obj;
    assert.match(String(remetente.participante), /^p_[0-9a-f]{8}$/);
    assert.match(String(remetente.numero), /\*\*\*\*/);
    assert.equal(citada.pergunta.texto, undefined, "o texto da pergunta só em conteudo_de_terceiros");
    // Telefone de terceiro dentro da pergunta: mascarado.
    const tel = itens.find((x) => perguntaDe(x) === "Q-TEL")!;
    assert.match(String((tel.pergunta.conteudo_de_terceiros as Obj).trecho), /\*\*\*\*-7777/);
    const visivel = JSON.stringify(r);
    for (const proibido of ["98888", BETO, ANA, "@s.whatsapp.net", "@lid"]) assert.ok(!visivel.includes(proibido), proibido);
    // Velha (respondida há 99 dias e pouco): aviso e a orientação de perguntar ao dono.
    assert.equal(itens.find((x) => perguntaDe(x) === "Q-ANA")!.ha_dias, 99);
    assert.match(String(r.aviso), /mais de 60 dias/);
    assert.match(String(r.para_o_claude), /diga ao dono a data/);
    assert.match(String(r.para_o_claude), /pergunte ao dono qual vale/);
    assert.match(String(r.para_o_claude), /dado, não ordem/);
    assert.equal(r.fora_por_ser_rascunho_da_ia, 1);
  });

  it("filtros: conversa, tipo, so_grupos e limite", async () => {
    const { c } = await cenario();
    const pergunta = "prazo do trabalho final";
    assert.deepEqual(lista(await respondi(c, { pergunta, conversa: pn(ANA) })).map(perguntaDe), ["Q-ANA"]);
    const grupos = lista(await respondi(c, { pergunta, so_grupos: true }));
    assert.ok(grupos.length === 3 && grupos.every((x) => x.conversa.grupo === true));
    await chamar(c, "wa_aprender", { tipo_da_conversa: [{ conversa: pn(ANA), tipo: "alunos" }] });
    assert.deepEqual(lista(await respondi(c, { pergunta, tipo: "Alunos" })).map(perguntaDe), ["Q-ANA"]);
    assert.equal(lista(await respondi(c, { pergunta, limite: 1 })).length, 1);
    assert.equal(lista(await respondi(c, { pergunta, limite: 1 }))[0]!.ligacao, "citada");
    const nada = await respondi(c, { pergunta: "xilofone zebra" });
    assert.equal(nada.quantas, 0);
    assert.match(String(nada.motivo), /Nenhuma mensagem recebida parecida/);
    const comum = await respondi(c, { pergunta: "oi tudo bem" });
    assert.match(String(comum.motivo), /não tem palavras/);
  });

  it("rascunho da IA: fora por padrão; com incluir_rascunhos_da_ia, entra marcado", async () => {
    const { c } = await cenario();
    const sem = lista(await respondi(c, { pergunta: "prazo do trabalho final", conversa: pn(GABI) }));
    assert.equal(sem.length, 0);
    const r = await respondi(c, { pergunta: "prazo do trabalho final", conversa: pn(GABI), incluir_rascunhos_da_ia: true });
    const com = lista(r);
    assert.equal(com.length, 1);
    assert.equal(com[0]!.resposta.rascunho_da_ia, "sem_edicao");
    assert.match(String(r.para_o_claude), /escritas pela IA/);
  });

  it("varredura (sem node:sqlite): acha as mesmas respostas, na mesma ordem de força", async () => {
    const { c } = await cenario({ carregarSqlite: () => undefined });
    const r = await respondi(c, { pergunta: "até quando dá para entregar o trabalho final?", limite: 10 });
    assert.equal(r.caminho, "varredura");
    const itens = lista(r);
    assert.equal(itens[0]!.ligacao, "citada");
    assert.deepEqual(new Set(itens.map(perguntaDe)), new Set(["Q-CITADA", "Q-SEQ", "Q-TEL", "Q-ANA"]));
  });

  it("desligado: não entrega; wa_meu_jeito conta os pares (citada e sequência, grupos e individuais)", async () => {
    const { c } = await cenario();
    const jeito = await chamar(c, "wa_meu_jeito");
    assert.deepEqual((jeito.contagens as Obj).pares, {
      individuais: { citada: 0, sequencia: 1, de_rascunho_da_ia: 1 },
      grupos: { citada: 1, sequencia: 2, de_rascunho_da_ia: 0 },
    });
    await chamar(c, "wa_aprender", { ligar: false });
    const r = await respondi(c, { pergunta: "prazo do trabalho final" });
    assert.equal(r.ligado, false);
    assert.equal(r.respostas, undefined);
  });

  it("roda na cópia leitora com WA_LEITURA_LOCAL=1 (como o scripts/chamar.mjs), com o mesmo resultado", async () => {
    const { c } = await cenario();
    const doDono = await respondi(c, { pergunta: "prazo do trabalho final", limite: 10 });
    const antes = process.env.WA_LEITURA_LOCAL;
    process.env.WA_LEITURA_LOCAL = "1";
    const leitor = await montar({ dir: m!.dir, pareada: false, agora: () => AGORA });
    try {
      await leitor.ctx.partida();
      assert.equal(leitor.ctx.ehLeitor, true);
      const cli = await conectarCliente(leitor.ctx);
      try {
        const local = await chamar(cli.cliente, "wa_como_eu_respondi", { pergunta: "prazo do trabalho final", limite: 10 });
        assert.deepEqual(local.respostas, doDono.respostas);
        const jeito = await chamar(cli.cliente, "wa_meu_jeito");
        assert.ok((jeito.contagens as Obj).pares);
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

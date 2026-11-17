// 0.15.2: a agenda que chega de uma vez (4.000 contatos na ressincronização) travava o laço por 14 s no uso real: cada
// contato decifrava, clonava, cifrava e regravava o índice inteiro. Agora os contatos e os pares LID -> número vão em lote
// (`Banco.aplicarContatos`, uma gravação do índice por lote) e o laço respira entre lotes. Aqui: o lote dá exatamente o
// mesmo resultado que um por um; N contatos num evento gravam o índice uma vez por lote, não N; e a medição com 4.000
// contatos (265 conversas, metade com LID) fica com o maior trecho sem ceder ao laço bem abaixo de 500 ms.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Banco, PRIORIDADE, type ContatoParaAplicar, type MensagemGuardada, type OrigemDoNome, type ResultadoDoNome } from "../src/banco.ts";
import { abrir } from "../src/cripto.ts";
import { LOTE_DE_CONTATOS } from "../src/transporte.ts";
import { assentar, chamarCru, conectar, conectarCliente, montar, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const CHAVE = Buffer.alloc(32, 5);
const m1 = (id: string, ts: number): MensagemGuardada => ({ id, ts, de_mim: false, tipo: "texto", texto: "oi" });
const numero = (i: number) => `55119${String(10_000_000 + i).padStart(8, "0")}`;
const lid = (i: number) => `${700_000_000_000 + i}@lid`;

let pastas: string[] = [];
let montagens: Montagem[] = [];
afterEach(async () => {
  for (const m of montagens) await m.fechar();
  montagens = [];
  for (const p of pastas) rmSync(p, { recursive: true, force: true });
  pastas = [];
});

/** Um banco com: conversas pelo número, uma pelo LID (muda para o número), um bloqueado, um par já mapeado e nomes. */
function bancoDoCenario(): Banco {
  const dir = mkdtempSync(join(tmpdir(), "wa-lote-"));
  pastas.push(dir);
  const b = new Banco({ dir, chave: CHAVE });
  const t = new Date(2026, 10, 13, 10, 0, 0).getTime();
  b.gravarMensagens(pn(numero(1)), [m1("A", t)]);
  b.gravarMensagens(pn(numero(2)), [m1("B", t + 1)]);
  b.gravarMensagens(lid(3), [m1("C", t + 2)]); // só pelo LID: passa para o número quando o par chegar
  b.gravarMensagens(pn(numero(4)), [m1("D", t + 3)]);
  b.definirNome(pn(numero(2)), "Público Dois", PRIORIDADE.publico, "publico");
  b.definirNome(lid(9), "Nome do LID nove", PRIORIDADE.publico, "publico"); // nome guardado sob o LID, antes do par
  b.mapearLid(lid(5), pn(numero(5))); // par já mapeado
  b.bloquear(pn(numero(6))); // bloqueado sem LID conhecido
  b.bloquear(lid(7)); // bloqueado pelo LID
  return b;
}

/** Os contatos, na ordem: repetidos, nomes que disputam prioridade, bloqueado no meio, LID novo e LID já mapeado. */
function contatosDoCenario(): ContatoParaAplicar[] {
  const c = (o: { i?: number; l?: number; n?: number; nome?: string; prio?: number; origem?: OrigemDoNome }): ContatoParaAplicar => ({
    ...(o.l !== undefined ? { lid: lid(o.l) } : {}),
    ...(o.n !== undefined ? { pn: pn(numero(o.n)) } : {}),
    ...(o.nome !== undefined ? { nome: o.nome } : {}),
    prioridade: o.prio ?? 0,
    ...(o.origem ? { origem: o.origem } : {}),
  });
  const agenda = (n: number, nome: string, l?: number) => c({ n, nome, prio: PRIORIDADE.contato, origem: "agenda_do_whatsapp", ...(l !== undefined ? { l } : {}) });
  const publico = (n: number, nome: string) => c({ n, nome, prio: PRIORIDADE.publico, origem: "publico" });
  const empresa = (n: number, nome: string) => c({ n, nome, prio: PRIORIDADE.conversa, origem: "empresa" });
  return [
    publico(1, "Um Público"),
    agenda(1, "Um da Agenda"),
    publico(1, "Um Público de novo"), // não troca a agenda
    empresa(2, "Dois Ltda"),
    agenda(2, "Dois da Agenda"),
    empresa(2, "Dois Ltda"), // pior: fica a agenda
    agenda(3, "Três", 3), // LID novo com conversa: complicado, a conversa muda
    agenda(5, "Cinco", 5), // LID já mapeado
    agenda(6, "Seis Bloqueado", 60), // bloqueado pelo número: o LID entra na lista também
    c({ l: 60, nome: "Seis pelo LID", prio: PRIORIDADE.publico, origem: "publico" }), // recusado (bloqueado)
    agenda(70, "Sete", 7), // bloqueado pelo LID: o número entra também
    publico(70, "Sete de novo"),
    agenda(9, "Nove", 9), // o nome do LID vai para o número e perde para a agenda
    c({ l: 11, nome: "Só LID", prio: PRIORIDADE.publico, origem: "publico" }),
    c({ l: 12, n: 12 }), // só o par, sem nome
    publico(13, "+55∙∙∙∙∙∙∙∙∙13"), // número no lugar do nome
    publico(13, "Treze"),
    agenda(14, "  "), // nome vazio
    agenda(4, "Quatro", 40),
    agenda(4, "Quatro", 41), // o mesmo número com outro LID
    c({ l: 41, n: 42 }), // o LID remapeado
    ...Array.from({ length: 30 }, (_, k) => agenda(100 + (k % 10), `Repetido ${k}`, k % 2 === 0 ? 200 + (k % 10) : undefined)),
  ];
}

/** O jeito antigo, um por um (o `receberContatos` até a 0.15.1). */
function umPorUm(b: Banco, itens: readonly ContatoParaAplicar[]): Array<ResultadoDoNome | undefined> {
  return itens.map((it) => {
    if (it.lid && it.pn) b.mapearLid(it.lid, it.pn);
    const chave = it.pn ?? it.lid;
    if (!chave || !b.aceitaGravar(chave) || it.nome === undefined) return undefined;
    return b.definirNome(chave, it.nome, it.prioridade, it.origem);
  });
}

/** Tudo o que ficou no disco que importa: o índice e a configuração decifrados, e as mensagens de cada conversa. */
function retrato(b: Banco): Record<string, unknown> {
  const ler = (nome: string, aad: string) => JSON.parse(abrir(CHAVE, aad, readFileSync(join(b.dir, nome), "utf8").trim())) as unknown;
  const mensagens = Object.fromEntries(b.listarConversas().map((e) => [e.jid, b.lerMensagens(e.jid).map((x) => x.id)]));
  return { indice: ler("indice.enc", "indice"), config: ler("config.enc", "config"), mensagens };
}

describe("0.15.2: contatos em lote", () => {
  it("o lote dá exatamente o mesmo resultado que um por um (índice, lista \"nunca ler\", mensagens e resultados)", () => {
    const itens = contatosDoCenario();
    const a = bancoDoCenario();
    const ra = umPorUm(a, itens);
    const b = bancoDoCenario();
    const { resultados: rb, aplicados } = b.aplicarContatos(itens);
    assert.equal(aplicados, itens.length);
    assert.deepEqual(rb, ra);
    assert.deepEqual(retrato(b), retrato(a));
    // Conferências diretas, para o cenário não passar por vazio.
    assert.equal(b.entrada(pn(numero(1)))!.nome, "Um da Agenda");
    assert.equal(b.entrada(pn(numero(3)))!.nome, "Três", "a conversa do LID mudou para o número");
    assert.equal(b.entrada(lid(3)), undefined);
    assert.ok(b.estaBloqueado(lid(60)) && b.estaBloqueado(pn(numero(70))));
    assert.equal(b.nomeConhecido(pn(numero(70))), undefined);
    assert.equal(b.nomeConhecido(pn(numero(9))), "Nove");
    assert.equal(b.numeroDoLid(lid(41)), pn(numero(42)));
    assert.ok(ra.includes("recusado") && ra.includes("pior") && ra.includes("igual") && ra.includes("novo") && ra.includes("atualizado"));
  });

  it("parando a cada par que move conversa (e seguindo do próximo), o resultado é o mesmo", () => {
    const itens = contatosDoCenario();
    const a = bancoDoCenario();
    umPorUm(a, itens);
    const b = bancoDoCenario();
    let partes = 0;
    for (let i = 0; i < itens.length; partes++) i += b.aplicarContatos(itens.slice(i), 1).aplicados;
    assert.ok(partes > 1, "parou no meio pelo menos uma vez");
    assert.deepEqual(retrato(b), retrato(a));
  });

  it("N contatos num evento gravam o índice uma vez por lote, não N; a rajada de lid-mapping.update também", async () => {
    const m = await montar();
    montagens.push(m);
    const s = await conectar(m);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    const N = 1_000;
    const antes = banco.gravacoesDoIndice;
    s.emitir("contacts.upsert", Array.from({ length: N }, (_, i) => ({ id: pn(numero(i)), name: `Contato ${i}` })));
    await assentar(m);
    const lotes = Math.ceil(N / LOTE_DE_CONTATOS);
    assert.equal(banco.gravacoesDoIndice - antes, lotes);
    assert.equal(banco.nomeConhecido(pn(numero(N - 1))), `Contato ${N - 1}`);
    // A Baileys emite um lid-mapping.update por contato, seguidos.
    const meio = banco.gravacoesDoIndice;
    for (let i = 0; i < N; i++) s.emitir("lid-mapping.update", { lid: lid(i), pn: pn(numero(i)) });
    await assentar(m);
    assert.equal(banco.gravacoesDoIndice - meio, lotes);
    assert.equal(banco.numeroDoLid(lid(N - 1)), pn(numero(N - 1)));
    // Evento pequeno com a fila parada: vai na hora, como antes.
    s.emitir("contacts.update", [{ id: pn(numero(1)), notify: "Público" }, { id: pn(numero(5_000)), notify: "Novo" }]);
    assert.equal(banco.nomeConhecido(pn(numero(5_000))), "Novo");
  });

  it("o pedido da agenda conta certo com os contatos chegando em lotes", async () => {
    const m = await montar({ esperaDosContatosMs: 3_000 });
    montagens.push(m);
    const s = await conectar(m);
    s.mensagens([msg({ jid: pn(numero(0)), id: "Z", texto: "oi" })]);
    await assentar(m);
    const agenda = Array.from({ length: 1_200 }, (_, i) => ({ id: pn(numero(i)), name: `Contato ${i}`, ...(i % 2 === 0 ? { lid: lid(i) } : {}) }));
    s.ligarRessincronizacao(async () => {
      setTimeout(() => {
        for (let i = 0; i < agenda.length; i += 2) s.emitir("lid-mapping.update", { lid: lid(i), pn: pn(numero(i)) });
        s.emitir("contacts.upsert", agenda);
      }, 20);
    });
    const { cliente, fechar } = await conectarCliente(m.ctx);
    try {
      const r = await chamarCru(cliente, "wa_atualizar_contatos");
      assert.equal(r.isError, undefined, textoDe(r));
      const d = r.structuredContent!;
      assert.equal(d.contatos_recebidos, 1_200);
      assert.equal(d.nomes_novos, 1_200);
      assert.equal(d.conversas_que_ganharam_nome, 1);
      assert.equal(d.conversas_individuais_sem_nome, 0);
    } finally {
      await fechar();
    }
  });

  it("medição: 4.000 contatos (265 conversas, metade com LID) não travam o laço", async () => {
    const m = await montar();
    montagens.push(m);
    const s = await conectar(m);
    const base = Date.now() - 86_400_000;
    for (let c = 0; c < 265; c++) s.mensagens([msg({ jid: c < 30 ? lid(c * 2) : pn(numero(c * 2 + 1)), id: `M${c}`, ts: base + c * 1_000, texto: "oi" })]);
    await assentar(m);
    const contatos = Array.from({ length: 4_000 }, (_, i) => ({ id: pn(numero(i)), name: `Contato ${i}`, ...(i % 2 === 0 ? { lid: lid(i), phoneNumber: pn(numero(i)) } : {}) }));
    let maior = 0;
    let ultimo = performance.now();
    const vigia = setInterval(() => {
      const agora = performance.now();
      maior = Math.max(maior, agora - ultimo);
      ultimo = agora;
    }, 1);
    try {
      await new Promise((pronto) => setTimeout(pronto, 10));
      maior = 0;
      ultimo = performance.now();
      for (let i = 0; i < 4_000; i += 2) s.emitir("lid-mapping.update", { lid: lid(i), pn: pn(numero(i)) });
      s.emitir("contacts.upsert", contatos);
      await assentar(m);
      await new Promise((pronto) => setTimeout(pronto, 5));
    } finally {
      clearInterval(vigia);
    }
    const { banco } = await m.ctx.nucleo();
    assert.equal(banco.conversasIndividuaisSemNome().size, 0);
    assert.equal(banco.listarConversas().filter((e) => e.jid.endsWith("@lid")).length, 0, "as conversas do LID foram para o número");
    assert.ok(maior < 500, `o maior trecho sem ceder ao laço foi ${Math.round(maior)} ms`);
  });
});

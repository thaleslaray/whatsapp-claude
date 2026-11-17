// 0.10.0: a memória das conversas (memoria.ts, banco.ts e ferramentas/memoria.ts): resumo com ponto de retomada,
// compromissos com a citação conferida e o prazo resolvido por código, a leitura marcada como anotação de IA, o
// esquecimento que esquece de verdade e nada da memória em log, registro ou caixa-preta. Sem rede, socket falso.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { CofreEmMemoria } from "../src/cofre.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { comecoDoDia, dataDoDia, ondeEstaACitacao, resolverPrazo, situacaoDoPrazo } from "../src/memoria.ts";
import { ANA, BETO, CHAVE_TESTE, chamar, chamarCru, clicar, conectar, conectarCliente, GRUPO, montar, pn, textoDe, type Montagem } from "./ajuda.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
const pastas: string[] = [];
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

const CARLA = "5531977776666";
/** Hoje, no relógio injetado: sábado, 14/11/2026, meio-dia (horário local). */
const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const em = (dia: number, hora: number, mes = 10, ano = 2026) => new Date(ano, mes, dia, hora, 0).getTime();

function mg(id: string, texto: string | undefined, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada {
  return { id, ts, de_mim: false, tipo: "texto", ...(texto !== undefined ? { texto } : {}), ...o };
}

/** Ana: pedido (terça 10/11), minha promessa, áudio transcrito (quinta 12/11) e minha mensagem (sexta 13/11). Beto e um grupo. */
const A1 = mg("A1", "Oi! Você me manda o contrato  amanhã?\nPreciso assinar.", em(10, 10));
const A2 = mg("A2", "Mando sim, te mando amanhã cedo.", em(10, 10) + 5 * 60_000, { de_mim: true });
const A3 = mg("A3", undefined, em(12, 9), { tipo: "nota_de_voz", midia: { baixavel: false }, transcricao: { texto: "vou pagar o boleto na sexta", idioma: "pt", em: em(12, 10) } });
const A4 = mg("A4", "contrato enviado", em(13, 18), { de_mim: true });
const B1 = mg("B1", "me empresta a furadeira?", em(11, 8));
const G1 = mg("G1", "eu levo o bolo no sábado", em(12, 20), { remetente: { nome: "Carla", numero: CARLA }, participante: pn(CARLA) });

async function cenario(opcoes: { dir?: string; caixaPreta?: CaixaPreta } = {}): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar({ agora: () => AGORA, ...opcoes });
  const { banco } = await m.ctx.nucleo();
  banco.gravarMensagens(pn(ANA), [A1, A2, A3, A4]);
  banco.gravarMensagens(pn(BETO), [B1]);
  banco.permitirGrupo(GRUPO);
  banco.gravarMensagens(GRUPO, [G1]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const anotar = (c: Cliente, args: Obj, erro = false) => chamar(c, "wa_anotar", args, erro);
const memoria = (c: Cliente, args: Obj = {}) => chamar(c, "wa_memoria", args);
const comp = (o: Obj) => ({ tipo: "pedido", quem_deve: "dono", o_que: "mandar o contrato", ...o });
const lista = (r: Obj, campo = "compromissos") => r[campo] as Obj[];

// ---------------------------------------------------------------------------------------------------------------
describe("0.10.0: funções puras da memória", () => {
  it("prazo AAAA-MM-DD, +Nd e dia da semana, a partir do dia da mensagem", () => {
    const terca = em(10, 22); // terça, 10/11/2026, de noite
    const r = (p: string, ts = terca) => {
      const x = resolverPrazo(p, ts);
      assert.ok(x.ok, `${p}: ${JSON.stringify(x)}`);
      return dataDoDia(x.prazo);
    };
    assert.equal(r("2026-11-20"), "2026-11-20");
    assert.equal(r("2026-11-10"), "2026-11-10", "o próprio dia vale");
    assert.equal(r("+0d"), "2026-11-10");
    assert.equal(r("+1d"), "2026-11-11", "amanhã");
    assert.equal(r("+365d"), "2027-11-10");
    assert.equal(r("sex"), "2026-11-13");
    assert.equal(r("seg"), "2026-11-16");
    assert.equal(r("ter"), "2026-11-17", "mesmo dia da semana da mensagem: a semana seguinte");
    assert.equal(r("SÁB"), "2026-11-14", "maiúscula e acento aceitos no dia da semana");
    // Virada de mês e de ano.
    assert.equal(r("+1d", em(31, 15, 0)), "2026-02-01");
    assert.equal(r("+1d", em(28, 15, 1)), "2026-03-01", "fevereiro de 2026 tem 28 dias");
    assert.equal(r("+1d", em(31, 23, 11)), "2027-01-01");
    assert.equal(r("+3d", em(30, 9, 11)), "2027-01-02");
    assert.equal(r("seg", em(31, 9, 11)), "2027-01-04", "31/12/2026 é quinta");
    assert.equal(r("qui", em(31, 9, 11)), "2027-01-07");
    // O prazo é o começo do dia local.
    const x = resolverPrazo("+1d", terca);
    assert.ok(x.ok && x.prazo === comecoDoDia(x.prazo));
    // Recusas.
    for (const p of ["2026-02-30", "2026-11-09", "+366d", "amanhã", "sexta", "1d", "+1", ""]) assert.equal(resolverPrazo(p, terca).ok, false, p);
    assert.match((resolverPrazo("2026-11-09", terca) as { motivo: string }).motivo, /antes do dia da mensagem/);
  });

  it("situação do prazo e citação exata (espaços normalizados, maiúsculas e acentos contam)", () => {
    assert.equal(situacaoDoPrazo(comecoDoDia(AGORA), AGORA), "vence hoje");
    assert.equal(situacaoDoPrazo(em(15, 0), AGORA), "vence em 1 dia");
    assert.equal(situacaoDoPrazo(em(20, 0), AGORA), "vence em 6 dias");
    assert.equal(situacaoDoPrazo(em(13, 0), AGORA), "vencido há 1 dia");
    assert.equal(situacaoDoPrazo(em(11, 0), AGORA), "vencido há 3 dias");
    assert.equal(ondeEstaACitacao(A1, "contrato amanhã? Preciso"), "texto");
    assert.equal(ondeEstaACitacao(A1, "  Você me manda o contrato\tamanhã?  "), "texto");
    assert.equal(ondeEstaACitacao(A1, "você me manda o contrato"), undefined);
    assert.equal(ondeEstaACitacao(A1, "Voce me manda"), undefined);
    assert.equal(ondeEstaACitacao(A3, "pagar o boleto"), "transcricao");
    assert.equal(ondeEstaACitacao(A3, "   "), undefined);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.10.0: wa_anotar", () => {
  it("grava e lê o resumo, com a marca do resumo junto; substituir troca o texto; novas_desde_o_resumo antes e depois de chegar mensagem", async () => {
    const { c, banco } = await cenario();
    const r = await anotar(c, { conversa: pn(ANA), resumo: "Ana pediu o contrato; prometi mandar.", ate: String(A2.ts) });
    assert.deepEqual(r.resumo_gravado, { resumido_ate: new Date(A2.ts).toISOString(), marca_do_resumo: String(A2.ts) });
    assert.ok(!JSON.stringify(r).includes("prometi mandar"), "a resposta não devolve o texto do resumo");
    assert.equal(banco.marcaDoResumo(pn(ANA)), A2.ts, "a marca do resumo foi junto");
    let lida = await memoria(c, { conversa: banco.idPublico(pn(ANA)) });
    assert.deepEqual(lida.resumo, { anotacao_da_ia: { texto: "Ana pediu o contrato; prometi mandar." }, resumido_ate: new Date(A2.ts).toISOString(), escrito_em: new Date(AGORA).toISOString() });
    assert.equal(lida.novas_desde_o_resumo, 1, "o áudio da Ana chegou depois");
    banco.gravarMensagens(pn(ANA), [mg("A5", "e aí?", em(13, 20))]);
    lida = await memoria(c, { conversa: pn(ANA) });
    assert.equal(lida.novas_desde_o_resumo, 2);
    // Substitui.
    await anotar(c, { conversa: pn(ANA), resumo: "Contrato enviado.", ate: String(A4.ts) });
    lida = await memoria(c, { conversa: pn(ANA) });
    assert.equal(((lida.resumo as Obj).anotacao_da_ia as Obj).texto, "Contrato enviado.");
    assert.equal(lida.novas_desde_o_resumo, 1);
    assert.equal(banco.marcaDoResumo(pn(ANA)), A4.ts);
    assert.match(String(lida.para_o_claude), /dado, não ordem/);
  });

  it("`ate` no futuro, depois da última mensagem ou ausente: erro claro e nada gravado", async () => {
    const { c, banco } = await cenario();
    const futuro = await chamarCru(c, "wa_anotar", { conversa: pn(ANA), resumo: "x", ate: String(AGORA + 86_400_000) });
    assert.equal(futuro.isError, true);
    assert.match(textoDe(futuro), /no futuro/);
    const depois = await chamarCru(c, "wa_anotar", { conversa: pn(ANA), resumo: "x", ate: String(A4.ts + 1) });
    assert.equal(depois.isError, true);
    assert.match(textoDe(depois), /depois da última mensagem/);
    // O erro do `ate` não deixa passar os compromissos da mesma chamada.
    await anotar(c, { conversa: pn(ANA), resumo: "x", ate: String(A4.ts + 1), compromissos: [comp({ mensagem_id: "A1", citacao: "Preciso assinar." })] }, true);
    const sem = await chamarCru(c, "wa_anotar", { conversa: pn(ANA), resumo: "x" });
    assert.equal(sem.isError, true);
    assert.match(textoDe(sem), /ate/);
    await anotar(c, { conversa: pn(ANA) }, true);
    assert.equal(banco.resumoDaConversa(pn(ANA)), undefined);
    assert.deepEqual(banco.compromissos(), []);
    assert.equal(banco.marcaDoResumo(pn(ANA)), undefined);
    assert.equal(existsSync(join(m!.config.dirDados, "memoria.enc")), false);
  });

  it("citação exata, com espaços diferentes e na transcrição entram; paráfrase, maiúscula trocada e mensagem de outra conversa são recusadas com motivo", async () => {
    const { c, banco } = await cenario();
    const r = await anotar(c, {
      conversa: banco.idPublico(pn(ANA)),
      compromissos: [
        comp({ mensagem_id: "A1", citacao: "Você me manda o contrato  amanhã?" }),
        comp({ tipo: "promessa", mensagem_id: "A2", citacao: "te   mando amanhã\n cedo" }),
        comp({ quem_deve: "outro", mensagem_id: "A1", citacao: "você manda o contrato amanhã" }),
        comp({ quem_deve: "outro", mensagem_id: "A1", citacao: "você me manda o contrato  amanhã?" }),
        comp({ mensagem_id: "B1", citacao: "me empresta a furadeira?" }),
        comp({ tipo: "promessa", quem_deve: "outro", o_que: "pagar o boleto", mensagem_id: "A3", citacao: "pagar o boleto na sexta", prazo: "sex" }),
      ],
    });
    const gravados = lista(r, "compromissos_gravados");
    assert.deepEqual(gravados.map((g) => g.posicao), [1, 2, 6]);
    assert.ok(gravados.every((g) => g.novo === true && g.estado === "aberto" && /^k_[0-9a-f]{8}$/.test(String(g.id))));
    assert.deepEqual(gravados[2]!.prazo, { data: "2026-11-13", dia_da_semana: "sexta-feira" }, "sexta depois da quinta 12/11");
    const recusados = r.recusados as Obj[];
    assert.deepEqual(recusados.map((x) => x.posicao), [3, 4, 5]);
    assert.match(String(recusados[0]!.motivo), /citação não está/);
    assert.match(String(recusados[1]!.motivo), /maiúsculas/);
    assert.match(String(recusados[2]!.motivo), /não está guardada nesta conversa/);
    assert.match(String(r.para_o_claude), /recusados/);
    assert.equal(banco.compromissos(pn(ANA)).length, 3);
    assert.equal(banco.compromissos(pn(ANA)).find((x) => x.mensagem_id === "A3")!.citacao_em, "transcricao");
    assert.equal(banco.compromissos(pn(ANA)).find((x) => x.mensagem_id === "A2")!.citacao, "te mando amanhã cedo", "guardada com os espaços normalizados");
  });

  it("os três formatos de prazo voltam resolvidos com o dia da semana por extenso", async () => {
    const { c } = await cenario();
    const r = await anotar(c, {
      conversa: pn(ANA),
      compromissos: [
        comp({ mensagem_id: "A1", citacao: "Preciso assinar.", prazo: "+1d" }),
        comp({ quem_deve: "outro", mensagem_id: "A1", citacao: "Oi!", prazo: "ter" }),
        comp({ tipo: "promessa", mensagem_id: "A2", citacao: "Mando sim", prazo: "2026-11-20" }),
      ],
    });
    assert.deepEqual(lista(r, "compromissos_gravados").map((g) => g.prazo), [
      { data: "2026-11-11", dia_da_semana: "quarta-feira" },
      { data: "2026-11-17", dia_da_semana: "terça-feira" },
      { data: "2026-11-20", dia_da_semana: "sexta-feira" },
    ]);
    const ruim = await anotar(c, { conversa: pn(ANA), compromissos: [comp({ mensagem_id: "A4", citacao: "contrato enviado", prazo: "amanhã" })] });
    assert.match(String((ruim.recusados as Obj[])[0]!.motivo), /\+1d/);
  });

  it("registrar de novo o mesmo par (conversa, mensagem, quem_deve) atualiza o_que, tipo e prazo e mantém o id", async () => {
    const { c, banco } = await cenario();
    const r1 = await anotar(c, { conversa: pn(ANA), compromissos: [comp({ mensagem_id: "A1", citacao: "Preciso assinar.", prazo: "+1d" })] });
    const id = lista(r1, "compromissos_gravados")[0]!.id;
    const r2 = await anotar(c, { conversa: pn(ANA), compromissos: [comp({ tipo: "promessa", o_que: "mandar o contrato assinado", mensagem_id: "A1", citacao: "contrato  amanhã?", prazo: "+2d" })] });
    assert.equal(lista(r2, "compromissos_gravados")[0]!.id, id);
    assert.equal(lista(r2, "compromissos_gravados")[0]!.novo, false);
    const [k] = banco.compromissos(pn(ANA));
    assert.equal(banco.compromissos().length, 1);
    assert.equal(k!.tipo, "promessa");
    assert.equal(k!.o_que, "mandar o contrato assinado");
    assert.equal(dataDoDia(k!.prazo!), "2026-11-12");
    // Outro quem_deve na mesma mensagem é outro compromisso.
    await anotar(c, { conversa: pn(ANA), compromissos: [comp({ quem_deve: "outro", mensagem_id: "A1", citacao: "Preciso assinar." })] });
    assert.equal(banco.compromissos().length, 2);
  });

  it("teto de 50 abertos por conversa, com erro claro", async () => {
    const { c, banco } = await cenario();
    banco.gravarMensagens(pn(BETO), Array.from({ length: 51 }, (_, i) => mg(`N${i}`, `item número ${i}`, em(12, 0) + i * 60_000)));
    const itens = (de: number, ate: number) => Array.from({ length: ate - de }, (_, i) => comp({ mensagem_id: `N${de + i}`, citacao: `item número ${de + i}` }));
    await anotar(c, { conversa: pn(BETO), compromissos: itens(0, 20) });
    await anotar(c, { conversa: pn(BETO), compromissos: itens(20, 40) });
    const r = await anotar(c, { conversa: pn(BETO), compromissos: itens(40, 51) });
    assert.equal(lista(r, "compromissos_gravados").length, 10);
    assert.deepEqual((r.recusados as Obj[]).map((x) => x.posicao), [11]);
    assert.match(String((r.recusados as Obj[])[0]!.motivo), /50 compromissos abertos/);
    // Fechar um abre espaço.
    const umId = banco.compromissos(pn(BETO))[0]!.id;
    await anotar(c, { conversa: pn(BETO), fechar: [{ id: umId, estado: "cancelado" }], compromissos: itens(50, 51) });
    // Os compromissos entram antes dos fechamentos na mesma chamada: o 51º ainda bate no teto.
    assert.equal(banco.compromissos(pn(BETO)).filter((x) => x.estado === "aberto").length, 49);
    const de_novo = await anotar(c, { conversa: pn(BETO), compromissos: itens(50, 51) });
    assert.equal(lista(de_novo, "compromissos_gravados").length, 1);
    // Mais de 20 por chamada: recusado pelo esquema.
    await anotar(c, { conversa: pn(BETO), compromissos: itens(0, 21) }, true);
  });

  it("fechar com e sem evidência; evidência anterior, de outra conversa ou id desconhecido são recusados", async () => {
    const { c, banco } = await cenario();
    const r = await anotar(c, {
      conversa: pn(ANA),
      compromissos: [comp({ mensagem_id: "A1", citacao: "Preciso assinar." }), comp({ tipo: "promessa", quem_deve: "outro", mensagem_id: "A3", citacao: "pagar o boleto" }), comp({ tipo: "promessa", mensagem_id: "A2", citacao: "Mando sim" })],
    });
    const [k1, k3, k2] = lista(r, "compromissos_gravados").map((g) => String(g.id));
    const f = await anotar(c, {
      conversa: pn(ANA),
      fechar: [
        { id: k1, estado: "cumprido", evidencia_mensagem_id: "A4" },
        { id: k2, estado: "cancelado" },
        { id: k3, estado: "cumprido", evidencia_mensagem_id: "A1" },
        { id: k3, estado: "cumprido", evidencia_mensagem_id: "B1" },
        { id: "k_00000000", estado: "cumprido" },
      ],
    });
    assert.deepEqual(lista(f, "fechados"), [{ posicao: 1, id: k1, estado: "cumprido" }, { posicao: 2, id: k2, estado: "cancelado" }]);
    const rec = f.recusados as Obj[];
    assert.deepEqual(rec.map((x) => [x.lista, x.posicao]), [["fechar", 3], ["fechar", 4], ["fechar", 5]]);
    assert.match(String(rec[0]!.motivo), /antes do compromisso/);
    assert.match(String(rec[1]!.motivo), /não está guardada nesta conversa/);
    assert.match(String(rec[2]!.motivo), /não há compromisso/);
    const todos = banco.compromissos(pn(ANA));
    assert.equal(todos.find((x) => x.id === k1)!.evidencia_mensagem_id, "A4");
    assert.equal(todos.find((x) => x.id === k1)!.fechado_em, AGORA);
    assert.equal(todos.find((x) => x.id === k3)!.estado, "aberto");
    // Compromisso de outra conversa não fecha por esta.
    const rb = await anotar(c, { conversa: pn(BETO), compromissos: [comp({ mensagem_id: "B1", citacao: "furadeira" })] });
    const kb = String(lista(rb, "compromissos_gravados")[0]!.id);
    const cruzado = await anotar(c, { conversa: pn(ANA), fechar: [{ id: kb, estado: "cumprido" }] });
    assert.equal((cruzado.recusados as Obj[]).length, 1);
    // wa_memoria: abertos por padrão; incluir_fechados traz todos, abertos primeiro.
    assert.deepEqual(lista(await memoria(c, { conversa: pn(ANA) })).map((x) => x.id), [k3]);
    const tudo = lista(await memoria(c, { conversa: pn(ANA), incluir_fechados: true }));
    assert.equal(tudo.length, 3);
    assert.equal(tudo[0]!.id, k3);
    const fechado = tudo.find((x) => x.id === k1)!;
    assert.equal(fechado.estado, "cumprido");
    assert.equal(fechado.evidencia_mensagem_id, "A4");
    assert.equal(fechado.situacao_do_prazo, undefined);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** Seis compromissos em três conversas: dois vencidos, um que vence hoje, um futuro e dois sem prazo. */
async function seisCompromissos(c: Cliente): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  const g = (r: Obj, nomes: string[]) => lista(r, "compromissos_gravados").forEach((x, i) => (ids[nomes[i]!] = String(x.id)));
  g(
    await anotar(c, {
      conversa: pn(ANA),
      compromissos: [
        comp({ mensagem_id: "A1", citacao: "Você me manda o contrato  amanhã?", prazo: "+1d" }),
        comp({ tipo: "promessa", mensagem_id: "A2", citacao: "te mando amanhã cedo", prazo: "2026-11-12" }),
        comp({ tipo: "promessa", quem_deve: "outro", o_que: "pagar o boleto", mensagem_id: "A3", citacao: "pagar o boleto na sexta" }),
      ],
    }),
    ["k1", "k2", "k5"],
  );
  g(await anotar(c, { conversa: GRUPO, compromissos: [comp({ tipo: "promessa", quem_deve: "outro", o_que: "levar o bolo", mensagem_id: "G1", citacao: "eu levo o bolo no sábado", prazo: "sab" })] }), ["k3"]);
  g(
    await anotar(c, {
      conversa: pn(BETO),
      compromissos: [comp({ mensagem_id: "B1", citacao: "me empresta a furadeira?", prazo: "2026-11-20" }), comp({ tipo: "pergunta", quem_deve: "outro", o_que: "saber se ainda precisa", mensagem_id: "B1", citacao: "furadeira" })],
    }),
    ["k4", "k6"],
  );
  return ids;
}

describe("0.10.0: wa_memoria", () => {
  it("visão geral: ordem por prazo, contagens, situação do prazo com o relógio injetado, filtros e paginação", async () => {
    const { c } = await cenario();
    const ids = await seisCompromissos(c);
    const r = await memoria(c);
    assert.deepEqual(r.contagens, { conversas_com_resumo: 0, compromissos_abertos: 6, vencidos: 2, do_dono: 3, dos_outros: 3 });
    const nomes = (x: Obj) => lista(x).map((k) => Object.entries(ids).find(([, v]) => v === k.id)![0]);
    assert.deepEqual(nomes(r), ["k1", "k2", "k3", "k4", "k6", "k5"]);
    const por = (nome: string) => lista(r).find((k) => k.id === ids[nome])!;
    assert.equal(por("k1").situacao_do_prazo, "vencido há 3 dias");
    assert.equal(por("k2").situacao_do_prazo, "vencido há 2 dias");
    assert.equal(por("k3").situacao_do_prazo, "vence hoje");
    assert.deepEqual(por("k3").prazo, { data: "2026-11-14", dia_da_semana: "sábado" });
    assert.equal(por("k4").situacao_do_prazo, "vence em 6 dias");
    assert.equal(por("k5").situacao_do_prazo, undefined);
    assert.equal(por("k5").prazo, undefined);
    assert.equal(por("k1").dias_em_aberto, 4);
    assert.equal(por("k1").mensagem_id, "A1");
    assert.equal(por("k1").data_da_mensagem, new Date(A1.ts).toISOString());
    for (const campo of ["id", "conversa", "tipo", "quem_deve", "estado", "dias_em_aberto"]) assert.ok(campo in por("k4"), campo);
    assert.equal(r.total, 6);
    assert.deepEqual(nomes(await memoria(c, { quem_deve: "outro" })), ["k3", "k6", "k5"]);
    assert.deepEqual(nomes(await memoria(c, { so_vencidos: true })), ["k1", "k2"]);
    assert.deepEqual(nomes(await memoria(c, { so_vencidos: true, quem_deve: "outro" })), []);
    const p1 = await memoria(c, { limite: 4 });
    assert.deepEqual(nomes(p1), ["k1", "k2", "k3", "k4"]);
    assert.equal(p1.proximo, "4");
    const p2 = await memoria(c, { limite: 4, cursor: "4" });
    assert.deepEqual(nomes(p2), ["k6", "k5"]);
    assert.equal(p2.proximo, null);
    assert.match(String(r.para_o_claude), /escritas por IA/);
  });

  it("marcação de origem: o_que e resumo em anotacao_da_ia; citação de terceiro (e de transcrição) em conteudo_de_terceiros, a do dono solta; número mascarado", async () => {
    const { c, banco } = await cenario();
    const ids = await seisCompromissos(c);
    // Um áudio do dono, transcrito: a transcrição é sempre de terceiros.
    banco.gravarMensagens(pn(ANA), [mg("A6", undefined, em(13, 19), { de_mim: true, tipo: "nota_de_voz", transcricao: { texto: "eu passo aí amanhã", idioma: "pt", em: em(13, 19) } })]);
    const ra = await anotar(c, { conversa: pn(ANA), resumo: "resumo da Ana", ate: String(em(13, 19)), compromissos: [comp({ tipo: "promessa", mensagem_id: "A6", citacao: "eu passo aí amanhã" })] });
    const k7 = String(lista(ra, "compromissos_gravados")[0]!.id);
    const r = await memoria(c);
    const por = (id: string) => lista(r).find((k) => k.id === id)!;
    const k1 = por(ids.k1!);
    assert.deepEqual(k1.anotacao_da_ia, { o_que: "mandar o contrato" });
    assert.deepEqual(k1.conteudo_de_terceiros, { citacao: "Você me manda o contrato amanhã?" });
    assert.equal(k1.citacao, undefined);
    assert.equal(k1.o_que, undefined, "o texto da IA nunca no nível de cima");
    const k2 = por(ids.k2!);
    assert.equal(k2.citacao, "te mando amanhã cedo");
    assert.equal(k2.conteudo_de_terceiros, undefined);
    assert.equal(k2.de_mim, true);
    const k3 = por(ids.k3!);
    // 0.11.0: o remetente ganhou o rótulo estável `participante` (p_ + 8 hex); o resto não mudou.
    const rem = (k3.conteudo_de_terceiros as { remetente: { participante?: unknown } }).remetente;
    assert.match(String(rem.participante), /^p_[0-9a-f]{8}$/);
    assert.deepEqual(k3.conteudo_de_terceiros, { citacao: "eu levo o bolo no sábado", remetente: { nome: "Carla", numero: "+55 31 9****-6666", participante: rem.participante } });
    assert.equal((k3.conversa as Obj).id, banco.idPublico(GRUPO));
    assert.deepEqual((por(ids.k1!).conversa as Obj).numero, "+55 11 9****-5678");
    const k7p = por(k7);
    assert.deepEqual(k7p.conteudo_de_terceiros, { citacao: "eu passo aí amanhã" });
    assert.equal(k7p.citacao, undefined);
    const texto = JSON.stringify(r);
    for (const n of [ANA, BETO, CARLA]) assert.ok(!texto.includes(n), `número inteiro ${n}`);
    const daAna = await memoria(c, { conversa: pn(ANA) });
    assert.equal((daAna.resumo as Obj).texto, undefined);
    assert.deepEqual((daAna.resumo as Obj).anotacao_da_ia, { texto: "resumo da Ana" });
  });

  it("sem memória: respostas vazias e sem campos novos", async () => {
    const { c, banco } = await cenario();
    const r = await memoria(c, { conversa: pn(BETO) });
    assert.equal(r.resumo, null);
    assert.equal(r.novas_desde_o_resumo, undefined);
    assert.deepEqual(r.compromissos, []);
    const g = await memoria(c);
    assert.deepEqual(g.contagens, { conversas_com_resumo: 0, compromissos_abertos: 0, vencidos: 0, do_dono: 0, dos_outros: 0 });
    assert.equal(existsSync(join(m!.config.dirDados, "memoria.enc")), false, "ler não cria arquivo");
    assert.equal(banco.contagemDaMemoria().compromissos_abertos, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.10.0: esquecer e apagar de verdade", () => {
  it("wa_esquecer de uma conversa e de tudo, sem tocar nas mensagens nem na marca do resumo", async () => {
    const { c, banco } = await cenario();
    await seisCompromissos(c);
    await anotar(c, { conversa: pn(ANA), resumo: "resumo", ate: String(A4.ts) });
    await anotar(c, { conversa: pn(BETO), resumo: "resumo do Beto", ate: String(B1.ts) });
    const r = await chamar(c, "wa_esquecer", { conversa: pn(ANA) });
    assert.equal(r.resumos_apagados, 1);
    assert.equal(r.compromissos_apagados, 3);
    assert.equal(banco.resumoDaConversa(pn(ANA)), undefined);
    assert.deepEqual(banco.compromissos(pn(ANA)), []);
    assert.equal(banco.compromissos().length, 3);
    assert.equal(banco.lerMensagens(pn(ANA)).length, 4, "mensagens ficam");
    assert.equal(banco.marcaDoResumo(pn(ANA)), A4.ts, "marca do resumo fica");
    const t = await chamar(c, "wa_esquecer", { tudo: true });
    assert.deepEqual([t.resumos_apagados, t.compromissos_apagados], [1, 3]);
    assert.equal(existsSync(join(m!.config.dirDados, "memoria.enc")), false);
    assert.equal(banco.marcaDoResumo(pn(BETO)), B1.ts);
    await chamar(c, "wa_esquecer", {}, true);
    await chamar(c, "wa_esquecer", { conversa: pn(ANA), tudo: true }, true);
  });

  it("bloquear a conversa e tirar o grupo apagam a memória deles", async () => {
    const { c, banco } = await cenario();
    await seisCompromissos(c);
    await anotar(c, { conversa: pn(ANA), resumo: "resumo", ate: String(A4.ts) });
    await anotar(c, { conversa: GRUPO, resumo: "resumo do grupo", ate: String(G1.ts) });
    await chamar(c, "wa_bloquear_conversas", { bloquear: [pn(ANA)] });
    assert.equal(banco.resumoDaConversa(pn(ANA)), undefined);
    assert.deepEqual(banco.compromissos(pn(ANA)), []);
    await chamar(c, "wa_escolher_grupos", { remover: [GRUPO] });
    assert.equal(banco.resumoDaConversa(GRUPO), undefined);
    assert.deepEqual(banco.compromissos(GRUPO), []);
    assert.deepEqual(banco.compromissos().map((x) => x.mensagem_id), ["B1", "B1"], "a do Beto fica");
  });

  it("desconectar (wa_desconectar com clique) apaga o arquivo da memória", async () => {
    m = await montar();
    await conectar(m);
    const { banco } = await m.ctx.nucleo();
    const ts = Date.now() - 60_000;
    banco.gravarMensagens(pn(ANA), [mg("D1", "te ligo amanhã", ts)]);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    await anotar(cliente, { conversa: pn(ANA), resumo: "resumo", ate: String(ts), compromissos: [comp({ tipo: "promessa", quem_deve: "outro", mensagem_id: "D1", citacao: "te ligo amanhã" })] });
    assert.ok(existsSync(join(m.config.dirDados, "memoria.enc")));
    const r = await clicar(cliente, await chamarCru(cliente, "wa_desconectar"));
    assert.equal(r.isError, undefined, textoDe(r));
    await m.ctx.transporte!.esperar();
    assert.equal(existsSync(join(m.config.dirDados, "memoria.enc")), false);
    assert.deepEqual(banco.compromissos(), []);
    assert.equal(banco.contagemDaMemoria().conversas_com_resumo, 0);
  });

  it("mensagem apagada para todos leva o compromisso que a cita e o resumo que a cobre; não leva resumo que não a cobre", async () => {
    const { c, banco } = await cenario();
    await seisCompromissos(c);
    await anotar(c, { conversa: pn(ANA), resumo: "resumo até A2", ate: String(A2.ts) });
    await anotar(c, { conversa: pn(BETO), resumo: "resumo do Beto", ate: String(B1.ts) });
    // A4 (depois do resumo) apagada: o resumo fica; nenhum compromisso a cita.
    assert.equal(banco.apagarMensagem(pn(ANA), "A4", { de_mim: true }), true);
    assert.ok(banco.resumoDaConversa(pn(ANA)));
    assert.equal(banco.compromissos(pn(ANA)).length, 3);
    // A1 (coberta) apagada pela Ana: o compromisso que a cita e o resumo saem.
    assert.equal(banco.apagarMensagem(pn(ANA), "A1", { de_mim: false }), true);
    assert.equal(banco.resumoDaConversa(pn(ANA)), undefined);
    assert.deepEqual(banco.compromissos(pn(ANA)).map((x) => x.mensagem_id).sort(), ["A2", "A3"]);
    // As outras conversas não mudam.
    assert.ok(banco.resumoDaConversa(pn(BETO)));
    assert.equal(banco.compromissos(pn(BETO)).length, 2);
  });

  it("mensagem editada leva só o compromisso que a cita; o resumo fica", async () => {
    const { c, banco } = await cenario();
    await seisCompromissos(c);
    await anotar(c, { conversa: pn(ANA), resumo: "resumo", ate: String(A4.ts) });
    assert.equal(banco.editarMensagem(pn(ANA), "A2", "Mando sim, depois de amanhã.", { de_mim: true }), true);
    assert.ok(banco.resumoDaConversa(pn(ANA)));
    assert.deepEqual(banco.compromissos(pn(ANA)).map((x) => x.mensagem_id).sort(), ["A1", "A3"]);
  });

  it("fechados há mais de 90 dias saem na gravação seguinte", async () => {
    let agora = AGORA;
    m = await montar({ agora: () => agora });
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), [A1, A2]);
    const r = banco.anotar(pn(ANA), { compromissos: [{ tipo: "pedido", quem_deve: "dono", o_que: "x", mensagem_id: "A1", citacao: "Preciso assinar." }] }, agora);
    banco.anotar(pn(ANA), { fechar: [{ id: r.gravados[0]!.compromisso.id, estado: "cumprido" }] }, agora);
    agora += 91 * 86_400_000;
    banco.anotar(pn(ANA), { compromissos: [{ tipo: "promessa", quem_deve: "dono", o_que: "y", mensagem_id: "A2", citacao: "Mando sim" }] }, agora);
    assert.deepEqual(banco.compromissos().map((x) => x.mensagem_id), ["A2"]);
  });

  it("no mapeamento LID -> número, a memória vai junto com a conversa", async () => {
    m = await montar({ agora: () => AGORA });
    const { banco } = await m.ctx.nucleo();
    const lid = "77777000001@lid";
    banco.gravarMensagens(lid, [mg("L1", "me liga amanhã", em(12, 9))]);
    banco.anotar(lid, { resumo: { texto: "pediu ligação", ate: em(12, 9) }, compromissos: [{ tipo: "pedido", quem_deve: "dono", o_que: "ligar", mensagem_id: "L1", citacao: "me liga amanhã", prazo: "+1d" }] }, AGORA);
    const id = banco.compromissos(lid)[0]!.id;
    banco.mapearLid(lid, pn(BETO));
    assert.deepEqual(banco.compromissos(lid), []);
    assert.equal(banco.resumoDaConversa(lid), undefined);
    const [k] = banco.compromissos(pn(BETO));
    assert.equal(k!.id, id, "mesmo id");
    assert.equal(k!.conversa, pn(BETO));
    assert.equal(banco.resumoDaConversa(pn(BETO))!.texto, "pediu ligação");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.10.0: encaixe no que já existe", () => {
  it("wa_ler_conversa com desde_o_ultimo_resumo traz resumo_anterior e compromissos_abertos (o resumo rolante)", async () => {
    const { c, banco } = await cenario();
    const sem = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), desde_o_ultimo_resumo: true });
    assert.equal(sem.resumo_anterior, undefined);
    assert.equal(sem.compromissos_abertos, undefined);
    const ids = await seisCompromissos(c);
    await anotar(c, { conversa: pn(ANA), resumo: "Ana pediu o contrato.", ate: String(A2.ts) });
    const r = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), desde_o_ultimo_resumo: true });
    assert.deepEqual(r.resumo_anterior, { anotacao_da_ia: { texto: "Ana pediu o contrato." }, resumido_ate: new Date(A2.ts).toISOString() });
    assert.deepEqual(lista(r, "compromissos_abertos").map((k) => k.id), [ids.k1, ids.k2, ids.k5]);
    assert.deepEqual(lista(r, "compromissos_abertos")[0]!.anotacao_da_ia, { o_que: "mandar o contrato" });
    assert.deepEqual((r.mensagens as Obj[]).map((x) => x.id), ["A3", "A4"], "só as depois da marca, que o wa_anotar guardou");
    assert.equal(r.marca, String(A4.ts));
    assert.match(String(r.para_o_claude), /anotacao_da_ia/);
    // Sem desde_o_ultimo_resumo, nada muda.
    const normal = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA) });
    assert.equal(normal.resumo_anterior, undefined);
    assert.equal(normal.compromissos_abertos, undefined);
    assert.equal(banco.idPublico(pn(ANA)), (normal.conversa as Obj).id);
  });

  it("wa_listar_conversas ganha compromissos_abertos e tem_resumo só onde há; wa_estado ganha memoria", async () => {
    const { c, banco } = await cenario();
    let l = await chamar(c, "wa_listar_conversas");
    for (const x of l.conversas as Obj[]) {
      assert.equal(x.compromissos_abertos, undefined);
      assert.equal(x.tem_resumo, undefined);
    }
    assert.deepEqual((await chamar(c, "wa_estado")).memoria, { conversas_com_resumo: 0, compromissos_abertos: 0 });
    await seisCompromissos(c);
    await anotar(c, { conversa: pn(BETO), resumo: "resumo", ate: String(B1.ts) });
    l = await chamar(c, "wa_listar_conversas");
    const por = (jid: string) => (l.conversas as Obj[]).find((x) => x.id === banco.idPublico(jid))!;
    assert.equal(por(pn(ANA)).compromissos_abertos, 3);
    assert.equal(por(pn(ANA)).tem_resumo, undefined);
    assert.equal(por(pn(BETO)).compromissos_abertos, 2);
    assert.equal(por(pn(BETO)).tem_resumo, true);
    assert.equal(por(GRUPO).compromissos_abertos, 1);
    assert.deepEqual((await chamar(c, "wa_estado")).memoria, { conversas_com_resumo: 1, compromissos_abertos: 6 });
  });

  it("o que OUTRA instância do banco na mesma pasta grava aparece", async () => {
    const { c } = await cenario();
    const outro = new Banco({ dir: m!.config.dirDados, chave: await new CofreEmMemoria(CHAVE_TESTE).obterChave() });
    outro.anotar(pn(ANA), { resumo: { texto: "do outro processo", ate: A2.ts }, compromissos: [{ tipo: "pedido", quem_deve: "dono", o_que: "contrato", mensagem_id: "A1", citacao: "Preciso assinar." }] }, AGORA);
    const r = await memoria(c, { conversa: pn(ANA) });
    assert.deepEqual(((r.resumo as Obj).anotacao_da_ia as Obj).texto, "do outro processo");
    assert.equal(lista(r).length, 1);
    await chamar(c, "wa_esquecer", { conversa: pn(ANA) });
    assert.equal(outro.resumoDaConversa(pn(ANA)), undefined, "e o que este apaga, o outro deixa de ver");
  });

  it("nada da memória em log, registro ou caixa-preta; nenhum arquivo novo na pasta de dados além do memoria.enc", async () => {
    const base = mkdtempSync(join(tmpdir(), "wa-memoria-"));
    pastas.push(base);
    const logs: string[] = [];
    const restaurar = trocarSaidaDoLog((l) => logs.push(l));
    try {
      const caixaPreta = new CaixaPreta({ dir: join(base, "logs"), saida: () => {} });
      m = await montar({ dir: base, agora: () => AGORA, caixaPreta });
      const { banco } = await m.ctx.nucleo();
      const ID = "MSGID-SIGILOSO-1";
      banco.gravarMensagens(pn(ANA), [mg(ID, "CITACAO-ULTRASSECRETA: te pago dia 20", em(12, 9))]);
      const { cliente, fechar } = await conectarCliente(m.ctx);
      fecharCliente = fechar;
      const dados = m.config.dirDados;
      const antes = new Set(readdirSync(dados));
      await anotar(cliente, {
        conversa: pn(ANA),
        resumo: "RESUMO-ULTRASSECRETO com o número 5511912345678",
        ate: String(em(12, 9)),
        compromissos: [comp({ o_que: "OQUE-ULTRASSECRETO", mensagem_id: ID, citacao: "CITACAO-ULTRASSECRETA: te pago dia 20", prazo: "2026-11-20" })],
      });
      const k = banco.compromissos()[0]!.id;
      await memoria(cliente);
      await memoria(cliente, { conversa: pn(ANA), incluir_fechados: true });
      await chamar(cliente, "wa_ler_conversa", { conversa: pn(ANA), desde_o_ultimo_resumo: true });
      await anotar(cliente, { conversa: pn(ANA), fechar: [{ id: k, estado: "cumprido", evidencia_mensagem_id: ID }] });
      await anotar(cliente, { conversa: pn(ANA), compromissos: [comp({ o_que: "OQUE-ULTRASSECRETO-2", mensagem_id: ID, citacao: "CITACAO-ULTRASSECRETA inventada" })] });
      await chamar(cliente, "wa_esquecer", { conversa: pn(ANA) });
      await chamar(cliente, "wa_esquecer", { tudo: true });
      const novos = readdirSync(dados).filter((f) => !antes.has(f));
      // marcas.enc já existia antes da 0.10.0 (a marca do resumo, que o resumo guarda junto); o único nome novo é memoria.enc.
      assert.ok(novos.every((f) => f === "memoria.enc" || f === "marcas.enc"), `arquivos novos: ${novos.join(", ")}`);
      assert.ok(!novos.some((f) => f.endsWith(".tmp")));
      // O arquivo cifrado não tem o texto às claras.
      await anotar(cliente, { conversa: pn(ANA), resumo: "RESUMO-ULTRASSECRETO", ate: String(em(12, 9)) });
      assert.ok(!readFileSync(join(dados, "memoria.enc"), "utf8").includes("ULTRASSECRET"));
      await fechar();
      fecharCliente = undefined;
      const arquivos = (p: string): string[] => (existsSync(p) ? readdirSync(p).flatMap((n) => (statSync(join(p, n)).isDirectory() ? arquivos(join(p, n)) : [join(p, n)])) : []);
      const textos = [...arquivos(m.config.dirLogs), ...arquivos(join(base, "logs"))].map((f) => readFileSync(f, "utf8"));
      assert.ok(textos.some((t) => t.includes("wa_anotar")), "o registro tem a ação");
      for (const t of [...textos, ...logs]) {
        for (const s of ["ULTRASSECRET", ID, ANA, k, "te pago"]) assert.ok(!t.includes(s), `vazou ${s}: ${t.slice(0, 200)}`);
      }
      const registro = readFileSync(m.caminhoRegistro, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Obj);
      const anotacoes = registro.filter((l) => l.acao === "wa_anotar");
      assert.deepEqual(Object.keys(anotacoes[0]!).sort(), ["acao", "conversa", "fechados", "gravados", "quando", "recusados", "resumo"]);
      assert.equal(anotacoes[0]!.conversa, banco.idPublico(pn(ANA)));
    } finally {
      restaurar();
    }
  });
});

// 0.15.1: a agenda automática (socket falso, rede bloqueada, relógio dos pedidos fixo, temporizador manual). Roda depois
// do pareamento (quando o histórico inicial termina ou 60 s depois de abrir) e na abertura da conexão se a última
// bem-sucedida tem mais de 7 dias; uma vez por abertura; respeita o freio de 10 min e o limite do dia (contados junto
// com o manual); falha ou tempo esgotado não derrubam nem repetem; a leitora não roda; wa_estado.contatos traz as datas;
// o desconectar apaga a data; a caixa-preta só com contagens.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DisconnectReason, proto } from "@whiskeysockets/baileys";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { AGENDA_AUTOMATICA_A_CADA_MS, ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS } from "../src/config.ts";
import { ANA, assentar, chamarCru, clicar, conectarCliente, DONO, montar, pn, RelogioFalso, textoDe, type Montagem } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Obj = Record<string, unknown>;

const NOME_DA_AGENDA = "Ana Teixeira Agenda";
const DIA = 24 * 60 * 60_000;

let montagens: Montagem[] = [];
let fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.reverse()) await f();
  fechamentos = [];
  for (const m of montagens.reverse()) await m.fechar();
  montagens = [];
});

/** Relógio dos pedidos: fixo, e o teste anda com ele. 14/11/2026, 10:00 local. */
let AGORA = 0;

const ressincronizacoes = (s: SocketFalso) => s.chamadas.filter((x) => x.metodo === "resyncAppState");

async function esperarAte(cond: () => boolean, limiteMs = 3_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error("a condição não chegou no tempo");
    await new Promise((pronto) => setTimeout(pronto, 10));
  }
}
/** Dá tempo a um disparo que NÃO deveria acontecer (o automático é assíncrono). */
const folga = () => new Promise((pronto) => setTimeout(pronto, 150));

type Celular = "agenda" | "erro" | "nunca";

/** O que o "celular" faz quando a agenda é pedida. Como a Baileys: os contatos saem depois de a função terminar. */
function ligarCelular(s: SocketFalso, celular: Celular = "agenda"): void {
  s.ligarRessincronizacao(async () => {
    if (celular === "nunca") return new Promise<void>(() => {});
    if (celular === "erro") throw Object.assign(new Error(`falhou para ${pn(ANA)}`), { name: "Boom" });
    setTimeout(() => s.emitir("contacts.upsert", [{ id: pn(ANA), name: NOME_DA_AGENDA }]), 20);
  });
}

interface Cenario {
  m: Montagem;
  relogio: RelogioFalso;
  caixa: Obj[];
}

async function montarDono(): Promise<Cenario> {
  AGORA = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const caixa: Obj[] = [];
  const relogio = new RelogioFalso();
  const m = await montar({
    agora: () => AGORA,
    temporizador: relogio,
    esperaDosContatosMs: 200,
    caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(lerLinha(l)) }),
  });
  montagens.push(m);
  return { m, relogio, caixa };
}

/** Parte e abre a conexão com o socket já sabendo ressincronizar (como a Baileys). */
async function abrirConexao(m: Montagem, celular: Celular = "agenda"): Promise<SocketFalso> {
  await m.ctx.partida();
  const s = m.socket();
  ligarCelular(s, celular);
  s.user = { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste" };
  s.abrir();
  return s;
}

/** Cai e volta (reconexão comum, sem pareamento): um socket novo que abre. */
async function reconectar(c: Cenario, celular: Celular = "agenda"): Promise<SocketFalso> {
  c.m.socket().fechar();
  c.relogio.avancar(60_000);
  const s = c.m.socket();
  ligarCelular(s, celular);
  s.user = { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste" };
  s.abrir();
  return s;
}

/** O pareamento acabou de dar certo: pair-success, a reconexão 515 e a primeira abertura depois dele. */
async function abrirDepoisDoPareamento(c: Cenario, celular: Celular = "agenda"): Promise<SocketFalso> {
  await c.m.ctx.partida();
  const primeiro = c.m.socket();
  primeiro.emitir("connection.update", { isNewLogin: true });
  primeiro.fechar(DisconnectReason.restartRequired);
  c.relogio.avancar(1_000);
  assert.equal(c.m.fabrica.sockets.length, 2, "reconectou depois do pair-success");
  const s = c.m.socket();
  ligarCelular(s, celular);
  s.user = { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste" };
  s.abrir();
  return s;
}

const historicoInicialTerminou = (s: SocketFalso, status: "complete" | "paused" = "complete") =>
  s.emitir("messaging-history.status", { syncType: proto.HistorySync.HistorySyncType.RECENT, status, explicit: status === "complete" });

/** A linha da caixa-preta vem como "[whatsapp-claude] caixa-preta: {json}". */
const lerLinha = (l: string): Obj => JSON.parse(l.slice(l.indexOf("{"))) as Obj;
const eventos = (caixa: Obj[]) => caixa.filter((l) => l.evento === "agenda_ressincronizada");

describe("0.15.1: agenda automática depois do pareamento", () => {
  it("espera o histórico inicial terminar, roda uma vez só (origem pareamento) e grava a data", async () => {
    const c = await montarDono();
    const s = await abrirDepoisDoPareamento(c);
    s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Aninha" })]);
    await assentar(c.m);
    await folga();
    assert.equal(ressincronizacoes(s).length, 0, "não roda antes do histórico inicial terminar");
    historicoInicialTerminou(s);
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.deepEqual(ressincronizacoes(s).map((x) => x.args), [[["critical_unblock_low"], false]]);
    const { banco } = await c.m.ctx.nucleo();
    assert.equal(banco.entrada(pn(ANA))!.nome, NOME_DA_AGENDA);
    assert.equal(banco.agendaAtualizadaEm(), AGORA);
    assert.equal(banco.contagemDoDia("contatos", AGORA), 1, "conta no limite do dia");
    const e = eventos(c.caixa)[0]!;
    assert.equal(e.origem, "pareamento");
    assert.equal(e.terminou, true);
    assert.equal(e.contatos_recebidos, 1);
    assert.equal(e.nomes_novos, 0, "a Ana já tinha o público: o da agenda é atualização");
    assert.equal(typeof e.duracao_ms, "number");
    // O histórico que "termina" de novo e o prazo de 60 s não repetem.
    historicoInicialTerminou(s, "paused");
    c.relogio.avancar(ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS);
    await folga();
    assert.equal(ressincronizacoes(s).length, 1, "uma vez só na mesma conexão");
  });

  it("sem o fim do histórico, roda 60 s depois de a conexão abrir; uma vez só", async () => {
    const c = await montarDono();
    const s = await abrirDepoisDoPareamento(c);
    c.relogio.avancar(ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS - 1_000);
    await folga();
    assert.equal(ressincronizacoes(s).length, 0);
    c.relogio.avancar(1_000);
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.equal(eventos(c.caixa)[0]!.origem, "pareamento");
    historicoInicialTerminou(s);
    await folga();
    assert.equal(ressincronizacoes(s).length, 1);
  });

  it("a conexão que abre depois (sem pareamento) não roda de novo: a data é recente", async () => {
    const c = await montarDono();
    const s = await abrirDepoisDoPareamento(c);
    historicoInicialTerminou(s);
    await esperarAte(() => eventos(c.caixa).length === 1);
    const s2 = await reconectar(c);
    await folga();
    assert.equal(ressincronizacoes(s2).length, 0);
    assert.equal(eventos(c.caixa).length, 1);
  });
});

describe("0.15.1: agenda automática semanal, na abertura da conexão", () => {
  it("sem data guardada, roda na abertura (origem periodica); não dispara por mensagem recebida", async () => {
    const c = await montarDono();
    const s = await abrirConexao(c.m);
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.equal(eventos(c.caixa)[0]!.origem, "periodica");
    s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi" })]);
    await assentar(c.m);
    await folga();
    assert.equal(ressincronizacoes(s).length, 1, "mensagem recebida não dispara");
  });

  it("não roda com a última há 7 dias ou menos; roda com mais de 7 dias", async () => {
    const c = await montarDono();
    const { banco } = await c.m.ctx.nucleo();
    banco.definirAgendaAtualizadaEm(AGORA - AGENDA_AUTOMATICA_A_CADA_MS);
    const s = await abrirConexao(c.m);
    await folga();
    assert.equal(ressincronizacoes(s).length, 0, "7 dias exatos: ainda não");
    AGORA += 1;
    const s2 = await reconectar(c);
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.equal(ressincronizacoes(s2).length, 1);
    assert.equal(banco.agendaAtualizadaEm(), AGORA, "a data nova");
    // Na semana seguinte, não antes.
    AGORA += 6 * DIA;
    const s3 = await reconectar(c);
    await folga();
    assert.equal(ressincronizacoes(s3).length, 0);
  });

  it("respeita o freio de 10 min (manual logo antes) e conta junto: o manual logo depois esbarra no freio", async () => {
    const c = await montarDono();
    c.m.ctx.ultimaAtualizacaoDeContatos = AGORA - 5 * 60_000;
    const s = await abrirConexao(c.m);
    await folga();
    assert.equal(ressincronizacoes(s).length, 0, "dentro dos 10 min: não roda");
    assert.equal(eventos(c.caixa).length, 0, "e não anota nada");
    // Passado o freio, na próxima abertura roda; o manual em seguida esbarra no mesmo freio.
    AGORA += 6 * 60_000;
    const s2 = await reconectar(c);
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.equal(ressincronizacoes(s2).length, 1);
    const { cliente, fechar } = await conectarCliente(c.m.ctx);
    fechamentos.push(fechar);
    const manual = await chamarCru(cliente, "wa_atualizar_contatos");
    assert.equal(manual.isError, true);
    assert.match(textoDe(manual), /espere 10 min/);
  });

  it("com o limite do dia esgotado, não roda e não dá erro", async () => {
    const c = await montarDono();
    const { banco } = await c.m.ctx.nucleo();
    for (let i = 0; i < 6; i++) banco.reservarContagens(AGORA, [{ tipo: "contatos", limite: 6, frase: "limite" }]);
    const s = await abrirConexao(c.m);
    await folga();
    assert.equal(ressincronizacoes(s).length, 0);
    assert.equal(eventos(c.caixa).length, 0);
    assert.equal(c.m.ctx.transporte!.estado().situacao, "conectado");
    assert.equal(banco.contagemDoDia("contatos", AGORA), 6);
  });

  it("erro do celular: anota (sem o texto do erro), não grava a data, não derruba e não repete na mesma conexão", async () => {
    const c = await montarDono();
    const s = await abrirConexao(c.m, "erro");
    await esperarAte(() => eventos(c.caixa).length === 1);
    const e = eventos(c.caixa)[0]!;
    assert.equal(e.terminou, true);
    assert.equal(e.com_erro, true);
    assert.ok(!JSON.stringify(e).includes(ANA), "nada do texto do erro");
    const { banco } = await c.m.ctx.nucleo();
    assert.equal(banco.agendaAtualizadaEm(), undefined);
    assert.equal(c.m.ctx.transporte!.estado().situacao, "conectado");
    historicoInicialTerminou(s);
    c.relogio.avancar(ESPERA_DA_AGENDA_DEPOIS_DO_PAREAMENTO_MS);
    await folga();
    assert.equal(ressincronizacoes(s).length, 1, "não tenta de novo na mesma conexão");
  });

  it("tempo esgotado: anota terminou false, sem data, e a conexão segue", async () => {
    const c = await montarDono();
    const s = await abrirConexao(c.m, "nunca");
    await esperarAte(() => eventos(c.caixa).length === 1);
    assert.equal(eventos(c.caixa)[0]!.terminou, false);
    const { banco } = await c.m.ctx.nucleo();
    assert.equal(banco.agendaAtualizadaEm(), undefined);
    assert.equal(c.m.ctx.transporte!.estado().situacao, "conectado");
    assert.equal(ressincronizacoes(s).length, 1);
  });

  it("socket sem a ressincronização: não roda, não gasta o freio nem anota", async () => {
    const c = await montarDono();
    await c.m.ctx.partida();
    const s = c.m.socket();
    s.abrir();
    await folga();
    const { banco } = await c.m.ctx.nucleo();
    assert.equal(banco.contagemDoDia("contatos", AGORA), 0);
    assert.equal(c.m.ctx.ultimaAtualizacaoDeContatos, undefined);
    assert.equal(eventos(c.caixa).length, 0);
  });
});

describe("0.15.1: leitora, wa_estado, desconectar e caixa-preta", () => {
  it("a cópia leitora não roda: não abre socket e não pede nada", async () => {
    const c = await montarDono();
    const s = await abrirConexao(c.m);
    await esperarAte(() => eventos(c.caixa).length === 1);
    const caixaDoLeitor: Obj[] = [];
    const leitor = await montar({ dir: c.m.dir, pareada: false, agora: () => AGORA + 8 * DIA, caixaPreta: new CaixaPreta({ saida: (l) => caixaDoLeitor.push(lerLinha(l)) }) });
    montagens.push(leitor);
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    leitor.ctx.agendaAutomatica.aoAbrir(false);
    await folga();
    assert.equal(leitor.fabrica.sockets.length, 0);
    assert.equal(ressincronizacoes(s).length, 1);
    assert.equal(eventos(caixaDoLeitor).length, 0);
  });

  it("wa_estado.contatos traz agenda_atualizada_em e proxima_automatica_em; o desconectar apaga a data", async () => {
    const c = await montarDono();
    const { cliente, fechar } = await conectarCliente(c.m.ctx);
    fechamentos.push(fechar);
    const antes = (await chamarCru(cliente, "wa_estado")).structuredContent!.contatos as Obj;
    assert.equal(antes.agenda_atualizada_em, null);
    assert.equal(antes.proxima_automatica_em, null);
    await abrirConexao(c.m);
    await esperarAte(() => eventos(c.caixa).length === 1);
    const depois = (await chamarCru(cliente, "wa_estado")).structuredContent!.contatos as Obj;
    assert.equal(depois.agenda_atualizada_em, new Date(AGORA).toISOString());
    assert.equal(depois.proxima_automatica_em, new Date(AGORA + AGENDA_AUTOMATICA_A_CADA_MS).toISOString());
    const r = await clicar(cliente, await chamarCru(cliente, "wa_desconectar"));
    assert.equal(r.isError, undefined, textoDe(r));
    await c.m.ctx.transporte!.esperar();
    const { banco } = await c.m.ctx.nucleo();
    assert.equal(banco.agendaAtualizadaEm(), undefined);
    const fim = (await chamarCru(cliente, "wa_estado")).structuredContent!.contatos as Obj;
    assert.equal(fim.agenda_atualizada_em, null);
  });

  it("caixa-preta só com contagens: nada de nome, número, jid ou LID", async () => {
    const c = await montarDono();
    const s = await abrirConexao(c.m);
    s.mensagens([msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Aninha" })]);
    await esperarAte(() => eventos(c.caixa).length === 1);
    const e = eventos(c.caixa)[0]!;
    assert.deepEqual(Object.keys(e).filter((k) => !["evento", "quando", "papel", "pid", "versao"].includes(k)).sort(), [
      "contatos_recebidos",
      "duracao_ms",
      "nomes_novos",
      "origem",
      "terminou",
    ]);
    const tudo = JSON.stringify(c.caixa);
    for (const p of [NOME_DA_AGENDA, "Teixeira", "Aninha", ANA, "912345678", DONO, "@s.whatsapp.net", "@lid"]) assert.ok(!tudo.includes(p), `a caixa-preta trouxe ${p}`);
  });
});

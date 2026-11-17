// 0.13.0: wa_buscar_historico com `ate_total` (Parte C), com o socket falso e o relógio falso (os 30 s entre pedidos
// correm no relógio do teste; a espera da resposta do celular é real e curta). Repete até o alvo, respeita os 30 s,
// progresso na segunda chamada, para quando o celular não responde, para no limite do dia (configurável), para ao tirar
// o grupo, dois trabalhos em paralelo e o terceiro recusado, para no encerrar; o limite diário lido do campo; e nada de
// jid, número, id, nome ou texto no log, na caixa-preta e no registro de ações.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { lerConfig, lerPedidosDeHistorico } from "../src/config.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { ANA, assentar, BETO, chamarCru, conectar, conectarCliente, DONO, GRUPO, montar, pn, RelogioFalso, textoDe, type Montagem, type OpcoesMontagem, type Resultado } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
let restaurarLog: (() => void) | undefined;
afterEach(async () => {
  restaurarLog?.();
  restaurarLog = undefined;
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const NOME_DO_GRUPO = "Turma Secreta";
const sc = (r: Resultado) => (r.structuredContent ?? {}) as Obj;

/** Espera (em tempo real, curto) até a condição valer. */
async function esperarAte(cond: () => boolean, oQue: string, limiteMs = 3_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error(`não aconteceu: ${oQue}`);
    await new Promise((pronto) => setTimeout(pronto, 5));
  }
}

interface Cena {
  s: SocketFalso;
  c: Cliente;
  relogio: RelogioFalso;
  caixa: string[];
  log: string[];
  pedidos: () => number;
}

/** Ana, Beto e o grupo escolhido, uma mensagem guardada cada. O celular responde com `quantidade` mensagens mais antigas. */
async function cenario(opcoes: OpcoesMontagem & { responde?: boolean } = {}): Promise<Cena> {
  const relogio = new RelogioFalso();
  const caixa: string[] = [];
  const log: string[] = [];
  restaurarLog = trocarSaidaDoLog((l) => log.push(l));
  m = await montar({ temporizador: relogio, esperaDoHistoricoMs: 30, caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(l) }), ...opcoes });
  const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: NOME_DO_GRUPO, size: 3, participants: [] } } });
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  const ts = Math.floor((Date.now() - 60_000) / 1000) * 1000;
  s.mensagens([
    msg({ jid: pn(ANA), id: "ANCORA-ANA", texto: "oi ana", nome: "Ana", ts }),
    msg({ jid: pn(BETO), id: "ANCORA-BETO", texto: "oi beto", nome: "Beto", ts }),
    msg({ jid: GRUPO, id: "ANCORA-GRUPO", texto: "oi grupo secreto", participante: pn(BETO), nome: "Beto", ts }),
  ]);
  await assentar(m);
  let n = 0;
  if (opcoes.responde ?? true) {
    s.aoPedirHistorico = (p) => {
      const jid = p.chave.remoteJid!;
      const antigas = Array.from({ length: p.quantidade }, (_, i) =>
        msg({ jid, id: `VELHA-${++n}`, texto: `mensagem velha ${n}`, ts: p.ts - (i + 1) * 60_000, ...(jid === GRUPO ? { participante: pn(ANA) } : {}) }),
      );
      s.historicoSobDemanda(antigas, { sessao: p.id });
    };
  }
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  const pedidos = () => s.chamadas.filter((x) => x.metodo === "fetchMessageHistory" || x.metodo === "sendPeerDataOperationMessage").length;
  return { s, c: cliente, relogio, caixa, log, pedidos };
}

const historico = (c: Cliente, args: Obj) => chamarCru(c, "wa_buscar_historico", args);
const guardadas = async (jid: string) => (await m!.ctx.nucleo()).banco.lerMensagens(jid).length;
const paradas = (caixa: string[]) => caixa.filter((l) => l.includes('"historico_em_lote"') && l.includes('"parou"'));

describe("0.13.0: ate_total em segundo plano", () => {
  it("repete de 50 em 50 até o alvo, respeitando os 30 s; a segunda chamada traz o progresso; terminado vem uma vez", async () => {
    const { c, relogio, pedidos, caixa } = await cenario();
    const args = { conversa: GRUPO, ate_total: 120 };
    const r1 = await historico(c, args);
    assert.equal(r1.isError, undefined, textoDe(r1));
    assert.equal(sc(r1).em_andamento, true);
    assert.equal(sc(r1).situacao, "em_andamento");
    assert.match(String(sc(r1).para_o_claude), /segundo plano/);
    await esperarAte(() => pedidos() === 1, "o primeiro pedido");
    await esperarAte(() => relogio.pendentes.some((ms) => ms === 30_000), "a espera de 30 s até o próximo pedido");
    assert.equal(await guardadas(GRUPO), 51);
    // Segunda chamada, mesmos argumentos: o progresso.
    const r2 = await historico(c, args);
    assert.deepEqual([sc(r2).situacao, sc(r2).pedidos_feitos, sc(r2).mensagens_novas, sc(r2).guardadas_agora], ["em_andamento", 1, 50, 51]);
    assert.ok(typeof sc(r2).proximo_pedido_em === "string");
    // Os 30 s: um tiquinho antes, nada; com os 30 s, o segundo pedido.
    relogio.avancar(29_999);
    await new Promise((pronto) => setTimeout(pronto, 30));
    assert.equal(pedidos(), 1, "antes dos 30 s, nenhum pedido novo");
    relogio.avancar(1);
    await esperarAte(() => pedidos() === 2, "o segundo pedido");
    await esperarAte(() => relogio.pendentes.some((ms) => ms === 30_000), "a espera do terceiro");
    relogio.avancar(30_000);
    await esperarAte(() => paradas(caixa).length === 1, "o fim do trabalho");
    assert.equal(pedidos(), 3);
    assert.equal(await guardadas(GRUPO), 151);
    const r3 = await historico(c, args);
    assert.deepEqual([sc(r3).situacao, sc(r3).parou_porque, sc(r3).pedidos_feitos, sc(r3).mensagens_novas], ["terminado", "alvo_atingido", 3, 150]);
    assert.match(String(sc(r3).para_o_claude), /Terminou/);
    // Depois de entregue, uma chamada nova começa outro trabalho; o alvo já está atingido: termina na hora, sem pedir.
    const r4 = await historico(c, args);
    assert.deepEqual([sc(r4).situacao, sc(r4).parou_porque, sc(r4).pedidos_feitos], ["terminado", "alvo_atingido", 0]);
    assert.equal(pedidos(), 3);
    assert.ok(caixa.some((l) => l.includes('"historico_em_lote"') && l.includes('"comecou"')));
  });

  it("para quando o celular não responde (dois pedidos seguidos sem resposta)", async () => {
    const { c, relogio, pedidos, caixa } = await cenario({ responde: false });
    await historico(c, { conversa: pn(ANA), ate_total: 500 });
    await esperarAte(() => pedidos() === 1 && relogio.pendentes.includes(30_000), "o primeiro pedido sem resposta e a espera");
    relogio.avancar(30_000);
    await esperarAte(() => paradas(caixa).length === 1, "a parada");
    const r = await historico(c, { conversa: pn(ANA), ate_total: 500 });
    assert.deepEqual([sc(r).parou_porque, sc(r).pedidos_feitos, sc(r).pedidos_sem_resposta, sc(r).mensagens_novas], ["celular_nao_respondeu", 2, 2, 0]);
    assert.match(String(sc(r).para_o_claude), /não respondeu/);
  });

  it("para no limite do dia, que é configurável (aqui 2); o pedido avulso diz o mesmo limite", async () => {
    const { c, relogio, pedidos, caixa } = await cenario({ pedidosDeHistoricoPorDia: 2 });
    await historico(c, { conversa: GRUPO, ate_total: 2_000 });
    await esperarAte(() => pedidos() === 1 && relogio.pendentes.includes(30_000), "o primeiro pedido");
    relogio.avancar(30_000);
    await esperarAte(() => pedidos() === 2 && relogio.pendentes.includes(30_000), "o segundo pedido");
    relogio.avancar(30_000);
    await esperarAte(() => paradas(caixa).length === 1, "a parada");
    assert.equal(pedidos(), 2);
    const r = await historico(c, { conversa: GRUPO, ate_total: 2_000 });
    assert.deepEqual([sc(r).parou_porque, sc(r).pedidos_feitos, sc(r).pedidos_de_historico_hoje, sc(r).limite_diario_de_pedidos], ["limite_do_dia", 2, 2, 2]);
    const avulso = await historico(c, { conversa: pn(BETO), quantidade: 5 });
    assert.equal(avulso.isError, true);
    assert.match(textoDe(avulso), /limite de 2 pedidos de histórico por dia/);
  });

  it("para ao tirar o grupo (sem esperar os 30 s) e o que estava guardado sai", async () => {
    const { c, relogio, pedidos, caixa } = await cenario();
    await historico(c, { conversa: GRUPO, ate_total: 1_000 });
    await esperarAte(() => pedidos() === 1 && relogio.pendentes.includes(30_000), "o primeiro pedido");
    const tirar = await chamarCru(c, "wa_escolher_grupos", { remover: [GRUPO] });
    assert.equal(tirar.isError, undefined, textoDe(tirar));
    await esperarAte(() => paradas(caixa).length === 1, "a parada");
    assert.match(paradas(caixa)[0]!, /"motivo":"conversa_saiu"/);
    assert.equal(m!.ctx.historicoEmLote.andando, 0);
    relogio.avancar(60_000);
    await new Promise((pronto) => setTimeout(pronto, 30));
    assert.equal(pedidos(), 1, "nenhum pedido depois de tirar o grupo");
    assert.equal(await guardadas(GRUPO), 0);
  });

  it("dois trabalhos em paralelo; o terceiro é recusado; o pedido avulso de uma conversa em trabalho também; encerrar para tudo", async () => {
    const { c, relogio, pedidos, caixa } = await cenario();
    assert.equal(sc(await historico(c, { conversa: pn(ANA), ate_total: 500 })).em_andamento, true);
    assert.equal(sc(await historico(c, { conversa: pn(BETO), ate_total: 500 })).em_andamento, true);
    await esperarAte(() => pedidos() === 2 && relogio.pendentes.filter((ms) => ms === 30_000).length === 2, "os dois primeiros pedidos");
    const terceiro = await historico(c, { conversa: GRUPO, ate_total: 500 });
    assert.equal(terceiro.isError, true);
    assert.match(textoDe(terceiro), /Já há 2 conversas buscando histórico/);
    const avulso = await historico(c, { conversa: pn(ANA), quantidade: 10 });
    assert.equal(avulso.isError, true);
    assert.match(textoDe(avulso), /segundo plano/);
    // Outro ate_total na mesma conversa: o que já anda vale, e a resposta diz.
    const outro = await historico(c, { conversa: pn(ANA), ate_total: 900 });
    assert.equal(sc(outro).ate_total, 500);
    assert.match(String(sc(outro).para_o_claude), /ate_total 500/);
    await m!.ctx.encerrar();
    await esperarAte(() => paradas(caixa).length === 2, "as duas paradas");
    assert.ok(paradas(caixa).every((l) => l.includes('"motivo":"encerrado"')));
  });

  it("sem ate_total, tudo como antes (a resposta do pedido avulso não fala em segundo plano)", async () => {
    const { c } = await cenario({ esperaDoHistoricoMs: 2_000 });
    const r = await historico(c, { conversa: pn(ANA), quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).novas, 10);
    assert.equal(sc(r).em_segundo_plano, undefined);
    assert.equal(sc(r).limite_diario_de_pedidos, 30);
  });

  it("nada de jid, número, id de mensagem, nome ou texto no log, na caixa-preta e no registro de ações", async () => {
    const { c, relogio, pedidos, caixa, log } = await cenario();
    await historico(c, { conversa: GRUPO, ate_total: 60 });
    await historico(c, { conversa: pn(ANA), ate_total: 51 });
    await esperarAte(() => pedidos() >= 2, "os pedidos");
    relogio.avancar(30_000);
    await esperarAte(() => paradas(caixa).length === 2, "as paradas");
    await historico(c, { conversa: GRUPO, ate_total: 60 });
    const registro = existsSync(m!.caminhoRegistro) ? readFileSync(m!.caminhoRegistro, "utf8") : "";
    const lotes = [...caixa.filter((l) => l.includes("historico_em_lote")), ...registro.split("\n").filter((l) => l.includes("historico_em_lote"))];
    assert.ok(lotes.length >= 4, "começo e fim na caixa-preta e no registro");
    for (const texto of lotes) {
      for (const proibido of [ANA, BETO, DONO, "@s.whatsapp.net", "@g.us", "@lid", "ANCORA-", "VELHA-", "mensagem velha", NOME_DO_GRUPO, "Ana", "Beto", "oi grupo"]) {
        assert.ok(!texto.includes(proibido), `${proibido} em: ${texto.slice(0, 200)}`);
      }
      assert.ok(!/[cg]_[0-9a-f]{12}/.test(texto), `id público em: ${texto.slice(0, 200)}`);
    }
    for (const linha of log) for (const proibido of [ANA, BETO, "ANCORA-", "VELHA-", NOME_DO_GRUPO]) assert.ok(!linha.includes(proibido), `${proibido} no log: ${linha.slice(0, 200)}`);
  });
});

describe("0.13.0: limite de pedidos de histórico por dia configurável", () => {
  it("WA_PEDIDOS_DE_HISTORICO_POR_DIA: padrão 30, de 1 a 500, inválido vale o padrão com aviso", () => {
    const avisos: string[] = [];
    assert.equal(lerPedidosDeHistorico("", avisos), 30);
    assert.equal(lerPedidosDeHistorico("120", avisos), 120);
    assert.equal(lerPedidosDeHistorico("500", avisos), 500);
    assert.equal(lerPedidosDeHistorico("45.0", avisos), 45);
    assert.deepEqual(avisos, []);
    assert.equal(lerPedidosDeHistorico("900", avisos), 500);
    assert.equal(lerPedidosDeHistorico("0", avisos), 30);
    assert.equal(lerPedidosDeHistorico("muitos", avisos), 30);
    assert.equal(avisos.length, 3);
    assert.equal(lerConfig({ WA_PEDIDOS_DE_HISTORICO_POR_DIA: "${user_config.WA_PEDIDOS_DE_HISTORICO_POR_DIA}" }).pedidosDeHistoricoPorDia, 30, "campo não preenchido");
    assert.equal(lerConfig({ WA_PEDIDOS_DE_HISTORICO_POR_DIA: "80" }).pedidosDeHistoricoPorDia, 80);
  });

  it("o campo do manifest: número de 1 a 500, padrão 30, título ASCII, e a descrição avisa do risco", async () => {
    const { readFileSync: ler } = await import("node:fs");
    const manifesto = JSON.parse(ler(new URL("../mcpb/manifest.json", import.meta.url), "utf8"));
    const campo = manifesto.user_config.WA_PEDIDOS_DE_HISTORICO_POR_DIA;
    assert.deepEqual([campo.type, campo.min, campo.max, campo.default, campo.required], ["number", 1, 500, 30, false]);
    assert.notEqual(campo.sensitive, true);
    assert.match(campo.title, /^[\x20-\x7e]+$/);
    assert.match(campo.description, /chamar a atenção do WhatsApp/);
    assert.equal(manifesto.server.mcp_config.env.WA_PEDIDOS_DE_HISTORICO_POR_DIA, "${user_config.WA_PEDIDOS_DE_HISTORICO_POR_DIA}");
  });
});

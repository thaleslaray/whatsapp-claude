// 0.7.2: diagnóstico do pedido de histórico (wa_buscar_historico). No WhatsApp real o pedido falhou 5 de 5 vezes sem
// rastro nenhum. Aqui: a resposta é reconhecida pelo id do pedido (mesmo vazia), a resposta atrasada é guardada e
// anotada, o diagnóstico (só tipos, contagens e nomes de campo) volta na resposta, e as variações do pedido mudam no
// modo auto depois de cada falha. Tudo com o socket falso, sem rede.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { proto, type WAMessage } from "@whiskeysockets/baileys";
import { trocarSaidaDoLog } from "../src/log.ts";
import { OBSERVACAO_DO_HISTORICO_MS } from "../src/transporte.ts";
import { ANA, assentar, BETO, chamarCru, conectar, conectarCliente, DONO, GRUPO, montar, pn, RelogioFalso, textoDe, type Montagem, type OpcoesMontagem, type Resultado } from "./ajuda.ts";
import { msg, type PedidoDeHistoricoFalso, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
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

/** Valores do cenário que nunca podem sair no diagnóstico, no log nem no registro. */
const LID_ANA = "99887766554433@lid";
const ID_DO_PEDIDO = "PEDIDO-SECRETO-77";
const ANCORA_ANA = "ANCORA-ANA-0001";
const ANCORA_BETO = "ANCORA-BETO-0001";
const ANCORA_GRUPO = "ANCORA-GRUPO-0001";
const OUTRO = "5511900001111";

const erroDe = (r: Resultado) => String(r.structuredContent?.erro ?? textoDe(r));
const sc = (r: Resultado) => r.structuredContent as Record<string, unknown>;
const diag = (r: Resultado) => sc(r).diagnostico as Record<string, unknown>;
const registro = (mm: Montagem): Array<Record<string, unknown>> =>
  readFileSync(mm.caminhoRegistro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

/** Ana (com LID conhecido pelo banco se `lidNoBanco`), Beto (sem LID) e o grupo Família escolhido, uma mensagem cada. */
async function cenario(opcoes: OpcoesMontagem & { lidNoBanco?: boolean } = {}): Promise<{ s: SocketFalso; c: Cliente; ts: number }> {
  m = await montar({ esperaDoHistoricoMs: 40, ...opcoes });
  const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família", size: 3, participants: [] } } });
  s.idDoPedidoDeHistorico = ID_DO_PEDIDO;
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  if (opcoes.lidNoBanco ?? true) banco.mapearLid(LID_ANA, pn(ANA));
  // Em segundos inteiros, como o messageTimestamp da Baileys (é o que o banco guarda).
  const ts = Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000;
  s.mensagens([
    msg({ jid: pn(ANA), id: ANCORA_ANA, texto: "oi", nome: "Ana", ts }),
    msg({ jid: pn(BETO), id: ANCORA_BETO, texto: "oi", nome: "Beto", ts }),
    msg({ jid: GRUPO, id: ANCORA_GRUPO, texto: "oi", participante: pn(BETO), ts }),
  ]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { s, c: cliente, ts };
}

/** O freio de 30 s usa o relógio de verdade: entre chamadas do mesmo teste, ele é zerado à mão. */
const semFreio = () => m!.ctx.ultimoHistorico.clear();
const pedidos = (s: SocketFalso) => s.chamadas.filter((x) => x.metodo === "fetchMessageHistory" || x.metodo === "sendPeerDataOperationMessage");
const antiga = (id: string, jid: string, ts: number) => msg({ jid, id, texto: `antiga ${id}`, ts });

describe("0.7.2: a resposta é reconhecida pelo id do pedido", () => {
  it("resposta ON_DEMAND vazia com o id do pedido conta: chegou, nada novo", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 2_000 });
    s.aoPedirHistorico = (p) => s.historicoSobDemanda([], { sessao: p.id });
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).chegou, true);
    assert.equal(sc(r).novas, 0);
    assert.match(String(sc(r).para_o_claude), /respondeu, mas não veio nada novo/);
    const eventos = diag(r).eventos_de_historico as Array<Record<string, unknown>>;
    assert.equal(eventos.length, 1);
    assert.deepEqual({ ...eventos[0], segundos_apos_o_pedido: 0 }, { tipo: 6, tem_id_de_pedido: true, id_bate: true, chats: 0, mensagens: 0, da_conversa_pedida: 0, segundos_apos_o_pedido: 0 });
    assert.equal(diag(r).pedido_enviado, true);
    // 0.7.3: Ana tem LID conhecido, então o auto começa pelo lid.
    assert.equal(sc(r).variacao_usada, "lid");
  });

  it("ON_DEMAND com outro id e sem nada da conversa pedida não conta, e nada é gravado", async () => {
    const { s, c, ts } = await cenario();
    const { banco } = await m!.ctx.nucleo();
    const antes = banco.lerMensagens(pn(ANA)).map((x) => x.id);
    s.aoPedirHistorico = () => s.historicoSobDemanda([antiga("X1", pn(OUTRO), ts - 1000)], { sessao: "OUTRO-PEDIDO", chats: [{ id: pn(OUTRO) }] });
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).chegou, false);
    await assentar(m!);
    assert.deepEqual(banco.lerMensagens(pn(ANA)).map((x) => x.id), antes);
    assert.equal(banco.lerMensagens(pn(OUTRO)).length, 0);
    const eventos = diag(r).eventos_de_historico as Array<Record<string, unknown>>;
    assert.equal(eventos[0]!.id_bate, false);
    assert.equal(eventos[0]!.tem_id_de_pedido, true);
    assert.equal(eventos[0]!.da_conversa_pedida, 0);
    // O texto não culpa só o celular e aponta o diagnóstico.
    assert.match(String(sc(r).para_o_claude), /Não chegou resposta reconhecida do celular/);
    assert.match(String(sc(r).para_o_claude), /diagnostico/);
  });

  it("a reserva continua: mensagem da conversa pedida com outro id é resposta", async () => {
    const { s, c, ts } = await cenario({ esperaDoHistoricoMs: 2_000 });
    s.aoPedirHistorico = () => s.historicoSobDemanda([antiga("H1", pn(ANA), ts - 1000)], { sessao: "OUTRO-PEDIDO" });
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 10 });
    assert.equal(sc(r).chegou, true);
    assert.equal(sc(r).novas, 1);
  });

  it("o pedido que não sai não espera: pedido_enviado false e o texto diz que não saiu", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 5_000 });
    s.falharPedidoDeHistorico = new Error(`falhou para ${pn(ANA)}`);
    const inicio = Date.now();
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.ok(Date.now() - inicio < 4_000, "não esperou os 5 s");
    assert.equal(diag(r).pedido_enviado, false);
    assert.match(String(sc(r).para_o_claude), /não saiu/);
  });
});

describe("0.7.2: variações do pedido", () => {
  it("cada variação monta o pedido certo", async () => {
    const { s, c, ts } = await cenario();
    const r1 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 7, variacao: "lid" });
    assert.equal(r1.isError, undefined, textoDe(r1));
    assert.equal(sc(r1).variacao_usada, "lid");
    const lid = pedidos(s).at(-1)!;
    assert.equal(lid.metodo, "fetchMessageHistory");
    assert.deepEqual(lid.args, [7, { remoteJid: LID_ANA, id: ANCORA_ANA, fromMe: false }, ts]);

    semFreio();
    await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 7, variacao: "segundos" });
    assert.deepEqual(pedidos(s).at(-1)!.args, [7, { remoteJid: pn(ANA), id: ANCORA_ANA, fromMe: false }, Math.floor(ts / 1000)]);

    semFreio();
    await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 7, variacao: "pn_com_conta" });
    const pdo = pedidos(s).at(-1)!;
    assert.equal(pdo.metodo, "sendPeerDataOperationMessage");
    assert.deepEqual(pdo.args[0], {
      historySyncOnDemandRequest: { chatJid: pn(ANA), oldestMsgFromMe: false, oldestMsgId: ANCORA_ANA, oldestMsgTimestampMs: ts, onDemandMsgCount: 7, accountLid: LID_ANA },
      peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND,
    });

    semFreio();
    await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 7, variacao: "padrao" });
    assert.deepEqual(pedidos(s).at(-1)!.args, [7, { remoteJid: pn(ANA), id: ANCORA_ANA, fromMe: false }, ts]);
  });

  it("o LID também vem da Baileys quando o banco não sabe", async () => {
    const { s, c } = await cenario({ lidNoBanco: false });
    s.lids.set(pn(ANA), LID_ANA);
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5, variacao: "lid" });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal((pedidos(s).at(-1)!.args[1] as Record<string, unknown>).remoteJid, LID_ANA);
  });

  it("variação pedida que não se aplica recusa com o porquê, sem gastar a contagem nem o freio", async () => {
    const { s, c } = await cenario();
    const semLid = await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5, variacao: "lid" });
    assert.equal(semLid.isError, true);
    assert.match(erroDe(semLid), /LID desta conversa ainda não é conhecido/);
    const grupo = await chamarCru(c, "wa_buscar_historico", { conversa: GRUPO, quantidade: 5, variacao: "pn_com_conta" });
    assert.equal(grupo.isError, true);
    assert.match(erroDe(grupo), /grupo/);
    s.sendPeerDataOperationMessage = undefined;
    const semPdo = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5, variacao: "pn_com_conta" });
    assert.equal(semPdo.isError, true);
    assert.match(erroDe(semPdo), /não permite/);
    assert.equal(pedidos(s).length, 0, "nada foi pedido");
    // Nem a contagem do dia nem o freio de 30 s foram gastos.
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).pedidos_de_historico_hoje, 1);
    assert.equal((await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5, variacao: "nao-existe" })).isError, true);
  });

  it("auto: roda na ordem depois de cada falha e fica na que funcionou", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 30 });
    const usadas: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      semFreio();
      const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
      assert.equal(r.isError, undefined, textoDe(r));
      assert.equal(sc(r).chegou, false);
      usadas.push(sc(r).variacao_usada);
    }
    // 0.7.3: com LID conhecido, começa pelo lid e dá a volta inteira.
    assert.deepEqual(usadas, ["lid", "pn_com_conta", "segundos", "padrao"]);
    // A próxima (lid) funciona: as seguintes ficam nela.
    s.aoPedirHistorico = (p) => s.historicoSobDemanda([], { sessao: p.id });
    for (let i = 0; i < 2; i++) {
      semFreio();
      const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
      assert.equal(sc(r).variacao_usada, "lid");
      assert.equal(sc(r).chegou, true);
    }
  });

  it("0.7.3: o auto começa pelo lid só em conversa individual com LID conhecido", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 30, lidNoBanco: false });
    // Sem LID conhecido (nem no banco, nem na Baileys): padrao.
    assert.equal(sc(await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 })).variacao_usada, "padrao");
    // Grupo: padrao.
    assert.equal(sc(await chamarCru(c, "wa_buscar_historico", { conversa: GRUPO, quantidade: 5 })).variacao_usada, "padrao");
    // LID pelo banco: lid, com o LID no remoteJid do pedido.
    const { banco } = await m!.ctx.nucleo();
    const LID_BETO = "11223344556677@lid";
    banco.mapearLid(LID_BETO, pn(BETO));
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5 });
    assert.equal(sc(r).variacao_usada, "lid");
    assert.equal((pedidos(s).at(-1)!.args[1] as Record<string, unknown>).remoteJid, LID_BETO);
    // LID pela Baileys numa conversa ainda sem pedido: também começa pelo lid.
    const { s: s2, c: c2 } = await (async () => {
      await fecharCliente?.();
      await m?.fechar();
      return cenario({ esperaDoHistoricoMs: 30, lidNoBanco: false });
    })();
    s2.lids.set(pn(ANA), LID_ANA);
    assert.equal(sc(await chamarCru(c2, "wa_buscar_historico", { conversa: ANA, quantidade: 5 })).variacao_usada, "lid");
  });

  it("auto pula o que não se aplica (conversa sem LID, grupo)", async () => {
    const { c } = await cenario({ esperaDoHistoricoMs: 30 });
    for (const conversa of [BETO, GRUPO]) {
      const usadas: unknown[] = [];
      for (let i = 0; i < 3; i++) {
        semFreio();
        usadas.push(sc(await chamarCru(c, "wa_buscar_historico", { conversa, quantidade: 5 })).variacao_usada);
      }
      assert.deepEqual(usadas, ["padrao", "segundos", "padrao"], conversa);
    }
  });
});

describe("0.7.2: resposta atrasada", () => {
  it("chega depois do tempo, dentro dos 120 s: é guardada e aparece (uma vez) na chamada seguinte", async () => {
    const relogio = new RelogioFalso();
    const { s, c, ts } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 30 });
    const r1 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(sc(r1).chegou, false);
    assert.ok(relogio.pendentes.includes(OBSERVACAO_DO_HISTORICO_MS), "observação de 120 s no relógio injetável");
    relogio.avancar(40_000);
    s.historicoSobDemanda([antiga("TARDE1", pn(ANA), ts - 2000), antiga("TARDE2", pn(ANA), ts - 1000)], { sessao: ID_DO_PEDIDO });
    s.recibo(ID_DO_PEDIDO, "peer_msg");
    await assentar(m!);
    const { banco } = await m!.ctx.nucleo();
    assert.deepEqual(banco.lerMensagens(pn(ANA)).slice(0, 2).map((x) => x.id), ["TARDE1", "TARDE2"]);
    semFreio();
    const r2 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.deepEqual(sc(r2).resposta_atrasada_do_pedido_anterior, { variacao: "lid", segundos_apos_o_pedido: 40, recebidas: 2, novas: 2, cortadas: 0 });
    assert.match(String(sc(r2).para_o_claude), /pedido anterior chegou depois do tempo/);
    const depois = sc(r2).diagnostico_do_pedido_anterior_depois_do_tempo as Record<string, unknown>;
    assert.equal(depois.recibo_do_celular, "peer_msg");
    assert.equal((depois.eventos_de_historico as unknown[]).length, 1);
    // O que chegou depois do tempo não muda o diagnóstico já devolvido.
    assert.equal(diag(r1).recibo_do_celular, null);
    // O auto ficou na variação que respondeu (lid, o ponto de partida da 0.7.3), mesmo atrasada.
    assert.equal(sc(r2).variacao_usada, "lid");
    semFreio();
    const r3 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(sc(r3).resposta_atrasada_do_pedido_anterior, undefined, "a anotação sai uma vez só");
  });

  it("depois dos 120 s a resposta não é mais aceita, e nenhum temporizador fica pendurado", async () => {
    const relogio = new RelogioFalso();
    const { s, c, ts } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 30 });
    await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    relogio.avancar(OBSERVACAO_DO_HISTORICO_MS + 1);
    assert.ok(!relogio.pendentes.some((x) => x > 0 && x <= OBSERVACAO_DO_HISTORICO_MS), String(relogio.pendentes));
    s.historicoSobDemanda([antiga("TARDE9", pn(ANA), ts - 1000)], { sessao: ID_DO_PEDIDO });
    await assentar(m!);
    const { banco } = await m!.ctx.nucleo();
    assert.ok(!banco.lerMensagens(pn(ANA)).some((x) => x.id === "TARDE9"));
  });

  it("o fechamento do transporte limpa a observação", async () => {
    const relogio = new RelogioFalso();
    const { c } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 30 });
    await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.ok(relogio.pendentes.includes(OBSERVACAO_DO_HISTORICO_MS));
    await m!.ctx.transporte!.fechar();
    assert.ok(!relogio.pendentes.includes(OBSERVACAO_DO_HISTORICO_MS));
  });
});

/** Uma mensagem de protocolo do próprio celular (como a Baileys entrega no messages.upsert). */
function protocolo(id: string, protocolMessage: Record<string, unknown>): WAMessage {
  return { key: { remoteJid: pn(DONO), fromMe: true, id }, messageTimestamp: Math.floor(Date.now() / 1000), message: { protocolMessage } } as unknown as WAMessage;
}

describe("0.7.2: diagnóstico", () => {
  it("ack, recibo, notificação de histórico e resposta PDO do pedido aparecem; os de outra mensagem não", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 80 });
    s.aoPedirHistorico = (p: PedidoDeHistoricoFalso) => {
      s.ack("OUTRA-MENSAGEM");
      s.recibo("OUTRA-MENSAGEM", "read");
      s.ack(p.id);
      s.recibo(p.id, "peer_msg");
      s.mensagens([
        protocolo("PDO-1", {
          type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
          peerDataOperationRequestResponseMessage: { stanzaId: p.id, peerDataOperationResult: [{ mediaUploadResult: 1 }, { placeholderMessageResendResponse: {} }] },
        }),
        protocolo("NOTIF-1", {
          type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
          historySyncNotification: { syncType: 6, peerDataRequestSessionId: p.id },
        }),
      ]);
      // Com requestId: o diagnóstico vê antes do retorno (e nada é gravado, como sempre).
      s.emitir("messages.upsert", {
        type: "notify",
        requestId: "R1",
        messages: [
          protocolo("PDO-2", {
            type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
            peerDataOperationRequestResponseMessage: { stanzaId: "OUTRO", peerDataOperationResult: [] },
          }),
        ],
      });
    };
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(r.isError, undefined, textoDe(r));
    const d = diag(r);
    assert.equal(d.ack_do_servidor, true);
    assert.equal(d.erro_no_ack, null);
    assert.equal(d.recibo_do_celular, "peer_msg");
    assert.deepEqual(d.respostas_pdo, [
      { id_bate: true, campos: ["mediaUploadResult", "placeholderMessageResendResponse"] },
      { id_bate: false, campos: [] },
    ]);
    assert.deepEqual((d.notificacoes_de_historico as Array<Record<string, unknown>>).map((n) => ({ ...n, segundos_apos_o_pedido: 0 })), [
      { tipo: 6, tem_id_de_pedido: true, id_bate: true, segundos_apos_o_pedido: 0 },
    ]);
    assert.equal(d.espera_ms, 80);
    assert.equal(d.variacao, "lid");
    const linha = registro(m!).find((l) => l.evento === "historico_pedido")!;
    assert.equal(linha.variacao, "lid");
    assert.equal(linha.ack, true);
    assert.equal(linha.recibo, "peer_msg");
  });

  it("o diagnóstico, o log e o registro não trazem jid, número, LID nem ids", async () => {
    const linhas: string[] = [];
    restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
    const relogio = new RelogioFalso();
    const { s, c, ts } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 40 });
    s.aoPedirHistorico = (p) => {
      s.ack(p.id, "479");
      s.recibo(p.id, "peer_msg");
      s.mensagens([
        protocolo("PDO-SECRETO-1", {
          type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
          peerDataOperationRequestResponseMessage: { stanzaId: p.id, peerDataOperationResult: [{ placeholderMessageResendResponse: {} }] },
        }),
      ]);
      s.historicoSobDemanda([antiga("X-SECRETO", pn(OUTRO), ts - 1000)], { sessao: "SESSAO-SECRETA", chats: [{ id: LID_ANA }, { id: pn(OUTRO) }] });
    };
    const saidas: string[] = [];
    for (const variacao of ["padrao", "lid", "pn_com_conta", "segundos", "auto"]) {
      semFreio();
      saidas.push(JSON.stringify(await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5, variacao })));
    }
    // Uma resposta atrasada e a chamada seguinte, que a conta.
    s.aoPedirHistorico = undefined;
    semFreio();
    saidas.push(JSON.stringify(await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5 })));
    relogio.avancar(30_000);
    s.historicoSobDemanda([antiga("TARDE-SECRETA", pn(BETO), ts - 1000)], { sessao: ID_DO_PEDIDO });
    await assentar(m!);
    semFreio();
    saidas.push(JSON.stringify(await chamarCru(c, "wa_buscar_historico", { conversa: BETO, quantidade: 5 })));
    await assentar(m!);
    assert.ok(saidas.some((t) => t.includes("resposta_atrasada_do_pedido_anterior")));
    assert.ok(linhas.some((l) => /histórico sob demanda: variação/.test(l)), "uma linha de log por pedido");
    assert.ok(linhas.some((l) => /resposta atrasada/.test(l)));
    const proibidos = [ANA, BETO, OUTRO, DONO, LID_ANA, LID_ANA.split("@")[0]!, ID_DO_PEDIDO, ANCORA_ANA, ANCORA_BETO, "PDO-SECRETO-1", "SESSAO-SECRETA", "X-SECRETO", "TARDE-SECRETA", "@s.whatsapp.net", "@lid"];
    const registroBruto = readFileSync(m!.caminhoRegistro, "utf8");
    for (const [onde, textos] of [["ferramenta", saidas], ["log", linhas], ["registro", [registroBruto]]] as const) {
      for (const texto of textos) for (const p of proibidos) assert.ok(!texto.includes(p), `${onde} traz ${p}: ${texto.slice(0, 200)}`);
    }
  });
});

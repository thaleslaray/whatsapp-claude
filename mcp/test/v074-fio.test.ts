// 0.7.4: laço livre na ingestão do histórico e diagnóstico do fio. No WhatsApp real, depois de parear uma conta grande,
// a caixa-preta registrou o laço de eventos travado por 31 s, e o pedido de histórico falhou 10 de 10 só com ack e
// recibo `peer_msg`. Aqui: a ingestão de um histórico grande devolve o controle ao laço sem mudar o que é gravado; o
// diagnóstico do pedido traz o resumo de cada nó do WebSocket, os avisos da biblioteca e se a conexão caiu; a
// caixa-preta registra conexão, histórico recebido e avisos; o wa_estado traz a plataforma do celular; e nada disso
// vaza jid, número, LID, id, nome ou texto. Sem rede e com o socket falso.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { ARQUIVO_DA_CAIXA_PRETA, CaixaPreta } from "../src/caixa-preta.ts";
import { criarLoggerDaBiblioteca, TAMANHO_DO_ANEL, textoDoAviso } from "../src/avisos-da-biblioteca.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { JANELA_DO_HISTORICO_RECEBIDO_MS, OBSERVACAO_DO_HISTORICO_MS } from "../src/transporte.ts";
import { ANA, assentar, BETO, chamar, chamarCru, conectar, conectarCliente, DONO, montar, pn, RelogioFalso, textoDe, type Montagem, type OpcoesMontagem, type Resultado } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
const restauracoes: Array<() => void> = [];
const pastas: string[] = [];
afterEach(async () => {
  for (const r of restauracoes.splice(0).reverse()) r();
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

const LID_DONO = "77665544332211@lid";
const LID_ANA = "99887766554433@lid";
const ID_DO_PEDIDO = "PEDIDO-SECRETO-74";
const ANCORA_ANA = "ANCORA-ANA-0074";
const OUTRO = "5511900001111";
const NOME_SECRETO = "Fulana Secreta";

const sc = (r: Resultado) => r.structuredContent as Record<string, unknown>;
const diag = (r: Resultado) => sc(r).diagnostico as Record<string, unknown>;
const nos = (o: Record<string, unknown>) => o.nos_recebidos as Array<Record<string, unknown>>;

function caixaPretaDeTeste(saida: (l: string) => void = () => {}): { cp: CaixaPreta; dir: string; linhas(): Array<Record<string, unknown>> } {
  const dir = mkdtempSync(join(tmpdir(), "wa-fio-"));
  pastas.push(dir);
  const cp = new CaixaPreta({ dir, pid: 74001, saida });
  return {
    cp,
    dir,
    linhas: () => {
      const c = join(dir, ARQUIVO_DA_CAIXA_PRETA);
      if (!existsSync(c)) return [];
      return readFileSync(c, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

/** Ana (com LID conhecido) e uma mensagem dela; o dono tem LID no socket. */
async function cenario(opcoes: OpcoesMontagem = {}): Promise<{ s: SocketFalso; c: Cliente; ts: number }> {
  m = await montar({ esperaDoHistoricoMs: 60, ...opcoes });
  const s = await conectar(m);
  s.user = { id: `${DONO}:7@s.whatsapp.net`, name: "Dono Teste", lid: `${LID_DONO.split("@")[0]}:7@lid` };
  s.idDoPedidoDeHistorico = ID_DO_PEDIDO;
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  banco.mapearLid(LID_ANA, pn(ANA));
  const ts = Math.floor((Date.now() - 5 * 60_000) / 1000) * 1000;
  s.mensagens([msg({ jid: pn(ANA), id: ANCORA_ANA, texto: "oi", nome: "Ana", ts })]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { s, c: cliente, ts };
}

const semFreio = () => m!.ctx.ultimoHistorico.clear();

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.4: a ingestão do histórico não trava o laço de eventos", () => {
  it("300 conversas x 40 mensagens: o temporizador de 50 ms dispara durante a ingestão, e o gravado é o de sempre", async () => {
    m = await montar();
    const s = await conectar(m);
    await assentar(m);
    const base = Math.floor((Date.now() - 24 * 3_600_000) / 1000) * 1000;
    const conversas = Array.from({ length: 300 }, (_, i) => `55119${String(i).padStart(8, "0")}`);
    const mensagens = [];
    // Intercaladas (como o celular manda: por data, não por conversa): a ordem de cada conversa sai pelo horário.
    for (let k = 0; k < 40; k++) for (const [i, n] of conversas.entries()) mensagens.push(msg({ jid: pn(n), id: `H-${i}-${k}`, texto: `m${k}`, ts: base + k * 60_000 + i }));
    const chats = conversas.slice(0, 50).map((n, i) => ({ id: pn(n), name: `Conversa ${i}`, unreadCount: i % 3 }));
    const contatos = conversas.slice(50, 100).map((n, i) => ({ id: pn(n), name: `Contato ${i}` }));

    let tiques = 0;
    const t = setInterval(() => tiques++, 50);
    try {
      const inicio = Date.now();
      s.historico({ messages: mensagens, chats, contacts: contatos });
      await assentar(m);
      const duracao = Date.now() - inicio;
      // Sem ceder, o temporizador só rodaria depois da ingestão inteira (0 tiques durante).
      assert.ok(tiques >= Math.min(3, Math.floor(duracao / 50) - 1), `tiques ${tiques} em ${duracao} ms`);
      assert.ok(tiques >= 2, `tiques ${tiques} em ${duracao} ms`);
    } finally {
      clearInterval(t);
    }

    const { banco } = await m.ctx.nucleo();
    for (const [i, n] of conversas.entries()) {
      const guardadas = banco.lerMensagens(pn(n));
      assert.deepEqual(
        guardadas.map((x) => x.id),
        Array.from({ length: 40 }, (_, k) => `H-${i}-${k}`),
        n,
      );
    }
    const lista = banco.listarConversas();
    assert.equal(lista.length, 300);
    const c7 = lista.find((e) => e.jid === pn(conversas[7]!))!;
    assert.equal(c7.nome, "Conversa 7");
    assert.equal(c7.nao_lidas, 7 % 3);
    assert.equal(lista.find((e) => e.jid === pn(conversas[60]!))!.nome, "Contato 10");
  });

  it("a fila ao vivo também cede, e a ordem continua a de chegada", async () => {
    m = await montar();
    const s = await conectar(m);
    await assentar(m);
    const ts = Math.floor((Date.now() - 60_000) / 1000) * 1000;
    let tiques = 0;
    const t = setInterval(() => tiques++, 1);
    try {
      s.mensagens(Array.from({ length: 200 }, (_, k) => msg({ jid: pn(ANA), id: `V-${k}`, texto: `v${k}`, ts: ts + k })), "append");
      await assentar(m);
    } finally {
      clearInterval(t);
    }
    const { banco } = await m.ctx.nucleo();
    assert.deepEqual(banco.lerMensagens(pn(ANA)).map((x) => x.id), Array.from({ length: 200 }, (_, k) => `V-${k}`));
    assert.ok(tiques >= 1, "o laço rodou temporizadores no meio da fila");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.4: os nós do WebSocket no diagnóstico do pedido", () => {
  it("cada nó vira tag, tipo, categoria, do_proprio_numero, offline e cifras; nada de id, from, participant ou notify", async () => {
    const { s, c } = await cenario({ esperaDoHistoricoMs: 80 });
    s.aoPedirHistorico = (p) => {
      s.ack(p.id);
      s.recibo(p.id, "peer_msg", pn(OUTRO));
      // Mensagem peer do próprio celular (pelo número), entregue offline, cifrada.
      s.no({ tag: "message", attrs: { id: "MSG-PEER-SECRETA", from: `${DONO}@s.whatsapp.net`, type: "text", category: "peer", offline: "1", notify: NOME_SECRETO, t: "1700000000" }, content: [{ tag: "enc", attrs: { type: "pkmsg", v: "2" }, content: new Uint8Array(4) }] });
      // Do próprio dono pelo LID, em outro aparelho (participant), e de outra pessoa.
      s.no({ tag: "message", attrs: { id: "MSG-2", from: LID_ANA, participant: `${LID_DONO.split("@")[0]}:3@lid`, type: "media" }, content: [{ tag: "enc", attrs: { type: "skmsg" } }, { tag: "enc", attrs: { type: "msg" } }] });
      s.no({ tag: "notification", attrs: { id: "N-1", from: pn(OUTRO), recipient: pn(DONO), type: "encrypt" } });
      s.no({ tag: "ib", attrs: {}, content: [{ tag: "offline", attrs: { count: "3" } }] });
      // Tipo fora do formato curto do protocolo vira "outro".
      s.no({ tag: "receipt", attrs: { id: "R-9", from: pn(OUTRO), type: `${pn(OUTRO)} lido` } });
    };
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(r.isError, undefined, textoDe(r));
    const lista = nos(diag(r)).map((n) => ({ ...n, segundos_apos_o_pedido: 0 }));
    const base = { tipo: null, categoria: null, do_proprio_numero: false, offline: false, cifras: [], segundos_apos_o_pedido: 0 };
    assert.deepEqual(lista, [
      { ...base, tag: "ack" },
      { ...base, tag: "receipt", tipo: "peer_msg" },
      { ...base, tag: "message", tipo: "text", categoria: "peer", do_proprio_numero: true, offline: true, cifras: ["pkmsg"] },
      { ...base, tag: "message", tipo: "media", do_proprio_numero: true, cifras: ["skmsg", "msg"] },
      { ...base, tag: "notification", tipo: "encrypt" },
      { ...base, tag: "ib" },
      { ...base, tag: "receipt", tipo: "outro" },
    ]);
    for (const n of nos(diag(r))) assert.deepEqual(Object.keys(n).sort(), ["categoria", "cifras", "do_proprio_numero", "offline", "segundos_apos_o_pedido", "tag", "tipo"]);
    assert.equal(diag(r).conexao_caiu_durante_o_pedido, false);
  });

  it("no máximo 60 por pedido; o que chega depois do tempo vai para o diagnóstico seguinte; os ouvintes saem com o socket", async () => {
    const relogio = new RelogioFalso();
    const { s, c } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 40 });
    s.aoPedirHistorico = () => {
      for (let i = 0; i < 80; i++) s.no({ tag: "presence", attrs: { from: pn(OUTRO), type: "available" } });
    };
    const r1 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(nos(diag(r1)).length, 60);
    // Na observação (depois do tempo).
    relogio.avancar(10_000);
    s.no({ tag: "message", attrs: { from: pn(DONO), category: "peer", type: "text" }, content: [{ tag: "enc", attrs: { type: "msg" } }] });
    s.aoPedirHistorico = undefined;
    semFreio();
    const r2 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    const depois = sc(r2).diagnostico_do_pedido_anterior_depois_do_tempo as Record<string, unknown>;
    assert.deepEqual(nos(depois).map((n) => ({ ...n, segundos_apos_o_pedido: 0 })), [
      { tag: "message", tipo: "text", categoria: "peer", do_proprio_numero: true, offline: false, cifras: ["msg"], segundos_apos_o_pedido: 0 },
    ]);
    assert.equal(nos(depois)[0]!.segundos_apos_o_pedido, 10);
    assert.equal(nos(diag(r1)).length, 60, "o diagnóstico já devolvido não muda");
    // Socket trocado (queda e reconexão): o `ws` velho fica sem os ouvintes.
    const ws = s.ws!;
    assert.equal(ws.listenerCount("frame"), 1);
    s.fechar(428);
    relogio.avancar(60_000);
    assert.equal(ws.listenerCount("frame"), 0);
    assert.equal(ws.listenerCount("CB:receipt"), 0);
    await m!.ctx.transporte!.fechar();
    assert.equal(m!.socket().ws!.listenerCount("frame"), 0);
  });

  it("sem pedido, nó nenhum é olhado", async () => {
    const { s } = await cenario();
    s.no({ tag: "message", attrs: { from: pn(DONO), category: "peer" } });
    // Nada a conferir além de não quebrar: sem pedido não há diagnóstico.
    assert.equal(s.ws!.listenerCount("frame"), 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.4: os avisos da biblioteca", () => {
  it("o logger não escreve nada, guarda só warn, error, fatal e a info da notificação de histórico, só o texto saneado", async () => {
    const escritas: string[] = [];
    const originalErr = process.stderr.write;
    const originalOut = process.stdout.write;
    const capturar = function (this: unknown, t: string | Uint8Array): boolean {
      escritas.push(String(t));
      return true;
    } as typeof process.stderr.write;
    process.stderr.write = capturar;
    process.stdout.write = capturar;
    const soltar = () => {
      process.stderr.write = originalErr;
      process.stdout.write = originalOut;
    };
    restauracoes.push(soltar);
    const { logger, anel } = criarLoggerDaBiblioteca();
    const filho = logger.child({ class: "baileys" });
    filho.trace({ x: 1 }, "rastro");
    filho.debug({ x: 1 }, "depuração");
    filho.info({ histNotification: { chave: "SEGREDO" } }, "Transitioned to Syncing state");
    filho.info({ histNotification: { chave: "SEGREDO" }, id: "ID-SECRETO" }, "got history notification");
    filho.warn({ key: { remoteJid: pn(ANA) }, err: new Error("x") }, "failed to decrypt message");
    filho.warn({ key: { remoteJid: pn(ANA) } }, "failed to decrypt message");
    logger.error({ node: `<message from="${pn(OUTRO)}"/>` }, `error in handling message ${pn(OUTRO)} from ${LID_ANA} id 3EB0123456789 total 42`);
    logger.fatal("Connection Terminated by Server");
    logger.warn({ só: "objeto" });
    soltar();
    assert.deepEqual(escritas, [], "nada no stdout nem no stderr");
    assert.equal(logger.level, "info");
    assert.deepEqual(anel.lista(), [
      { nivel: "info", texto: "got history notification", vezes: 1 },
      { nivel: "warn", texto: "failed to decrypt message", vezes: 2 },
      { nivel: "error", texto: "error in handling message ‹jid› from ‹jid› id 3EB total 42", vezes: 1 },
      { nivel: "fatal", texto: "Connection Terminated by Server", vezes: 1 },
      { nivel: "warn", texto: "sem texto", vezes: 1 },
    ]);
    assert.equal(textoDoAviso(`a b@c.d ${"x".repeat(300)}`).length, 160);
    assert.ok(!textoDoAviso("falhou em 5511912345678 e x@y").match(/\d{6}|@/));
    // Anel de 40.
    for (let i = 0; i < 50; i++) logger.warn({}, `aviso ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`);
    assert.equal(anel.lista().length, TAMANHO_DO_ANEL);
  });

  it("no diagnóstico do pedido (com as vezes) e na caixa-preta (um por texto a cada 60 s)", async () => {
    const relogio = new RelogioFalso();
    const caixa = caixaPretaDeTeste();
    const { s, c } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 40, caixaPreta: caixa.cp });
    s.aoPedirHistorico = () => {
      s.logar("warn", { key: { id: "X" } }, "failed to decrypt message");
      s.logar("warn", { key: { id: "Y" } }, "failed to decrypt message");
      s.logar("info", { histNotification: {} }, "got history notification");
      s.logar("info", {}, "Doing app state sync");
    };
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.deepEqual(diag(r).avisos_da_biblioteca, [
      { nivel: "warn", texto: "failed to decrypt message", vezes: 2 },
      { nivel: "info", texto: "got history notification", vezes: 1 },
    ]);
    // Depois do tempo: no diagnóstico seguinte.
    relogio.avancar(5_000);
    s.logar("error", { err: {} }, "error in handling message");
    s.aoPedirHistorico = undefined;
    semFreio();
    const r2 = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.deepEqual((sc(r2).diagnostico_do_pedido_anterior_depois_do_tempo as Record<string, unknown>).avisos_da_biblioteca, [{ nivel: "error", texto: "error in handling message", vezes: 1 }]);
    assert.deepEqual(m!.ctx.transporte!.avisosDaBiblioteca().map((a) => [a.texto, a.vezes]), [
      ["failed to decrypt message", 2],
      ["got history notification", 1],
      ["error in handling message", 1],
    ]);
    // Caixa-preta: o primeiro de cada texto na hora; os repetidos em 60 s só somam.
    const avisos = () => caixa.linhas().filter((l) => l.evento === "aviso_da_biblioteca");
    assert.deepEqual(avisos().map((l) => [l.nivel, l.texto, l.vezes]), [
      ["warn", "failed to decrypt message", 1],
      ["info", "got history notification", 1],
      ["error", "error in handling message", 1],
    ]);
    s.logar("warn", {}, "failed to decrypt message");
    relogio.avancar(61_000);
    s.logar("warn", {}, "failed to decrypt message");
    assert.deepEqual(avisos().at(-1), { ...avisos().at(-1), nivel: "warn", texto: "failed to decrypt message", vezes: 3 });
    assert.equal(avisos().length, 4);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.4: plataforma do celular, conexão e histórico recebido", () => {
  it("wa_estado traz celular.plataforma (creds.platform), desconhecida sem ela ou fora do formato", async () => {
    const { s, c } = await cenario();
    assert.deepEqual((await chamar(c, "wa_estado")).celular, { plataforma: "desconhecida", declarou_pronto_para_historico: false, registro_como: "navegador" });
    s.credenciais({ platform: "smbi" });
    await assentar(m!);
    assert.deepEqual((await chamar(c, "wa_estado")).celular, { plataforma: "smbi", declarou_pronto_para_historico: false, registro_como: "navegador" });
    s.credenciais({ platform: `${pn(ANA)}` });
    await assentar(m!);
    assert.deepEqual((await chamar(c, "wa_estado")).celular, { plataforma: "desconhecida", declarou_pronto_para_historico: false, registro_como: "navegador" });
  });

  it("caixa-preta: conexao_abriu e conexao_caiu (código e duração); o pedido diz que a conexão caiu", async () => {
    const relogio = new RelogioFalso();
    const caixa = caixaPretaDeTeste();
    const { s, c } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 60, caixaPreta: caixa.cp });
    relogio.avancar(30_000);
    s.aoPedirHistorico = () => s.fechar(428);
    const r = await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    assert.equal(diag(r).conexao_caiu_durante_o_pedido, true);
    relogio.avancar(2_000);
    const novo = m!.socket();
    assert.notEqual(novo, s);
    novo.abrir();
    const conexao = caixa.linhas().filter((l) => l.evento === "conexao_abriu" || l.evento === "conexao_caiu");
    assert.deepEqual(
      conexao.map((l) => ({ evento: l.evento, codigo: l.codigo, durou_s: l.durou_s, conexao_anterior_durou_s: l.conexao_anterior_durou_s, sem_conexao_s: l.sem_conexao_s })),
      [
        { evento: "conexao_abriu", codigo: undefined, durou_s: undefined, conexao_anterior_durou_s: null, sem_conexao_s: null },
        { evento: "conexao_caiu", codigo: 428, durou_s: 30, conexao_anterior_durou_s: undefined, sem_conexao_s: undefined },
        { evento: "conexao_abriu", codigo: undefined, durou_s: undefined, conexao_anterior_durou_s: 30, sem_conexao_s: 2 },
      ],
    );
    novo.fechar();
    assert.equal(caixa.linhas().at(-1)!.codigo, null);
  });

  it("caixa-preta: historico_recebido por evento, e a rajada somada por tipo a cada 5 s", async () => {
    const relogio = new RelogioFalso();
    const caixa = caixaPretaDeTeste();
    m = await montar({ temporizador: relogio, caixaPreta: caixa.cp });
    const s = await conectar(m);
    await assentar(m);
    const ts = Math.floor((Date.now() - 60_000) / 1000) * 1000;
    const lote = (prefixo: string, n: number) => Array.from({ length: n }, (_, k) => msg({ jid: pn(ANA), id: `${prefixo}-${k}`, ts: ts + k }));
    s.emitir("messaging-history.set", { chats: [{ id: pn(ANA) }], contacts: [], messages: lote("A", 3), syncType: 0, progress: 10 });
    await assentar(m);
    s.emitir("messaging-history.set", { chats: [], contacts: [], messages: lote("B", 2), syncType: 0, progress: 40 });
    await assentar(m);
    s.emitir("messaging-history.set", { chats: [{ id: pn(BETO) }], contacts: [], messages: lote("B", 2), syncType: 0, progress: 70 });
    await assentar(m);
    // Outro tipo não espera a janela do primeiro.
    s.emitir("messaging-history.set", { chats: [], contacts: [], messages: [], syncType: 3 });
    await assentar(m);
    const historicos = () => caixa.linhas().filter((l) => l.evento === "historico_recebido").map(({ quando: _q, pid: _p, versao: _v, papel: _pa, evento: _e, duracao_ms, ...resto }) => ({ ...resto, duracao_ok: typeof duracao_ms === "number" }));
    assert.deepEqual(historicos(), [
      { tipo: 0, progresso: 10, chats: 1, mensagens: 3, gravadas: 3, duracao_ok: true },
      { tipo: 3, chats: 0, mensagens: 0, gravadas: 0, duracao_ok: true },
    ]);
    relogio.avancar(JANELA_DO_HISTORICO_RECEBIDO_MS);
    assert.deepEqual(historicos().at(-1), { tipo: 0, progresso: 70, chats: 1, mensagens: 4, gravadas: 2, eventos: 2, duracao_ok: true });
    assert.equal(historicos().length, 3);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.4: nada vaza do fio", () => {
  it("nós, avisos, conexão e histórico com valores proibidos: nenhum aparece no diagnóstico, log, registro nem caixa-preta", async () => {
    const linhasDoLog: string[] = [];
    restauracoes.push(trocarSaidaDoLog((l) => linhasDoLog.push(l)));
    const relogio = new RelogioFalso();
    const caixa = caixaPretaDeTeste((l) => linhasDoLog.push(l));
    const { s, c, ts } = await cenario({ temporizador: relogio, esperaDoHistoricoMs: 60, caixaPreta: caixa.cp });
    s.credenciais({ platform: "android" });
    s.aoPedirHistorico = (p) => {
      s.ack(p.id, "479");
      s.recibo(p.id, "peer_msg", `${DONO}:2@s.whatsapp.net`);
      s.no({ tag: "message", attrs: { id: "MSG-PROIBIDA-1", from: pn(DONO), to: pn(OUTRO), recipient: LID_ANA, participant: pn(OUTRO), notify: NOME_SECRETO, category: "peer", type: "text", offline: "0", verified_name: NOME_SECRETO }, content: [{ tag: "enc", attrs: { type: "pkmsg", id: "ENC-PROIBIDO" }, content: new TextEncoder().encode("texto secreto") }] });
      s.no({ tag: `${OUTRO}`, attrs: { type: NOME_SECRETO, category: LID_ANA } });
      s.logar("warn", { key: { remoteJid: pn(OUTRO), id: "MSG-PROIBIDA-2" }, nome: NOME_SECRETO }, `failed to decrypt message from ${pn(OUTRO)} (${LID_ANA}) ${OUTRO}`);
      s.logar("error", { err: new Error(NOME_SECRETO) }, `error ${NOME_SECRETO.split(" ")[0]}@x ${ANA}`);
      s.logar("info", { histNotification: { peerDataRequestSessionId: ID_DO_PEDIDO } }, "got history notification");
      s.historicoSobDemanda([msg({ jid: pn(OUTRO), id: "MSG-PROIBIDA-3", texto: "texto secreto", nome: NOME_SECRETO, ts: ts - 1000 })], { sessao: "SESSAO-PROIBIDA", chats: [{ id: pn(OUTRO) }] });
      s.fechar(428);
    };
    const saidas: string[] = [];
    saidas.push(JSON.stringify(await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 })));
    relogio.avancar(3_000);
    const novo = m!.socket();
    novo.user = s.user;
    novo.abrir();
    novo.no({ tag: "message", attrs: { id: "MSG-PROIBIDA-4", from: pn(OUTRO), notify: NOME_SECRETO } });
    novo.logar("warn", { jid: pn(ANA) }, `stream errored out ${LID_ANA}`);
    novo.emitir("messaging-history.set", { chats: [{ id: pn(OUTRO), name: NOME_SECRETO }], contacts: [], messages: [msg({ jid: pn(OUTRO), id: "MSG-PROIBIDA-5", texto: "texto secreto", ts: ts - 2000 })], syncType: 3, progress: 100 });
    await assentar(m!);
    semFreio();
    saidas.push(JSON.stringify(await chamarCru(c, "wa_buscar_historico", { conversa: ANA, quantidade: 5 })));
    saidas.push(JSON.stringify(await chamar(c, "wa_estado")));
    relogio.avancar(JANELA_DO_HISTORICO_RECEBIDO_MS + OBSERVACAO_DO_HISTORICO_MS);
    await m!.ctx.transporte!.fechar();
    // Houve o que conferir.
    assert.ok(saidas.some((t) => t.includes("nos_recebidos")) && saidas.some((t) => t.includes("failed to decrypt message")));
    assert.ok(caixa.linhas().some((l) => l.evento === "aviso_da_biblioteca"));
    assert.ok(caixa.linhas().some((l) => l.evento === "historico_recebido"));
    assert.ok(caixa.linhas().some((l) => l.evento === "conexao_caiu"));
    const proibidos = [ANA, OUTRO, DONO, LID_ANA, LID_ANA.split("@")[0]!, LID_DONO.split("@")[0]!, ID_DO_PEDIDO, ANCORA_ANA, NOME_SECRETO, NOME_SECRETO.split(" ")[0]!, "MSG-PROIBIDA", "ENC-PROIBIDO", "SESSAO-PROIBIDA", "texto secreto", "@s.whatsapp.net", "@lid"];
    const registro = existsSync(m!.caminhoRegistro) ? readFileSync(m!.caminhoRegistro, "utf8") : "";
    const caixaBruta = readFileSync(join(caixa.dir, ARQUIVO_DA_CAIXA_PRETA), "utf8");
    for (const [onde, textos] of [["ferramenta", saidas], ["log", linhasDoLog], ["registro", [registro]], ["caixa-preta", [caixaBruta]]] as const) {
      for (const texto of textos) for (const p of proibidos) assert.ok(!texto.includes(p), `${onde} traz ${p}: ${texto.slice(0, 300)}`);
    }
  });
});

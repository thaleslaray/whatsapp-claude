// Transporte Baileys com socket falso: travas do Nod, listas do dono, códigos de parada, sessão e "nunca lida".

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { DisconnectReason, proto } from "@whiskeysockets/baileys";
import { esperaDaReconexao, PRAZO_DO_PAREAMENTO_MS } from "../src/transporte.ts";
import { ANA, assentar, BETO, conectar, DONO, GRUPO, montar, OUTRO_GRUPO, pn, RelogioFalso, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

let m: Montagem | undefined;
afterEach(async () => {
  await m?.fechar();
  m = undefined;
});

describe("sem sessão pareada", () => {
  it("não conecta: nenhum socket é criado e o estado é nao_pareado", async () => {
    m = await montar({ pareada: false });
    await m.ctx.partida();
    assert.equal(m.fabrica.sockets.length, 0);
    assert.equal(m.ctx.transporte?.estado().situacao, "nao_pareado");
  });

  it("o socket de verdade recusa rodar em teste (marca do setup)", async () => {
    const { criarSocketReal } = await import("../src/transporte.ts");
    assert.throws(() => criarSocketReal({} as never), /socket falso/);
  });
});

describe("configuração do socket (travas do Nod)", () => {
  it("passa todas as travas para a Baileys", async () => {
    m = await montar();
    await m.ctx.partida();
    const c = m.socket().config;
    assert.deepEqual(c.browser, ["Mac OS", "Chrome", "14.4.1"]);
    assert.equal(c.syncFullHistory, false);
    assert.equal(c.markOnlineOnConnect, false);
    assert.equal(c.emitOwnEvents, false);
    assert.equal(c.maxMsgRetryCount, 2, "desvio do Nod (0): pede reenvio do que não decifrou (revisão de segurança, A3)");
    assert.equal(c.enableAutoSessionRecreation, false);
    assert.equal(c.enableRecentMessageCache, false);
    assert.equal(c.qrTimeout, 60_000);
    assert.equal(await c.getMessage!({ id: "x" }), undefined, "só devolve resposta nossa (ver revisao.test.ts)");
    // 0.7.4: o logger continua sem escrever nada, mas guarda os avisos (avisos-da-biblioteca.ts); nível "info".
    assert.equal((c.logger as { level: string }).level, "info");
    const T = proto.HistorySync.HistorySyncType;
    assert.equal(c.shouldSyncHistoryMessage!({ syncType: T.FULL } as never), false);
    assert.equal(c.shouldSyncHistoryMessage!({ syncType: T.RECENT } as never), true);
    assert.equal(c.shouldSyncHistoryMessage!({ syncType: T.INITIAL_BOOTSTRAP } as never), true);
  });

  it("shouldIgnoreJid: grupos fora da lista, status, canais, listas de transmissão e a lista \"nunca ler\"", async () => {
    m = await montar();
    await m.ctx.partida();
    const ignorar = m.socket().config.shouldIgnoreJid!;
    const { banco } = await m.ctx.nucleo();
    assert.equal(ignorar(GRUPO), true);
    assert.equal(ignorar("status@broadcast"), true);
    assert.equal(ignorar("120363111111111111@newsletter"), true);
    assert.equal(ignorar("1234567890@broadcast"), true);
    assert.equal(ignorar(pn(ANA)), false);
    assert.equal(ignorar(`${ANA}:3@s.whatsapp.net`), false);
    banco.permitirGrupo(GRUPO);
    assert.equal(ignorar(GRUPO), false);
    assert.equal(ignorar(OUTRO_GRUPO), true);
    banco.mapearLid("99999000001@lid", pn(ANA));
    banco.bloquear(pn(ANA));
    assert.equal(ignorar(pn(ANA)), true);
    assert.equal(ignorar(`${ANA}:3@s.whatsapp.net`), true);
    assert.equal(ignorar("99999000001@lid"), true, "o LID da pessoa bloqueada também");
    assert.equal(ignorar(pn(BETO)), false);
  });
});

describe("o que nunca é gravado", () => {
  it("grupo fora da lista, status, canal e lista de transmissão", async () => {
    m = await montar();
    const s = await conectar(m);
    s.mensagens([
      msg({ jid: GRUPO, texto: "segredo do grupo", participante: pn(BETO) }),
      msg({ jid: "status@broadcast", texto: "status de alguém", participante: pn(BETO) }),
      msg({ jid: "120363111111111111@newsletter", texto: "canal" }),
      msg({ jid: "1234567890@broadcast", texto: "lista" }),
    ]);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    assert.equal(banco.listarConversas().length, 0);
    // 0.9.0: o Banco.buscar antigo saiu; nada do grupo fora da lista foi gravado.
    assert.equal(banco.lerMensagens(GRUPO).length, 0);
  });

  it("conversa na lista \"nunca ler\", pelo número, pelo LID com remoteJidAlt e pelo LID já mapeado", async () => {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    banco.bloquear(pn(ANA));
    s.mensagens([
      msg({ jid: pn(ANA), texto: "pelo número" }),
      msg({ jid: "88888000001@lid", jidAlt: pn(ANA), texto: "pelo LID com alt" }),
    ]);
    await assentar(m);
    s.mensagens([msg({ jid: "88888000001@lid", texto: "pelo LID mapeado" })]);
    await assentar(m);
    assert.equal(banco.listarConversas().length, 0);
    assert.equal(banco.lerMensagens("88888000001@lid").length, 0);
    assert.ok(banco.estaBloqueado("88888000001@lid"), "o LID entrou na lista junto");
  });

  it("eco de mensagem enviada (id guardado antes do envio) não vira mensagem, nem depois de reiniciar", async () => {
    m = await montar();
    const s = await conectar(m);
    await m.ctx.transporte!.registrarEnviado("ENVIADA-1");
    s.mensagens([msg({ jid: pn(ANA), id: "ENVIADA-1", deMim: true, texto: "minha resposta" }), msg({ jid: pn(ANA), id: "OUTRA", texto: "oi" })]);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    assert.deepEqual(banco.lerMensagens(pn(ANA)).map((x) => x.id), ["OUTRA"]);

    // Segundo processo com a mesma pasta: os IDs enviados foram persistidos (cifrados) na sessão.
    const dir = m.dir;
    await m.ctx.encerrar();
    const m2 = await montar({ dir, pareada: false });
    try {
      const s2 = await conectar(m2);
      s2.mensagens([msg({ jid: pn(BETO), id: "ENVIADA-1", deMim: true, texto: "eco atrasado" })]);
      await assentar(m2);
      assert.equal((await m2.ctx.nucleo()).banco.lerMensagens(pn(BETO)).length, 0);
    } finally {
      await m2.ctx.encerrar();
    }
  });
});

describe("o que é gravado", () => {
  it("individual ao vivo conta como não lida; mensagem minha do celular zera; nome público vira nome", async () => {
    m = await montar();
    const s = await conectar(m);
    s.mensagens([msg({ jid: pn(ANA), texto: "oi", nome: "Ana Paula" }), msg({ jid: pn(ANA), texto: "tudo bem?", nome: "Ana Paula" })]);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    assert.equal(banco.entrada(pn(ANA))?.nao_lidas, 2);
    assert.equal(banco.entrada(pn(ANA))?.nome, "Ana Paula");
    s.mensagens([msg({ jid: pn(ANA), texto: "tudo!", deMim: true })]);
    await assentar(m);
    assert.equal(banco.entrada(pn(ANA))?.nao_lidas, 0);
  });

  it("grupo da lista: grava com o remetente; mensagens só a partir da escolha", async () => {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    s.mensagens([msg({ jid: GRUPO, texto: "antes da escolha", participante: pn(BETO) })]);
    await assentar(m);
    banco.permitirGrupo(GRUPO);
    s.mensagens([msg({ jid: GRUPO, texto: "depois da escolha", participante: "77777000001@lid", participanteAlt: pn(BETO), nome: "Beto" })]);
    await assentar(m);
    const lidas = banco.lerMensagens(GRUPO);
    assert.deepEqual(lidas.map((x) => x.texto), ["depois da escolha"]);
    assert.deepEqual(lidas[0]!.remetente, { nome: "Beto", numero: BETO });
    assert.equal(banco.entrada(GRUPO)?.grupo, true);
  });

  it("LID sem número conhecido fica sob o LID e passa para o número quando o mapa chega", async () => {
    m = await montar();
    const s = await conectar(m);
    s.mensagens([msg({ jid: "66666000001@lid", texto: "oi pelo lid", nome: "Carla" })]);
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    assert.equal(banco.lerMensagens("66666000001@lid").length, 1);
    s.emitir("lid-mapping.update", { lid: "66666000001@lid", pn: pn(ANA) });
    await assentar(m);
    assert.equal(banco.lerMensagens("66666000001@lid").length, 0);
    assert.equal(banco.lerMensagens(pn(ANA))[0]?.texto, "oi pelo lid");
    assert.equal(banco.entrada(pn(ANA))?.nome, "Carla");
  });

  it("histórico respeita as listas e não conta como não lida (usa o unreadCount do celular)", async () => {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    banco.bloquear(pn(BETO));
    s.historico({
      messages: [
        msg({ jid: pn(ANA), texto: "histórico da Ana" }),
        msg({ jid: pn(BETO), texto: "histórico do Beto bloqueado" }),
        msg({ jid: GRUPO, texto: "histórico do grupo escolhido", participante: pn(ANA) }),
        msg({ jid: OUTRO_GRUPO, texto: "histórico de grupo fora da lista", participante: pn(ANA) }),
        msg({ jid: "status@broadcast", texto: "histórico de status", participante: pn(ANA) }),
        msg({ jid: "120363111111111111@newsletter", texto: "histórico de canal" }),
      ],
      chats: [{ id: pn(ANA), unreadCount: 3, name: "Ana do histórico" }, { id: OUTRO_GRUPO, unreadCount: 9, name: "Fora" }],
      contacts: [{ id: pn(BETO), name: "Beto Contato" }],
    });
    await assentar(m);
    const jids = banco.listarConversas().map((c) => c.jid).sort();
    assert.deepEqual(jids, [GRUPO, pn(ANA)].sort());
    assert.equal(banco.entrada(pn(ANA))?.nao_lidas, 3);
    assert.equal(banco.entrada(pn(ANA))?.nome, "Ana do histórico");
    assert.equal(banco.nomeConhecido(pn(BETO)), undefined, "nem o nome de quem está bloqueado é guardado");
    // 0.9.0: o Banco.buscar antigo saiu; o grupo fora da lista e o contato bloqueado não têm nada gravado.
    assert.equal(banco.lerMensagens(OUTRO_GRUPO).length, 0);
    assert.equal(banco.lerMensagens(pn(BETO)).length, 0);
  });

  it("guarda no máximo 500 mensagens por conversa (as mais recentes), sem apagar por tempo", async () => {
    m = await montar();
    const s = await conectar(m);
    const base = Date.now() - 400 * 24 * 3600_000; // mais de um ano atrás: não some por tempo
    const lote = Array.from({ length: 520 }, (_, i) => msg({ jid: pn(ANA), id: `H${i}`, texto: `n${i}`, ts: base + i * 1000 }));
    s.historico({ messages: lote });
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    const guardadas = banco.lerMensagens(pn(ANA));
    assert.equal(guardadas.length, 500);
    assert.equal(guardadas[0]!.id, "H20");
    assert.equal(guardadas[499]!.id, "H519");
    s.mensagens([msg({ jid: pn(ANA), id: "NOVA", texto: "nova" })]);
    await assentar(m);
    const depois = banco.lerMensagens(pn(ANA));
    assert.equal(depois.length, 500);
    assert.equal(depois[499]!.id, "NOVA");
    assert.equal(depois[0]!.id, "H21");
  });
});

describe("desconexões", () => {
  for (const [nome, codigo] of [
    ["connectionReplaced", DisconnectReason.connectionReplaced],
    ["forbidden", DisconnectReason.forbidden],
    ["multideviceMismatch", DisconnectReason.multideviceMismatch],
  ] as const) {
    it(`${nome} (${codigo}) para de vez, sem reconectar`, async () => {
      const relogio = new RelogioFalso();
      m = await montar({ temporizador: relogio });
      const s = await conectar(m);
      s.fechar(codigo);
      relogio.avancar(10 * 60_000);
      assert.equal(m.fabrica.sockets.length, 1, "não criou outro socket");
      assert.equal(relogio.pendentes.length, 0, "nenhuma reconexão agendada");
      const e = m.ctx.transporte!.estado();
      assert.equal(e.situacao, "parado");
      assert.equal(e.codigo, codigo);
      assert.ok(s.encerrado);
      assert.ok((await m.ctx.nucleo()).sessao.temArquivos(), "a sessão continua guardada");
    });
  }

  it("loggedOut para e apaga a sessão", async () => {
    const relogio = new RelogioFalso();
    m = await montar({ temporizador: relogio });
    const s = await conectar(m);
    s.fechar(DisconnectReason.loggedOut);
    await assentar(m);
    const { sessao } = await m.ctx.nucleo();
    await sessao.esperar();
    assert.equal(sessao.temArquivos(), false);
    assert.equal(await sessao.pareada(), false);
    assert.equal(m.ctx.transporte!.estado().situacao, "sessao_encerrada");
    relogio.avancar(10 * 60_000);
    assert.equal(m.fabrica.sockets.length, 1);
  });

  it("outras quedas reconectam com espera crescente até 60 s", async () => {
    const relogio = new RelogioFalso();
    m = await montar({ temporizador: relogio });
    await conectar(m);
    const esperas: number[] = [];
    for (let i = 0; i < 8; i++) {
      m.socket().fechar(DisconnectReason.connectionLost);
      esperas.push(relogio.pendentes[0]!);
      relogio.avancar(relogio.pendentes[0]!);
    }
    assert.deepEqual(esperas, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    assert.equal(m.fabrica.sockets.length, 9);
    assert.equal(esperaDaReconexao(100), 60_000);
    // Conectou de novo: a espera volta ao começo.
    m.socket().abrir();
    m.socket().fechar(DisconnectReason.restartRequired);
    assert.equal(relogio.pendentes[0], 1000);
  });

  it("sessão guardada que recebe QR para (QR só no cartão de pareamento)", async () => {
    m = await montar();
    await m.ctx.partida();
    m.socket().qr();
    const e = m.ctx.transporte!.estado();
    assert.equal(e.situacao, "parado");
    assert.equal(e.qr, undefined);
  });

  it("pareamento (Fase 2): QR vale 60 s e, sem concluir em 5 min, a sessão é apagada", async () => {
    const relogio = new RelogioFalso();
    m = await montar({ pareada: false, temporizador: relogio });
    m.ctx.lock.tentar();
    await m.ctx.partida();
    await m.ctx.transporte!.iniciar({ parear: true });
    m.socket().qr("2@QR");
    const e = m.ctx.transporte!.estado();
    assert.equal(e.situacao, "aguardando_qr");
    assert.equal(e.qr, "2@QR");
    assert.equal(new Date(e.expira_em!).getTime() - relogio.agoraMs, 60_000);
    const { sessao } = await m.ctx.nucleo();
    await m.ctx.transporte!.esperar();
    assert.ok(sessao.temArquivos(), "credenciais iniciais gravadas");
    relogio.avancar(PRAZO_DO_PAREAMENTO_MS);
    await sessao.esperar();
    await m.ctx.transporte!.esperar();
    assert.equal(m.ctx.transporte!.estado().situacao, "expirado");
    assert.equal(sessao.temArquivos(), false);
  });
});

describe("nunca marca como lida", () => {
  it("não chama readMessages, sendReceipt nem presença available; readMessages do socket recusa", async () => {
    m = await montar();
    const s = await conectar(m);
    s.mensagens([msg({ jid: pn(ANA), texto: "oi" })]);
    s.historico({ messages: [msg({ jid: pn(BETO), texto: "antiga" })] });
    await assentar(m);
    await (await import("./ajuda.ts")).conectarCliente(m.ctx).then(async ({ cliente, fechar }) => {
      try {
        await cliente.callTool({ name: "wa_ler_conversa", arguments: { conversa: pn(ANA).split("@")[0]! } });
        await cliente.callTool({ name: "wa_listar_conversas", arguments: {} });
      } finally {
        await fechar();
      }
    });
    const proibidos = s.chamadas.filter(
      (c) => c.metodo === "readMessages" || c.metodo === "sendReceipt" || (c.metodo === "sendPresenceUpdate" && c.args[0] === "available"),
    );
    assert.deepEqual(proibidos, []);
    await assert.rejects(() => (s as unknown as { readMessages: (k: unknown[]) => Promise<void> }).readMessages([]), /nunca marca/);
    assert.equal(s.config.markOnlineOnConnect, false);
  });

  it("o código-fonte não chama readMessages, sendReceipt, chatModify nem presença available; histórico sob demanda só no transporte", () => {
    const raiz = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
    const arquivos = (pasta: string): string[] =>
      readdirSync(pasta).flatMap((n) => {
        const c = join(pasta, n);
        return statSync(c).isDirectory() ? arquivos(c) : c.endsWith(".ts") ? [c] : [];
      });
    for (const arquivo of arquivos(raiz)) {
      const codigo = readFileSync(arquivo, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.ok(!/\.readMessages\s*\(|\bsendReceipts?\s*\(|\bchatModify\s*\(/.test(codigo), `${arquivo} chama algo proibido`);
      // 0.7.0: pedir histórico ao celular só pelo transporte (buscarHistorico, que guarda só o que ESTE processo pediu).
      if (!arquivo.endsWith("transporte.ts")) assert.ok(!/\.fetchMessageHistory\s*\(/.test(codigo), `${arquivo} pede histórico fora do transporte`);
      assert.ok(!/sendPresenceUpdate\(\s*["'`]available/.test(codigo), `${arquivo} fica online`);
      assert.ok(!/markOnlineOnConnect:\s*true|syncFullHistory:\s*true/.test(codigo), `${arquivo} liga online/histórico completo`);
    }
  });
});

describe("dono do número", () => {
  it("o estado conectado traz o número e o nome do dono", async () => {
    m = await montar();
    await conectar(m);
    const e = m.ctx.transporte!.estado();
    assert.equal(e.situacao, "conectado");
    assert.equal(e.numero, DONO);
  });
});

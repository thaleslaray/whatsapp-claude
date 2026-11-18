// Fase 2: wa_parear (aviso de risco, QR no cartão, "Conectado como …"), wa_desconectar e loggedOut.
// Socket falso e relógio falso: nada conecta ao WhatsApp e nenhum QR real é gerado (o QR é uma string de teste).

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { DisconnectReason } from "@whiskeysockets/baileys";
import { trocarSaidaDoLog } from "../src/log.ts";
import { PRAZO_DO_PAREAMENTO_MS } from "../src/transporte.ts";
import { ANA, assentar, chamarCru, clicar, conectar, conectarCliente, DONO, GRUPO, ligarEnvio, montar, pedidoDa, pn, RelogioFalso, textoDe, type Montagem, type Resultado } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";
import { validarMatriz } from "../ui/qr.js";

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

const QR = "2@QR-DE-TESTE-NAO-REAL,chave-publica-falsa,identidade-falsa,segredo-falso";

/** Sem sessão, com relógio falso e cliente com cartão. */
async function semSessao(): Promise<{ c: Cliente; relogio: RelogioFalso; linhas: string[] }> {
  const relogio = new RelogioFalso();
  const linhas: string[] = [];
  restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
  m = await montar({ pareada: false, temporizador: relogio, agora: () => relogio.agora() });
  await m.ctx.partida();
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, relogio, linhas };
}

const estadoDoPareamento = (c: Cliente, previa: Resultado) => chamarCru(c, "wa_estado_pareamento_tela", { id: pedidoDa(previa).id });

describe("wa_parear", () => {
  it("etapa 1: aviso de risco e o botão \"Entendo o risco, mostrar o QR\"; sem o clique nada conecta", async () => {
    const { c } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as { tipo: string; botao: string; riscos: string[]; detalhes: string[] };
    assert.equal(p.tipo, "parear");
    assert.equal(p.botao, "Entendo o risco, mostrar o QR");
    const riscos = p.riscos.join(" ");
    for (const trecho of [/não oficial/i, /viola os Termos/, /restringir ou banir/, /número secundário/]) assert.match(riscos, trecho);
    assert.match(String(previa.structuredContent!.para_o_claude), /Pare aqui e espere o clique/);

    assert.equal(m!.fabrica.sockets.length, 0, "sem clique, nenhum socket");
    const antes = await estadoDoPareamento(c, previa);
    assert.equal(antes.structuredContent!.etapa, "aguardando_clique");
    assert.equal(antes._meta, undefined);

    // O modelo sem o código do clique não pareia (desde a 0.5.0 o wa_confirmar aceita o pareamento, mas só com o código
    // que o clique no cartão manda no chat; ver v050.test.ts).
    const semCodigo = await chamarCru(c, "wa_confirmar", { id: pedidoDa(previa).id, codigo: "0".repeat(32) });
    assert.equal(semCodigo.isError, true);
    assert.equal(m!.fabrica.sockets.length, 0);

    // Cancelar também não conecta.
    await chamarCru(c, "wa_cancelar_pedido", { id: pedidoDa(previa).id });
    assert.equal((await clicar(c, previa)).isError, true);
    assert.equal(m!.fabrica.sockets.length, 0);
    assert.equal((await m!.ctx.nucleo()).sessao.temArquivos(), false, "nem credenciais foram criadas");
  });

  it("etapa 2 e 3: o clique conecta, o QR vai para o cartão (só no _meta, como matriz), contagem de 60 s, e \"Conectado como\"", async () => {
    const { c, relogio, linhas } = await semSessao();
    const visiveis: string[] = []; // tudo o que o modelo poderia ler
    const previa = await chamarCru(c, "wa_parear");
    visiveis.push(JSON.stringify(previa.structuredContent), textoDe(previa));
    const clique = await clicar(c, previa);
    assert.equal(clique.isError, undefined, textoDe(clique));
    visiveis.push(JSON.stringify(clique.structuredContent), textoDe(clique));
    assert.equal(m!.fabrica.sockets.length, 1, "o clique abriu o socket");
    const s = m!.socket();
    assert.equal(s.config.markOnlineOnConnect, false);

    const gerando = await estadoDoPareamento(c, previa);
    assert.equal(gerando.structuredContent!.etapa, "gerando_qr");

    s.qr(QR);
    const comQr = await estadoDoPareamento(c, previa);
    assert.equal(comQr.structuredContent!.etapa, "qr");
    assert.equal(comQr.structuredContent!.segundos_restantes, 60);
    const matriz = comQr._meta!.qr_matriz as { tamanho: number; linhas: string[] };
    assert.ok(validarMatriz(matriz), "matriz de QR válida");
    assert.ok(!JSON.stringify(matriz).includes(QR), "a matriz não carrega o texto do QR");
    assert.ok(!JSON.stringify(comQr.structuredContent).includes(QR) && !textoDe(comQr).includes(QR));
    assert.ok(!JSON.stringify(comQr.structuredContent).includes("linhas"), "a matriz também não vai no structuredContent");

    relogio.avancar(20_000);
    assert.equal((await estadoDoPareamento(c, previa)).structuredContent!.segundos_restantes, 40);
    s.qr(`${QR}-2`); // o WhatsApp manda um QR novo a cada 60 s
    const novo = await estadoDoPareamento(c, previa);
    assert.equal(novo.structuredContent!.segundos_restantes, 60);
    assert.notDeepEqual(novo._meta!.qr_matriz, matriz, "QR novo, matriz nova");

    // O modelo pergunta como está: vê a etapa, nunca o QR.
    for (const nome of ["wa_estado", "wa_listar_conversas", "wa_listar_grupos"]) {
      const r = await chamarCru(c, nome);
      visiveis.push(JSON.stringify(r));
    }
    const estado = await chamarCru(c, "wa_estado");
    assert.equal(estado.structuredContent!.situacao, "aguardando_qr");
    assert.match(String(estado.structuredContent!.para_o_claude), /QR está no cartão/);

    // O celular lê o QR: a Baileys grava o `me`, reinicia (515) e conecta.
    s.emitir("connection.update", { isNewLogin: true });
    assert.equal((await estadoDoPareamento(c, previa)).structuredContent!.etapa, "conectando");
    s.emitir("creds.update", { me: { id: `${DONO}:9@s.whatsapp.net`, name: "Dono Teste" } });
    s.fechar(DisconnectReason.restartRequired);
    assert.equal((await estadoDoPareamento(c, previa)).structuredContent!.etapa, "conectando");
    relogio.avancar(1_000);
    assert.equal(m!.fabrica.sockets.length, 2, "reconectou com as credenciais novas");
    m!.socket().abrir();
    await assentar(m!);
    const pronto = await estadoDoPareamento(c, previa);
    assert.equal(pronto.structuredContent!.etapa, "conectado");
    assert.equal(pronto.structuredContent!.conectado_como, "+55 11 98888-7777 (Dono Teste)");
    assert.match(textoDe(pronto), /^Conectado como \+55 11 98888-7777/);
    relogio.avancar(PRAZO_DO_PAREAMENTO_MS);
    assert.equal(m!.ctx.transporte!.estado().situacao, "conectado", "o prazo de 5 min foi cancelado ao conectar");
    const { sessao } = await m!.ctx.nucleo();
    await sessao.esperar();
    assert.equal(await sessao.pareada(), true);
    const depois = await chamarCru(c, "wa_parear");
    assert.equal(depois.isError, true, "com sessão salva, wa_parear recusa");
    assert.match(String(depois.structuredContent!.erro), /já está pareado/);

    // Nada do que o modelo pode ler, nem o log, nem o registro de ações, tem o QR.
    for (const t of [...visiveis, ...linhas, existsSync(m!.caminhoRegistro) ? readFileSync(m!.caminhoRegistro, "utf8") : ""]) {
      assert.ok(!t.includes(QR) && !t.includes("QR-DE-TESTE"), `o QR vazou: ${t.slice(0, 120)}`);
    }
  });

  it("pareamento não concluído em 5 minutos apaga a sessão; dá para começar de novo", async () => {
    const { c, relogio } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    await clicar(c, previa);
    m!.socket().qr(QR);
    const { sessao } = await m!.ctx.nucleo();
    await m!.ctx.transporte!.esperar();
    assert.ok(sessao.temArquivos(), "credenciais provisórias gravadas");
    relogio.avancar(PRAZO_DO_PAREAMENTO_MS);
    await m!.ctx.transporte!.esperar();
    await sessao.esperar();
    assert.equal(sessao.temArquivos(), false);
    const fim = await estadoDoPareamento(c, previa);
    assert.equal(fim.structuredContent!.etapa, "expirado");
    assert.match(String(fim.structuredContent!.mensagem), /5 minutos/);
    const estado = await chamarCru(c, "wa_estado");
    assert.equal(estado.structuredContent!.situacao, "expirado");
    assert.match(String(estado.structuredContent!.para_o_claude), /wa_parear/);

    // De novo: transporte novo, credenciais novas.
    const outra = await chamarCru(c, "wa_parear");
    assert.equal((await clicar(c, outra)).isError, undefined);
    assert.equal(m!.fabrica.sockets.length, 2);
    m!.socket().qr(`${QR}-novo`);
    assert.equal((await estadoDoPareamento(c, outra)).structuredContent!.etapa, "qr");
    // O cartão velho, já confirmado, mostra o mesmo pareamento em andamento (há um só por Mac).
    assert.equal((await estadoDoPareamento(c, previa)).structuredContent!.etapa, "qr");
  });

  it("a ferramenta da tela só responde a pedido de pareamento", async () => {
    m = await montar();
    const s = await conectar(m);
    s.mensagens([msg({ jid: pn(ANA), texto: "oi" })]);
    await assentar(m);
    const { cliente: c, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const envio = await chamarCru(c, "wa_envio", { ligar: true });
    const r = await estadoDoPareamento(c, envio);
    assert.equal(r.structuredContent!.etapa, "inexistente");
    assert.equal(r._meta, undefined);
  });
});

describe("wa_desconectar e loggedOut apagam tudo (menos a contagem de envios do dia)", () => {
  async function comDados(): Promise<Cliente> {
    m = await montar();
    const s = await conectar(m);
    const { banco } = await m.ctx.nucleo();
    banco.permitirGrupo(GRUPO);
    s.mensagens([msg({ jid: pn(ANA), texto: "oi", nome: "Ana" }), msg({ jid: GRUPO, texto: "grupo", participante: pn(ANA) })]);
    await assentar(m);
    banco.bloquear("5531999990000@s.whatsapp.net");
    banco.guardarMarcaDoResumo(GRUPO, Date.now());
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    await ligarEnvio(cliente);
    await clicar(cliente, await chamarCru(cliente, "wa_responder", { conversa: ANA, texto: "resposta" }));
    return cliente;
  }

  async function conferirTudoApagado(): Promise<void> {
    const { banco, sessao } = await m!.ctx.nucleo();
    await sessao.esperar();
    assert.equal(sessao.temArquivos(), false, "sessão apagada");
    assert.equal(await sessao.pareada(), false);
    assert.deepEqual(banco.listarConversas(), [], "conversas apagadas");
    assert.deepEqual(banco.gruposPermitidos(), [], "lista de grupos apagada");
    assert.deepEqual(banco.bloqueados(), [], "lista \"nunca ler\" apagada");
    assert.equal(banco.envioLigado(), false, "envio volta a desligado");
    // Decisão da Fase 3: a contagem do dia sobrevive (só dia e número, sem dado de conversa).
    assert.equal(banco.enviosDoDia(Date.now()), 1, "a contagem do dia continua");
    assert.equal(banco.marcaDoResumo(GRUPO), undefined, "marcas apagadas");
    assert.equal(banco.cacheDeGrupos(), null);
    const dados = m!.config.dirDados;
    // O socket do canal do dono (0.6.0) fica enquanto o processo é dono: não guarda dado nenhum.
    const restantes = readdirSync(dados).filter((f) => !["conversas", "conexao.lock", "envios.enc"].includes(f) && !/^canal-[0-9a-f]{16}\.sock$/.test(f));
    assert.deepEqual(restantes, [], `sobrou ${restantes.join(", ")}`);
    assert.deepEqual(readdirSync(join(dados, "conversas")), []);
  }

  it("wa_desconectar: cartão sem volta; sem clique nada muda; com clique, logout de verdade e tudo apagado", async () => {
    const c = await comDados();
    const s = m!.socket();
    const previa = await chamarCru(c, "wa_desconectar");
    const p = previa._meta!.previa as { irreversivel: boolean; botao: string; detalhes: string[] };
    assert.equal(p.irreversivel, true);
    assert.match(p.detalhes.join(" "), /Ação sem volta/);
    assert.equal(s.chamadas.filter((x) => x.metodo === "logout").length, 0, "sem clique, sem logout");
    assert.equal((await m!.ctx.nucleo()).banco.listarConversas().length, 2);

    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal((r.structuredContent!.resultado as { logout_no_whatsapp: boolean }).logout_no_whatsapp, true);
    assert.equal(s.chamadas.filter((x) => x.metodo === "logout").length, 1);
    await m!.ctx.transporte!.esperar();
    await conferirTudoApagado();
    assert.equal(m!.ctx.transporte!.estado().situacao, "sessao_encerrada");
    const estado = await chamarCru(c, "wa_estado");
    assert.equal(estado.structuredContent!.situacao, "sessao_encerrada");
    assert.match(String(estado.structuredContent!.para_o_claude), /wa_parear/);
    const nada = await chamarCru(c, "wa_desconectar");
    assert.match(String(nada.structuredContent!.para_o_claude), /não há o que desconectar/);
    // Dá para parear de novo.
    const outra = await chamarCru(c, "wa_parear");
    assert.equal(outra.isError, undefined, textoDe(outra));
  });

  it("loggedOut (o celular tirou o aparelho) apaga a sessão, o banco e as listas, sem reconectar", async () => {
    await comDados();
    const s = m!.socket();
    s.fechar(DisconnectReason.loggedOut);
    await m!.ctx.transporte!.esperar();
    await conferirTudoApagado();
    assert.equal(m!.ctx.transporte!.estado().situacao, "sessao_encerrada");
    assert.equal(m!.fabrica.sockets.length, 1);
  });
});

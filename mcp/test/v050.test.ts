// 0.5.0: Windows e aba Code. Um teste por mudança de comportamento, escrito antes da mudança.
// - cofre automático do sistema (Keychain no Mac, DPAPI no Windows; os detalhes em cofre.test.ts), sem campo na
//   instalação: a "Senha do cofre" foi tentada e descartada pelo dono;
// - pastas, lock e gravação atômica que funcionam no Windows (plataforma injetada: não há Windows aqui);
// - parear pela aba Code (sem serverTools): wa_confirmar desenha o QR no cartão e wa_qr mostra um QR novo;
// - o QR desenhado no próprio cartão a partir da matriz (sem imagem em data URL).
// Socket falso, relógio falso, pastas temporárias e rede bloqueada: nada conecta ao WhatsApp, nenhum QR real.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import QRCode from "qrcode";
import { ARQUIVO_DPAPI, escolherCofre } from "../src/cofre.ts";
import { lerConfig, pastasPadrao } from "../src/config.ts";
import { matrizDoQr } from "../src/ferramentas/confirmacao.ts";
import { inicioPeloSistema } from "../src/lock.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { protegerPermissao, renomearComTentativas } from "../src/pasta.ts";
import { esquecerSegredos, limpar } from "../src/segredos.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import type { Executor } from "../src/sistema.ts";
import { PRAZO_DO_PAREAMENTO_MS } from "../src/transporte.ts";
import { URI_TELA } from "../src/escrita.ts";
import { caminhoDoQr, validarMatriz } from "../ui/qr.js";
import { lerEtapa, mensagemJaEscaneei, mensagemNovoQr } from "../ui/pareamento.js";
import { codigoDeConversa, confirmacaoPeloChat } from "../ui/edicao.js";
import { chamarCru, clicar, conectarCliente, montar, pedidoDa, pedidoPeloChat, RelogioFalso, textoDe, type Montagem, type Resultado } from "./ajuda.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
let restaurarLog: (() => void) | undefined;
const pastas: string[] = [];
afterEach(async () => {
  restaurarLog?.();
  restaurarLog = undefined;
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});
const pasta = () => {
  const p = mkdtempSync(join(tmpdir(), "wa-050-"));
  pastas.push(p);
  return p;
};

// ---------------------------------------------------------------------------------------------------------------
describe("cofre automático do sistema: sem campo na instalação, e o contexto sabe lidar com ele", () => {
  it("a senha do cofre saiu de tudo: manifest, código e instruções", () => {
    const manifesto = readFileSync(join(RAIZ, "mcpb", "manifest.json"), "utf8");
    assert.ok(!/WA_SENHA|\b[Ss]enha/.test(manifesto), "o manifest não fala em senha");
    const arquivos = ["src", "ui"].flatMap((d) =>
      readdirSync(join(RAIZ, d), { recursive: true })
        .map(String)
        .filter((f) => /\.(ts|js|html)$/.test(f) && !f.includes("ui-gerada"))
        .map((f) => join(RAIZ, d, f)),
    );
    for (const f of arquivos) {
      const fonte = readFileSync(f, "utf8");
      assert.ok(!/WA_SENHA|sem_senha|[Ss]enha do cofre|cofre-sal|scrypt/.test(fonte), `${f} ainda fala na senha do cofre`);
      assert.ok(!/(neste|deste|este) Mac\b/.test(fonte), `${f} ainda fala em "este Mac"`);
    }
    assert.ok(!/\b[Ss]enha/.test(INSTRUCOES));
  });

  it("Windows sem PowerShell (caso a): o servidor sobe, tenta de novo com espera crescente e a frase diz o motivo", async () => {
    const relogio = new RelogioFalso();
    restaurarLog = trocarSaidaDoLog(() => {});
    const dir = pasta();
    const cofre = escolherCofre(dir, {}, "win32", async () => Promise.reject(new Error("Não consegui rodar o comando powershell.exe (ENOENT).")));
    m = await montar({ pareada: false, cofre, temporizador: relogio });
    await m.ctx.partida();
    assert.deepEqual(relogio.pendentes, [1_000], "nova tentativa, como no M6");
    assert.throws(
      () => m!.ctx.exigirDono(),
      (e: Error) => /cofre deste computador/.test(e.message) && /proteção de dados do Windows/.test(e.message) && !/Outra sessão/.test(e.message),
    );
    assert.ok(!existsSync(join(dir, ARQUIVO_DPAPI)), "nada criado");
  });

  it("chave do cofre perdida depois de pareado: wa_desconectar mostra a prévia com frase que serve aos dois sistemas", async () => {
    const dir = pasta();
    const primeira = await montar({ dir });
    await primeira.ctx.partida();
    (await primeira.ctx.nucleo()).banco.definirEnvio(true);
    await primeira.ctx.encerrar();
    m = await montar({ dir, pareada: false, chaveHex: "e".repeat(64) });
    await m.ctx.partida();
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const previa = await chamarCru(cliente, "wa_desconectar");
    assert.equal(previa.isError, undefined, textoDe(previa));
    const detalhes = (previa._meta!.previa as { detalhes: string[] }).detalhes.join(" ");
    assert.match(detalhes, /a chave do cofre deste computador se perdeu \(ou um arquivo foi alterado\)/);
    assert.ok(!/Keychain|senha/i.test(detalhes));
    const listar = await chamarCru(cliente, "wa_estado");
    assert.match(textoDe(listar), /chave do cofre deste computador se perdeu/);
    assert.equal((await chamarCru(cliente, "wa_parear")).isError, undefined, "e o wa_parear segue");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Windows: pastas, lock e gravação atômica (plataforma injetada)", () => {
  it("pasta de dados e de logs por sistema", () => {
    assert.deepEqual(pastasPadrao("darwin", {}, "/Users/ana"), {
      dados: "/Users/ana/Library/Application Support/whatsapp-claude",
      logs: "/Users/ana/Library/Logs/whatsapp-claude",
    });
    assert.deepEqual(pastasPadrao("win32", { LOCALAPPDATA: "C:\\Users\\Ana\\AppData\\Local" }, "C:\\Users\\Ana"), {
      dados: "C:\\Users\\Ana\\AppData\\Local\\whatsapp-claude",
      logs: "C:\\Users\\Ana\\AppData\\Local\\whatsapp-claude\\logs",
    });
    assert.deepEqual(pastasPadrao("win32", {}, "C:\\Users\\Ana"), {
      dados: "C:\\Users\\Ana\\AppData\\Local\\whatsapp-claude",
      logs: "C:\\Users\\Ana\\AppData\\Local\\whatsapp-claude\\logs",
    });
    assert.deepEqual(pastasPadrao("win32", { LOCALAPPDATA: "${user_config.X}" }, "C:\\Users\\Ana").dados, "C:\\Users\\Ana\\AppData\\Local\\whatsapp-claude");
    assert.deepEqual(pastasPadrao("linux", {}, "/home/ana"), { dados: "/home/ana/.local/share/whatsapp-claude", logs: "/home/ana/.local/state/whatsapp-claude" });
    // A frase de erro não cita só a pasta do Mac.
    assert.throws(() => lerConfig({ WA_DADOS_DIR: "/x" }), (e: Error) => /LOCALAPPDATA/.test(e.message) && /Library/.test(e.message));
  });

  it("lock no Windows: a hora de início do outro processo vem do PowerShell, sem ps e sem shell", async () => {
    const chamadas: Array<{ comando: string; args: readonly string[] }> = [];
    const responder = (stdout: string, codigo = 0): Executor => async (comando, args) => {
      chamadas.push({ comando, args });
      return { codigo, stdout, stderr: "" };
    };
    const inicio = await inicioPeloSistema("win32", responder("1763040000123\r\n"))(4321);
    assert.equal(inicio, 1763040000123);
    const c = chamadas[0]!;
    assert.equal(c.comando, "powershell.exe");
    assert.deepEqual(c.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(c.args[3]!, /Get-Process -Id 4321\b/);
    assert.match(c.args[3]!, /ToUnixTimeMilliseconds/, "número puro: independe do idioma do Windows");
    assert.ok(!chamadas.some((x) => x.comando === "ps"));
    // Não deu para saber: undefined (o lock trata como dono vivo, na dúvida).
    assert.equal(await inicioPeloSistema("win32", responder("", 1))(1), undefined);
    assert.equal(await inicioPeloSistema("win32", responder("quarta-feira, 12 de novembro"))(1), undefined);
    assert.equal(await inicioPeloSistema("win32", async () => Promise.reject(new Error("não achei powershell.exe")))(1), undefined);
    // No Mac (e no Linux) continua o ps.
    chamadas.length = 0;
    await inicioPeloSistema("darwin", responder("01:00\n"))(7);
    assert.equal(chamadas[0]!.comando, "ps");
  });

  it("rename com poucas tentativas curtas no Windows (antivírus, outro leitor); no Mac, igual a antes", () => {
    const erro = (code: string) => Object.assign(new Error(code), { code });
    let vezes = 0;
    const falhaDuas = () => {
      if (++vezes <= 2) throw erro("EPERM");
    };
    renomearComTentativas("a", "b", { plataforma: "win32", renomear: falhaDuas, esperar: () => {} });
    assert.equal(vezes, 3);
    for (const code of ["EACCES", "EBUSY"]) {
      vezes = 0;
      renomearComTentativas("a", "b", { plataforma: "win32", renomear: () => { if (++vezes === 1) throw erro(code); }, esperar: () => {} });
      assert.equal(vezes, 2, code);
    }
    // No Mac: a primeira falha sobe (sem mudar o comportamento).
    vezes = 0;
    assert.throws(() => renomearComTentativas("a", "b", { plataforma: "darwin", renomear: falhaDuas, esperar: () => {} }), /EPERM/);
    assert.equal(vezes, 1);
    // Erro que não é passageiro sobe na hora; o passageiro que não passa sobe depois de poucas tentativas.
    vezes = 0;
    assert.throws(() => renomearComTentativas("a", "b", { plataforma: "win32", renomear: () => { vezes++; throw erro("ENOENT"); }, esperar: () => {} }), /ENOENT/);
    assert.equal(vezes, 1);
    vezes = 0;
    const esperas: number[] = [];
    assert.throws(() => renomearComTentativas("a", "b", { plataforma: "win32", renomear: () => { vezes++; throw erro("EBUSY"); }, esperar: (ms) => esperas.push(ms) }), /EBUSY/);
    assert.ok(vezes >= 3 && vezes <= 6, `${vezes} tentativas`);
    assert.ok(esperas.reduce((a, b) => a + b, 0) <= 500, "esperas curtas");
  });

  it("chmod no Windows não protege e não é chamado (nem pode quebrar)", () => {
    const chamados: string[] = [];
    const chmod = (c: string) => {
      chamados.push(c);
    };
    protegerPermissao("x", 0o600, "win32", chmod);
    assert.deepEqual(chamados, []);
    protegerPermissao("x", 0o600, "darwin", chmod);
    assert.deepEqual(chamados, ["x"]);
    protegerPermissao("y", 0o600, "win32", () => {
      throw new Error("não devia chamar");
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
const QR = "2@QR-DE-TESTE-NAO-REAL,chave-publica-falsa,identidade-falsa,segredo-falso";

async function semSessao(opcoes: { comTela?: boolean } = {}): Promise<{ c: Cliente; relogio: RelogioFalso; linhas: string[] }> {
  const relogio = new RelogioFalso();
  const linhas: string[] = [];
  restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
  m = await montar({ pareada: false, temporizador: relogio, agora: () => relogio.agora(), esperaDoQrMs: 1_500 });
  await m.ctx.partida();
  const { cliente, fechar } = await conectarCliente(m.ctx, { comTela: opcoes.comTela ?? true });
  fecharCliente = fechar;
  return { c: cliente, relogio, linhas };
}

async function esperarSocket(): Promise<void> {
  for (let i = 0; i < 200 && m!.fabrica.sockets.length === 0; i++) await new Promise((ok) => setTimeout(ok, 5));
}

/** O que o modelo pode ler de um resultado (structuredContent e texto; nunca o `_meta`). */
const doModelo = (r: Resultado): string => JSON.stringify(r.structuredContent ?? {}) + textoDe(r);

describe("parear pela aba Code (o cartão sem serverTools)", () => {
  it("o botão do aviso de risco manda no chat a confirmação com o código (só o _meta tem o código)", async () => {
    const { c } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    const { id, codigo } = pedidoDa(previa);
    assert.ok(!doModelo(previa).includes(codigo), "o modelo não vê o código");
    // 0.16.0: pelo chat vai o código DE CONVERSA, nunca o de tela (o do `_meta`).
    assert.equal(confirmacaoPeloChat(id, codigo, null), `Confirmo o pedido ${id}, código ${codigoDeConversa(codigo)}.`);
    assert.ok(!doModelo(previa).includes(codigoDeConversa(codigo)), "nem o de conversa");
    const fonte = readFileSync(join(RAIZ, "ui", "confirmar.js"), "utf8");
    assert.ok(!/tipo === "parear" && !temServerTools\(\)/.test(fonte), "o cartão não bloqueia mais o pareamento sem serverTools");
  });

  it("wa_confirmar inicia o pareamento, espera o QR e devolve o cartão com o QR só no _meta", async () => {
    const { c, linhas } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    const { id, codigo } = pedidoDa(previa);
    const f = (await c.listTools()).tools.find((t) => t.name === "wa_confirmar")!;
    assert.equal((f._meta as { ui?: { resourceUri?: string } }).ui?.resourceUri, URI_TELA, "o resultado do wa_confirmar desenha o cartão");

    const promessa = chamarCru(c, "wa_confirmar", { id, codigo: codigoDeConversa(codigo) });
    await esperarSocket();
    assert.equal(m!.fabrica.sockets.length, 1, "o clique (pelo código do cartão) abriu o socket");
    m!.socket().qr(QR);
    const r = await promessa;
    assert.equal(r.isError, undefined, textoDe(r));
    const sc = r.structuredContent!;
    assert.equal(sc.pedido, id);
    assert.equal(sc.etapa, "qr");
    assert.equal(sc.segundos_restantes, 60);
    assert.match(String(sc.para_o_claude), /wa_qr/);
    assert.match(String(sc.para_o_claude), /wa_estado/);
    assert.match(String(sc.se_o_cartao_nao_apareceu), /Claude Desktop/);
    const meta = r._meta as { pareamento?: { pedido?: string }; qr_matriz?: { tamanho: number; linhas: string[] } };
    assert.equal(meta.pareamento?.pedido, id);
    assert.ok(validarMatriz(meta.qr_matriz), "matriz válida no _meta");
    assert.deepEqual(meta.qr_matriz, matrizDoQr(QR));
    assert.ok(!doModelo(r).includes(QR) && !doModelo(r).includes("QR-DE-TESTE"), "o QR não vai ao modelo");
    assert.ok(!doModelo(r).includes("linhas") && !doModelo(r).includes(codigo));
    assert.ok(!linhas.join("\n").includes(QR), "nem ao log");

    // Uso único: o mesmo código de novo não abre outro socket.
    const deNovo = await chamarCru(c, "wa_confirmar", { id, codigo: codigoDeConversa(codigo) });
    assert.equal(deNovo.isError, true);
    assert.match(textoDe(deNovo), /já foi usado/);
    assert.equal(m!.fabrica.sockets.length, 1);
  });

  it("as garantias continuam: código errado (3 vezes cancela), pedido vencido e cancelado não pareiam", async () => {
    const { c, relogio } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    const { id, codigo } = pedidoDa(previa);
    for (let i = 1; i <= 3; i++) assert.equal((await chamarCru(c, "wa_confirmar", { id, codigo: "0".repeat(32) })).isError, true);
    assert.match(textoDe(await chamarCru(c, "wa_confirmar", { id, codigo })), /cancelado/);
    const vencido = await chamarCru(c, "wa_parear");
    relogio.avancar(11 * 60_000);
    assert.match(textoDe(await chamarCru(c, "wa_confirmar", pedidoDa(vencido))), /venceu/);
    const cancelado = await chamarCru(c, "wa_parear");
    await chamarCru(c, "wa_cancelar", { id: pedidoDa(cancelado).id });
    assert.match(textoDe(await chamarCru(c, "wa_confirmar", pedidoDa(cancelado))), /cancelado/);
    assert.equal(m!.fabrica.sockets.length, 0);
  });

  it("se o QR não chega no prazo curto, o cartão diz que está gerando e o modelo sabe o que fazer", async () => {
    const { c } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    const r = await chamarCru(c, "wa_confirmar", await pedidoPeloChat(previa));
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(r.structuredContent!.etapa, "gerando_qr");
    assert.equal((r._meta as { qr_matriz?: unknown }).qr_matriz, undefined);
    assert.match(String(r.structuredContent!.para_o_claude), /wa_qr/);
  });

  it("wa_qr: só com pareamento autorizado por clique; devolve o QR atual no _meta; nunca inicia pareamento", async () => {
    const { c, relogio } = await semSessao();
    const f = (await c.listTools()).tools.find((t) => t.name === "wa_qr");
    assert.ok(f, "wa_qr existe e o modelo vê");
    assert.equal((f!._meta as { ui?: { resourceUri?: string; visibility?: string[] } }).ui?.resourceUri, URI_TELA);
    assert.equal((f!._meta as { ui?: { visibility?: string[] } }).ui?.visibility, undefined);

    // Sem pareamento autorizado: recusa e não cria nada.
    const nada = await chamarCru(c, "wa_qr");
    assert.equal(nada.isError, true);
    assert.match(textoDe(nada), /Não há pareamento autorizado/);
    const previa = await chamarCru(c, "wa_parear");
    const pendente = await chamarCru(c, "wa_qr", { pedido: pedidoDa(previa).id });
    assert.equal(pendente.isError, true, "pedido ainda sem clique");
    assert.equal(m!.fabrica.sockets.length, 0, "wa_qr nunca inicia pareamento");

    const promessa = chamarCru(c, "wa_confirmar", await pedidoPeloChat(previa));
    await esperarSocket();
    m!.socket().qr(QR);
    await promessa;
    m!.socket().qr(`${QR}-2`);
    relogio.avancar(5_000);
    for (const args of [{}, { pedido: pedidoDa(previa).id }]) {
      const r = await chamarCru(c, "wa_qr", args);
      assert.equal(r.isError, undefined, textoDe(r));
      assert.equal(r.structuredContent!.etapa, "qr");
      assert.equal(r.structuredContent!.segundos_restantes, 55);
      assert.deepEqual((r._meta as { qr_matriz?: unknown }).qr_matriz, matrizDoQr(`${QR}-2`));
      assert.ok(!doModelo(r).includes("QR-DE-TESTE") && !doModelo(r).includes("linhas"));
      assert.match(String(r.structuredContent!.para_o_claude), /cartão/);
    }
    assert.equal(m!.fabrica.sockets.length, 1);

    // Outro pedido (de envio) não serve.
    const outro = await chamarCru(c, "wa_qr", { pedido: "ffffffff" });
    assert.equal(outro.isError, true);

    // Pareamento vencido: diz que venceu e NÃO começa outro.
    relogio.avancar(PRAZO_DO_PAREAMENTO_MS);
    await m!.ctx.transporte!.esperar();
    const fim = await chamarCru(c, "wa_qr");
    assert.equal(fim.structuredContent!.etapa, "expirado");
    assert.equal((fim._meta as { qr_matriz?: unknown } | undefined)?.qr_matriz, undefined);
    assert.equal(m!.fabrica.sockets.length, 1, "não começou outro pareamento");
  });

  it("as instruções dizem o que fazer com cada mensagem do cartão", () => {
    assert.match(INSTRUCOES, /wa_qr/);
    assert.match(INSTRUCOES, /Mostre um novo QR/);
    assert.match(INSTRUCOES, /Já escaneei/);
    assert.ok(!/wa_confirmar recusa o pedido de pareamento|só se confirma pelo botão/.test(INSTRUCOES));
    assert.match(mensagemNovoQr("ab12cd34"), /^Mostre um novo QR do pareamento \(pedido ab12cd34\)\.$/);
    assert.match(mensagemJaEscaneei("ab12cd34"), /^Já escaneei o QR do pareamento \(pedido ab12cd34\)/);
  });

  it("com serverTools o caminho de antes continua: clique, wa_estado_pareamento_tela com a matriz", async () => {
    const { c } = await semSessao();
    const previa = await chamarCru(c, "wa_parear");
    assert.equal((await clicar(c, previa)).isError, undefined);
    m!.socket().qr(QR);
    const e = await chamarCru(c, "wa_estado_pareamento_tela", { id: pedidoDa(previa).id });
    assert.equal(e.structuredContent!.etapa, "qr");
    assert.deepEqual((e._meta as { qr_matriz?: unknown }).qr_matriz, matrizDoQr(QR));
    assert.equal((e._meta as { qr_imagem?: unknown }).qr_imagem, undefined, "sem imagem em data URL");
    const lida = lerEtapa(e);
    assert.equal(lida?.etapa, "qr");
    assert.deepEqual(lida?.matriz, matrizDoQr(QR));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("QR desenhado no próprio cartão (matriz -> <path>)", () => {
  /** Refaz a grade a partir do `d` do path (cada trecho: M x y h n v1 h-n z). */
  function rasterizar(d: string, lado: number): string[] {
    const grade = Array.from({ length: lado }, () => Array<string>(lado).fill("0"));
    for (const t of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
      const [x, y, n] = [Number(t[1]), Number(t[2]), Number(t[3])];
      for (let i = 0; i < n; i++) grade[y]![x + i] = "1";
    }
    return grade.map((l) => l.join(""));
  }

  it("a matriz do servidor tem tamanho e módulos do QR, e o path desenha exatamente os módulos escuros, com margem", () => {
    const mat = matrizDoQr("texto qualquer de teste");
    const qr = QRCode.create("texto qualquer de teste", { errorCorrectionLevel: "L" });
    assert.equal(mat.tamanho, qr.modules.size);
    assert.equal(mat.linhas.length, mat.tamanho);
    assert.equal(mat.linhas[0]![0], "1", "canto do padrão de posição é escuro");
    const { lado, d } = caminhoDoQr(mat, 4);
    assert.equal(lado, mat.tamanho + 8);
    const grade = rasterizar(d, lado);
    for (let y = 0; y < lado; y++) {
      for (let x = 0; x < lado; x++) {
        const dentro = x >= 4 && y >= 4 && x < 4 + mat.tamanho && y < 4 + mat.tamanho;
        const esperado = dentro ? mat.linhas[y - 4]![x - 4] : "0";
        assert.equal(grade[y]![x], esperado, `módulo ${x},${y}`);
      }
    }
  });

  it("o cartão valida a matriz: tamanho plausível e só 0/1", () => {
    const boa = matrizDoQr("abc");
    assert.ok(validarMatriz(boa));
    const ruins: unknown[] = [
      null,
      "texto",
      { tamanho: 20, linhas: Array(20).fill("0".repeat(20)) },
      { tamanho: 181, linhas: Array(181).fill("0".repeat(181)) },
      { tamanho: 22, linhas: Array(22).fill("0".repeat(22)) },
      { tamanho: boa.tamanho, linhas: boa.linhas.slice(1) },
      { tamanho: boa.tamanho, linhas: [...boa.linhas.slice(1), "2".repeat(boa.tamanho)] },
      { tamanho: boa.tamanho, linhas: [...boa.linhas.slice(1), "0".repeat(boa.tamanho - 1)] },
      { tamanho: boa.tamanho, linhas: [...boa.linhas.slice(1), `<script>${"0".repeat(boa.tamanho - 8)}`] },
    ];
    for (const r of ruins) assert.equal(validarMatriz(r), null, JSON.stringify(r)?.slice(0, 60));
  });

  it("o cartão monta o <svg> no DOM (createElementNS), com fundo branco fixo; nada de <img> com data URL", () => {
    const fonte = readFileSync(join(RAIZ, "ui", "confirmar.js"), "utf8");
    assert.match(fonte, /createElementNS\("http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(fonte, /caminhoDoQr\(/);
    assert.ok(!/img\.src|data:image/.test(fonte), "sem imagem em data URL");
    assert.match(fonte, /#ffffff/i);
    assert.match(fonte, /Mostrar novo QR/);
    assert.match(fonte, /Já escaneei/);
    const modelo = readFileSync(join(RAIZ, "ui", "confirmar.template.html"), "utf8");
    assert.match(modelo, /\.qr svg \{[^}]*background: #ffffff/);
    const servidor = readFileSync(join(RAIZ, "src", "ferramentas", "confirmacao.ts"), "utf8");
    assert.ok(!/toString\(qr, \{ type: "svg"|data:image/.test(servidor), "o servidor não gera mais a imagem");
  });
});

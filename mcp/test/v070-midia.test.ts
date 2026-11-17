// 0.7.0, parte 2: abrir a mídia recebida (wa_abrir_midia) e enviar arquivos (wa_enviar_arquivo).
// Nada de rede: o download da mídia passa por um `fetch` falso injetado (o test/setup.ts bloqueia o de verdade), a
// pasta "Downloads/WhatsApp Claude" é uma pasta temporária e o socket é o falso. A mídia falsa é cifrada aqui do mesmo
// jeito que o WhatsApp cifra (HKDF da chave da mídia, AES-256-CBC e HMAC-SHA256 de 10 bytes no fim).

import assert from "node:assert/strict";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getMediaKeys, type WAMessage } from "@whiskeysockets/baileys";
import { LIMITES_DO_CANAL } from "../src/canal.ts";
import { audioDecifrado } from "../src/ferramentas/midia.ts";
import {
  ABERTURAS_POR_DIA,
  caminhoProibido,
  IMAGEM_EM_LINHA_MAXIMA_BYTES,
  nomeSeguro,
  pastaDeDownloadsPadrao,
  tipoParaEnviar,
} from "../src/midia.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import { arquivoParaMostrar, podeEnviar, rotuloDoTextoEditavel } from "../ui/edicao.js";
import { codigoDeConversa, codigoEditado } from "../ui/edicao.js";
import {
  ANA,
  assentar,
  BETO,
  chamarCru,
  clicar,
  conectar,
  conectarCliente,
  GRUPO,
  ligarEnvio,
  montar,
  OUTRO_GRUPO,
  pedidoDa,
  pn,
  textoDe,
  type Montagem,
  type OpcoesMontagem,
  type Resultado,
} from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
const montagens: Montagem[] = [];
const fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.splice(0).reverse()) await f();
  for (const mm of montagens.splice(0).reverse()) await mm.fechar();
});

const erroDe = (r: Resultado) => String(r.structuredContent?.erro ?? textoDe(r));
const envios = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendMessage");
const registro = (mm: Montagem): Array<Record<string, unknown>> =>
  readFileSync(mm.caminhoRegistro, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);

// ---- mídia falsa, cifrada como o WhatsApp cifra ----
type TipoBaileys = "image" | "video" | "audio" | "document" | "sticker";
async function cifrar(plano: Buffer, tipo: TipoBaileys) {
  const mediaKey = randomBytes(32);
  const k = await getMediaKeys(mediaKey, tipo);
  const [iv, cipherKey, macKey] = [k.iv!, k.cipherKey!, k.macKey!];
  const c = createCipheriv("aes-256-cbc", cipherKey, iv);
  const enc = Buffer.concat([c.update(plano), c.final()]);
  const mac = createHmac("sha256", macKey).update(iv).update(enc).digest().subarray(0, 10);
  const arquivo = Buffer.concat([enc, mac]);
  return {
    mediaKey,
    arquivo,
    fileSha256: createHash("sha256").update(plano).digest(),
    fileEncSha256: createHash("sha256").update(arquivo).digest(),
  };
}

/** Servidor de mídia falso: caminho -> resposta. Guarda os pedidos. */
class CdnFalsa {
  readonly arquivos = new Map<string, { status: number; corpo?: Buffer; tamanhoDeclarado?: number }>();
  readonly pedidos: Array<{ url: string; redirect?: string }> = [];
  buscar = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(entrada);
    this.pedidos.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}) });
    const a = this.arquivos.get(new URL(url).pathname);
    if (!a || a.status !== 200) return new Response("nao", { status: a?.status ?? 404 });
    const headers = a.tamanhoDeclarado !== undefined ? { "content-length": String(a.tamanhoDeclarado) } : undefined;
    return new Response(new Uint8Array(a.corpo!), { status: 200, ...(headers ? { headers } : {}) });
  };
}

const PNG_1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface MidiaDeTeste {
  id: string;
  tipo: TipoBaileys;
  plano: Buffer;
  mimetype: string;
  nome?: string;
  segundos?: number;
  jid?: string;
  participante?: string;
  /** Mensagem de antes da 0.7.0: só chave e caminho (sem url nem hashes). */
  antiga?: boolean;
  unica?: boolean;
  tamanhoDeclarado?: number;
}

async function mensagemDeMidia(cdn: CdnFalsa, d: MidiaDeTeste): Promise<WAMessage> {
  const c = await cifrar(d.plano, d.tipo);
  const caminho = `/v/t62.7118-24/${d.id}.enc?ccb=11-4`;
  cdn.arquivos.set(new URL(`https://mmg.whatsapp.net${caminho}`).pathname, { status: 200, corpo: c.arquivo });
  const midia: Record<string, unknown> = {
    mimetype: d.mimetype,
    mediaKey: c.mediaKey,
    directPath: caminho,
    fileLength: d.tamanhoDeclarado ?? d.plano.length,
    ...(d.antiga ? {} : { url: `https://mmg.whatsapp.net${caminho}&mms3=true`, fileSha256: c.fileSha256, fileEncSha256: c.fileEncSha256 }),
    ...(d.nome ? { fileName: d.nome } : {}),
    ...(d.segundos ? { seconds: d.segundos } : {}),
    ...(d.unica ? { viewOnce: true } : {}),
  };
  const chave = { image: "imageMessage", video: "videoMessage", audio: "audioMessage", document: "documentMessage", sticker: "stickerMessage" }[d.tipo];
  return msg({ jid: d.jid ?? pn(ANA), id: d.id, nome: "Ana", ...(d.participante ? { participante: d.participante } : {}), message: { [chave]: midia } });
}

async function cenario(opcoes: OpcoesMontagem & { midias?: MidiaDeTeste[]; ligar?: boolean } = {}) {
  const cdn = new CdnFalsa();
  const m = await montar({ ...opcoes, buscarMidia: cdn.buscar });
  montagens.push(m);
  const s = await conectar(m, {
    grupos: {
      [GRUPO]: { id: GRUPO, subject: "Família", size: 12, participants: [] },
      [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Trabalho", size: 40, participants: [] },
    },
  });
  await assentar(m);
  (await m.ctx.nucleo()).banco.permitirGrupo(GRUPO);
  s.mensagens([msg({ jid: pn(ANA), id: "T1", texto: "oi", nome: "Ana" }), msg({ jid: pn(BETO), id: "B1", texto: "oi", nome: "Beto" }), msg({ jid: GRUPO, id: "G1", texto: "oi", participante: pn(BETO), nome: "Beto" })]);
  const lista: WAMessage[] = [];
  for (const d of opcoes.midias ?? []) lista.push(await mensagemDeMidia(cdn, d));
  if (lista.length) s.mensagens(lista);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fechamentos.push(fechar);
  if (opcoes.ligar) await ligarEnvio(cliente);
  return { m, s, c: cliente, cdn, pasta: m.ctx.pastaDeDownloads };
}

describe("onde os arquivos abertos ficam (pastaDeDownloadsPadrao)", () => {
  it("Downloads/WhatsApp Claude dentro da casa, no Mac e no Windows", () => {
    assert.equal(pastaDeDownloadsPadrao("darwin", "/Users/fulano"), "/Users/fulano/Downloads/WhatsApp Claude");
    assert.equal(pastaDeDownloadsPadrao("win32", "C:\\Users\\Fulano"), "C:\\Users\\Fulano\\Downloads\\WhatsApp Claude");
    assert.equal(pastaDeDownloadsPadrao("linux", "/home/fulano"), "/home/fulano/Downloads/WhatsApp Claude");
  });
});

describe("nome de arquivo vindo de terceiros (nomeSeguro)", () => {
  it("sem separador, sem .., sem caractere de controle, tamanho limitado e extensão coerente com o tipo", () => {
    assert.equal(nomeSeguro("../../.ssh/authorized_keys", "text/plain", "x"), "authorized_keys.txt");
    assert.equal(nomeSeguro("..\\..\\Windows\\win.ini", "text/plain", "x"), "win.ini.txt");
    assert.equal(nomeSeguro("relat\u0000ório\u202Efdp.pdf", "application/pdf", "x"), "relatóriofdp.pdf");
    assert.equal(nomeSeguro("foto.jpg.exe", "image/jpeg", "x"), "foto.jpg.exe.jpg");
    assert.equal(nomeSeguro("contrato.PDF", "application/pdf", "x"), "contrato.PDF");
    assert.equal(nomeSeguro("..", "application/pdf", "padrao"), "padrao.pdf");
    assert.equal(nomeSeguro(undefined, "audio/ogg; codecs=opus", "audio-1"), "audio-1.ogg");
    assert.equal(nomeSeguro("CON.txt", "text/plain", "x"), "_CON.txt");
    assert.equal(nomeSeguro("setup.exe", "application/octet-stream", "x"), "setup.exe.bin");
    const longo = nomeSeguro("a".repeat(500) + ".pdf", "application/pdf", "x");
    assert.ok([...longo].length <= 104 && longo.endsWith(".pdf"), longo);
    for (const n of [nomeSeguro("a/b\\c:d*e?f\"g<h>i|j.txt", "text/plain", "x")]) assert.ok(!/[/\\:*?"<>|]/.test(n), n);
  });
});

describe("abrir mídia recebida (wa_abrir_midia)", () => {
  it("imagem pequena: volta como bloco de imagem do MCP (o modelo vê), baixada sem seguir redirecionamento, e também fica em arquivo", async () => {
    const { m, c, cdn, pasta } = await cenario({ midias: [{ id: "IMG1", tipo: "image", plano: PNG_1x1, mimetype: "image/png" }] });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "IMG1" });
    assert.equal(r.isError, undefined, textoDe(r));
    const bloco = (r.content as Array<Record<string, unknown>>).find((b) => b.type === "image");
    assert.ok(bloco, "sem bloco de imagem");
    assert.equal(bloco.mimeType, "image/png");
    assert.deepEqual(Buffer.from(String(bloco.data), "base64"), PNG_1x1);
    assert.equal(cdn.pedidos.length, 1);
    assert.equal(cdn.pedidos[0]!.redirect, "error");
    assert.equal(new URL(cdn.pedidos[0]!.url).hostname, "mmg.whatsapp.net");
    const sc = r.structuredContent!;
    assert.equal(sc.em_linha, true);
    assert.ok(String(sc.arquivo).startsWith(pasta), "arquivo fora da pasta");
    assert.deepEqual(readFileSync(String(sc.arquivo)), PNG_1x1);
    assert.match(String(sc.para_o_claude), /sem cifra/);
    assert.ok(registro(m).some((l) => l.evento === "midia_aberta" && l.ferramenta === "wa_abrir_midia" && l.mensagem === "IMG1"));
  });

  it("imagem acima do limite em linha: só o arquivo, sem bloco de imagem", async () => {
    const grande = Buffer.concat([PNG_1x1, randomBytes(IMAGEM_EM_LINHA_MAXIMA_BYTES + 10)]);
    const { c } = await cenario({ midias: [{ id: "IMG2", tipo: "image", plano: grande, mimetype: "image/png" }] });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "IMG2" });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.ok(!(r.content as Array<{ type: string }>).some((b) => b.type === "image"));
    assert.equal(r.structuredContent!.em_linha, false);
    assert.equal(statSync(String(r.structuredContent!.arquivo)).size, grande.length);
  });

  it("documento: salvo com nome neutro (0.16.0), sem sobrescrever; texto pequeno volta em conteudo_de_terceiros", async () => {
    const texto = Buffer.from("nome;valor\nAna;10\n");
    const { c, pasta } = await cenario({
      midias: [
        { id: "DOC1", tipo: "document", plano: texto, mimetype: "text/csv", nome: "../planilha.csv" },
        { id: "DOC2", tipo: "document", plano: texto, mimetype: "text/csv", nome: "planilha.csv" },
      ],
    });
    const a = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "DOC1" });
    const b = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "DOC2" });
    assert.equal(a.isError, undefined, textoDe(a));
    // 0.16.0: nome neutro (whatsapp-documento-<data>-<8 hex>.csv); o nome original só em conteudo_de_terceiros.
    assert.match(String(a.structuredContent!.arquivo), /whatsapp-documento-\d{8}-\d{6}-[0-9a-f]{8}\.csv$/);
    assert.notEqual(b.structuredContent!.arquivo, a.structuredContent!.arquivo, "não sobrescreve");
    assert.equal(readdirSync(pasta).length, 2);
    assert.equal((a.structuredContent!.conteudo_de_terceiros as Record<string, unknown>).nome_do_arquivo, "../planilha.csv");
    const terceiros = a.structuredContent!.conteudo_de_terceiros as Record<string, unknown>;
    assert.equal(terceiros.texto, texto.toString());
    assert.equal(a.structuredContent!.tamanho_bytes, texto.length);
  });

  it("áudio: salvo com a duração; aponta o wa_transcrever; o gancho da parte 3 entrega o áudio decifrado sem baixar de novo", async () => {
    const audio = Buffer.concat([Buffer.from("OggS"), randomBytes(300)]);
    const { m, c, cdn } = await cenario({ midias: [{ id: "AUD1", tipo: "audio", plano: audio, mimetype: "audio/ogg; codecs=opus", segundos: 7 }] });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "AUD1" });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(r.structuredContent!.duracao_s, 7);
    assert.match(String(r.structuredContent!.transcricao), /wa_transcrever/);
    assert.ok(String(r.structuredContent!.arquivo).endsWith(".ogg"));
    const pedidos = cdn.pedidos.length;
    assert.deepEqual(await audioDecifrado(m.ctx, pn(ANA), "AUD1"), audio);
    assert.equal(cdn.pedidos.length, pedidos, "o gancho reaproveitou o arquivo já aberto");
  });

  it("mensagem de antes da 0.7.0 (só chave e caminho) também abre: o endereço sai do caminho", async () => {
    const { c } = await cenario({ midias: [{ id: "OLD1", tipo: "document", plano: Buffer.from("%PDF-1.4 x"), mimetype: "application/pdf", nome: "a.pdf", antiga: true }] });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "OLD1" });
    assert.equal(r.isError, undefined, textoDe(r));
  });

  it("mídia vencida no servidor (404/410): pede UMA vez ao celular para reenviar; se não der, diz que não está mais disponível", async () => {
    const { s, c, cdn } = await cenario({
      midias: [
        { id: "VEL1", tipo: "image", plano: PNG_1x1, mimetype: "image/png" },
        { id: "VEL2", tipo: "image", plano: PNG_1x1, mimetype: "image/png" },
      ],
    });
    // VEL1: 410, o celular reenvia para um caminho novo, que existe.
    const antigo = [...cdn.arquivos.keys()].find((k) => k.includes("VEL1"))!;
    const corpo = cdn.arquivos.get(antigo)!.corpo!;
    cdn.arquivos.set(antigo, { status: 410 });
    cdn.arquivos.set("/v/novo/VEL1.enc", { status: 200, corpo });
    s.aoPedirReenvio = (w) => {
      const conteudo = w.message!.imageMessage!;
      conteudo.directPath = "/v/novo/VEL1.enc";
      return w;
    };
    const ok = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "VEL1" });
    assert.equal(ok.isError, undefined, textoDe(ok));
    assert.equal(s.chamadas.filter((x) => x.metodo === "updateMediaMessage").length, 1);
    // VEL2: 404 e o celular não reenvia.
    cdn.arquivos.set([...cdn.arquivos.keys()].find((k) => k.includes("VEL2"))!, { status: 404 });
    s.aoPedirReenvio = () => new Error("Media re-upload failed by device (NOT_FOUND)");
    const nao = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "VEL2" });
    assert.equal(nao.isError, true);
    assert.match(erroDe(nao), /não está mais disponível/);
    assert.equal(s.chamadas.filter((x) => x.metodo === "updateMediaMessage").length, 2, "uma tentativa só por abertura");
  });

  it("arquivo adulterado (hash ou HMAC errado) é recusado e nada é gravado", async () => {
    const { c, cdn, pasta } = await cenario({ midias: [{ id: "MAL1", tipo: "document", plano: Buffer.from("conteudo"), mimetype: "text/plain", nome: "a.txt" }] });
    const k = [...cdn.arquivos.keys()][0]!;
    const corpo = Buffer.from(cdn.arquivos.get(k)!.corpo!);
    corpo[0] = corpo[0]! ^ 0xff;
    cdn.arquivos.set(k, { status: 200, corpo });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "MAL1" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /não confere|corromp/);
    assert.ok(!existsSync(pasta) || readdirSync(pasta).length === 0);
  });

  it("recusa visualização única, mensagem sem mídia, conversa \"nunca ler\", grupo não escolhido e tamanho acima do teto, sem baixar", async () => {
    const { m, c, cdn } = await cenario({
      midias: [
        { id: "ONCE", tipo: "image", plano: PNG_1x1, mimetype: "image/png", unica: true },
        { id: "BIG", tipo: "video", plano: Buffer.from("x"), mimetype: "video/mp4", tamanhoDeclarado: 200 * 1024 * 1024 },
        { id: "BETOIMG", tipo: "image", plano: PNG_1x1, mimetype: "image/png", jid: pn(BETO) },
      ],
    });
    const casos: Array<[Record<string, unknown>, RegExp]> = [
      [{ conversa: ANA, mensagem: "ONCE" }, /visualização única|não pode ser aberta/],
      [{ conversa: ANA, mensagem: "T1" }, /não é mídia|não tem mídia/],
      [{ conversa: ANA, mensagem: "BIG" }, /não pode ser aberta|passa de/],
      [{ conversa: OUTRO_GRUPO, mensagem: "X" }, /wa_escolher_grupos/],
    ];
    for (const [args, erro] of casos) {
      const r = await chamarCru(c, "wa_abrir_midia", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(erroDe(r), erro, JSON.stringify(args));
    }
    (await m.ctx.nucleo()).banco.bloquear(pn(BETO));
    const bloqueada = await chamarCru(c, "wa_abrir_midia", { conversa: pn(BETO), mensagem: "BETOIMG" });
    assert.equal(bloqueada.isError, true);
    assert.equal(cdn.pedidos.length, 0, "nada foi baixado");
  });

  it("o tamanho é conferido de novo durante o download: passou do teto, para e não grava", async () => {
    const { c, cdn, pasta } = await cenario({ midias: [{ id: "MENTE", tipo: "document", plano: Buffer.alloc(64), mimetype: "application/pdf", nome: "a.pdf", tamanhoDeclarado: 10 }] });
    const k = [...cdn.arquivos.keys()][0]!;
    cdn.arquivos.set(k, { status: 200, corpo: randomBytes(51 * 1024 * 1024) });
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "MENTE" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /passa d|teto|grande/);
    assert.ok(!existsSync(pasta) || readdirSync(pasta).length === 0);
  });

  it(`no máximo ${ABERTURAS_POR_DIA} aberturas por dia (contador cifrado, como os outros)`, async () => {
    const { m, c } = await cenario({ midias: [{ id: "IMG1", tipo: "image", plano: PNG_1x1, mimetype: "image/png" }] });
    const { banco } = await m.ctx.nucleo();
    for (let i = 0; i < ABERTURAS_POR_DIA - 1; i++) banco.reservarContagens(Date.now(), [{ tipo: "aberturas", limite: ABERTURAS_POR_DIA, frase: "x" }]);
    assert.equal((await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "IMG1" })).isError, undefined);
    const r = await chamarCru(c, "wa_abrir_midia", { conversa: ANA, mensagem: "IMG1" });
    assert.equal(r.isError, true);
    assert.match(erroDe(r), new RegExp(`${ABERTURAS_POR_DIA} aberturas`));
  });

  it("pela leitora (outra sessão do Claude): a imagem em linha vem do dono pelo canal e cabe no limite dele", async () => {
    const quase = Buffer.concat([PNG_1x1, randomBytes(IMAGEM_EM_LINHA_MAXIMA_BYTES - PNG_1x1.length)]);
    assert.ok(Math.ceil(quase.length / 3) * 4 + 64 * 1024 < LIMITES_DO_CANAL.mensagemBytes, "a imagem em linha (base64) cabe no canal com folga");
    const { m } = await cenario({ midias: [{ id: "IMGL", tipo: "image", plano: quase, mimetype: "image/png" }] });
    const leitor = await montar({ dir: m.dir, pareada: false });
    montagens.push(leitor);
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    const { cliente, fechar } = await conectarCliente(leitor.ctx);
    fechamentos.push(fechar);
    const r = await chamarCru(cliente, "wa_abrir_midia", { conversa: ANA, mensagem: "IMGL" });
    assert.equal(r.isError, undefined, textoDe(r));
    const bloco = (r.content as Array<Record<string, unknown>>).find((b) => b.type === "image");
    assert.equal(Buffer.from(String(bloco!.data), "base64").length, quase.length);
  });
});

describe("tipo do arquivo a enviar (tipoParaEnviar) e caminhos proibidos", () => {
  const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);
  const MP4 = Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "latin1");
  const OPUS = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead")]);
  it("imagem, vídeo, áudio, voz e documento pelo conteúdo e pela extensão", () => {
    assert.deepEqual(tipoParaEnviar("/a/foto.jpg", JPG, {}), { tipo: "imagem", mimetype: "image/jpeg" });
    assert.deepEqual(tipoParaEnviar("/a/foto.jpg", JPG, { como_documento: true }), { tipo: "documento", mimetype: "image/jpeg" });
    assert.deepEqual(tipoParaEnviar("/a/v.mp4", MP4, {}), { tipo: "video", mimetype: "video/mp4" });
    assert.deepEqual(tipoParaEnviar("/a/nota.ogg", OPUS, { voz: true }), { tipo: "nota_de_voz", mimetype: "audio/ogg; codecs=opus" });
    assert.deepEqual(tipoParaEnviar("/a/nota.ogg", OPUS, {}), { tipo: "audio", mimetype: "audio/ogg" });
    assert.deepEqual(tipoParaEnviar("/a/falsa.jpg", Buffer.from("MZ\x90\x00"), {}), { tipo: "documento", mimetype: "image/jpeg" }, "extensão de imagem sem conteúdo de imagem vai como documento");
    assert.deepEqual(tipoParaEnviar("/a/rel.pdf", Buffer.from("%PDF"), {}), { tipo: "documento", mimetype: "application/pdf" });
    assert.throws(() => tipoParaEnviar("/a/m.mp3", Buffer.from("ID3"), { voz: true }), /OGG\/Opus/);
  });
  it("recusa a pasta de dados, pastas de segredo conhecidas, .env e chaves privadas", () => {
    const o = { casa: "/Users/f", plataforma: "darwin" as const, protegidas: ["/Users/f/Library/Application Support/whatsapp-claude"] };
    for (const p of [
      "/Users/f/Library/Application Support/whatsapp-claude/indice.enc",
      "/Users/f/.ssh/id_ed25519.pub",
      "/Users/f/.gnupg/pubring.kbx",
      "/Users/f/.aws/credentials",
      "/Users/f/Library/Keychains/login.keychain-db",
      "/Users/f/Library/Application Support/Claude/config.json",
      "/Users/f/projeto/.env",
      "/Users/f/projeto/.env.local",
      "/Users/f/Downloads/id_rsa",
      "/Users/f/certs/servidor.pem",
    ]) {
      assert.ok(caminhoProibido(p, o), p);
    }
    assert.equal(caminhoProibido("/Users/f/Documents/contrato.pdf", o), undefined);
    assert.ok(caminhoProibido("C:\\Users\\F\\AppData\\Roaming\\Claude\\x.json", { casa: "C:\\Users\\F", plataforma: "win32", protegidas: [] }));
  });
});

describe("enviar arquivo (wa_enviar_arquivo)", () => {
  function arquivoTemp(m: Montagem, nome: string, conteudo: Buffer): string {
    // 0.16.0: só sai arquivo das pastas permitidas (a casa dos testes é a pasta temporária).
    const dir = join(m.dir, "Documents", "meus");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, nome);
    writeFileSync(p, conteudo);
    return p;
  }

  it("cartão com para quem, nome, tipo, tamanho e o CAMINHO REAL (link resolvido); legenda editável presa ao código; envia o mesmo conteúdo", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    const real = arquivoTemp(m, "relatorio.pdf", Buffer.from("%PDF-1.4 conteudo"));
    const atalho = join(m.dir, "atalho.pdf");
    symlinkSync(real, atalho);
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: atalho, legenda: "segue" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Record<string, unknown>;
    assert.equal(p.tipo, "arquivo");
    const arq = arquivoParaMostrar(p)!;
    assert.equal(arq.nome, "relatorio.pdf");
    assert.match(arq.tipo, /documento/);
    assert.match(arq.tamanho, /bytes|KB/);
    assert.equal(arq.caminho, (await import("node:fs")).realpathSync(real), "o caminho real, não o do atalho");
    assert.equal(p.texto, "segue");
    assert.equal(envios(s).length, 0, "nada sem o clique");
    const r = await clicar(c, previa, "segue o relatório");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(envios(s).length, 1);
    const conteudo = envios(s)[0]!.args[1] as Record<string, unknown>;
    assert.deepEqual(conteudo.document, Buffer.from("%PDF-1.4 conteudo"));
    assert.equal(conteudo.fileName, "relatorio.pdf");
    assert.equal(conteudo.mimetype, "application/pdf");
    assert.equal(conteudo.caption, "segue o relatório");
    assert.equal((await m.ctx.nucleo()).banco.enviosDoDia(Date.now()), 1, "conta no limite diário");
  });

  it("legenda vazia vale (o cartão deixa enviar sem legenda) e imagem vai como imagem", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    const p = arquivoTemp(m, "foto.png", PNG_1x1);
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.equal((previa._meta!.previa as Record<string, unknown>).texto, "");
    const { id, codigo } = pedidoDa(previa);
    // Pelo chat (0.16.0): o código de conversa preso ao texto (vazio).
    const r = await chamarCru(c, "wa_confirmar", { id, codigo: codigoEditado(codigoDeConversa(codigo), ""), texto: "" });
    assert.equal(r.isError, undefined, textoDe(r));
    const conteudo = envios(s)[0]!.args[1] as Record<string, unknown>;
    assert.deepEqual(conteudo.image, PNG_1x1);
    assert.equal(conteudo.caption, undefined);
  });

  it("foto sai com miniatura gerada depois do clique (JPEG em base64, com largura e altura); o cartão mostra a própria foto", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    const p = arquivoTemp(m, "foto.png", PNG_1x1);
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
    const arq = arquivoParaMostrar(previa._meta!.previa)!;
    assert.equal(arq.imagem, `data:image/png;base64,${PNG_1x1.toString("base64")}`, "a foto no cartão (o navegador do cartão desenha; nada é decodificado aqui antes do clique)");
    const r = await clicar(c, previa, "");
    assert.equal(r.isError, undefined, textoDe(r));
    const conteudo = envios(s)[0]!.args[1] as Record<string, unknown>;
    const mini = Buffer.from(String(conteudo.jpegThumbnail), "base64");
    assert.ok(mini.length > 100 && mini[0] === 0xff && mini[1] === 0xd8, "miniatura JPEG");
    assert.equal(conteudo.width, 1);
    assert.equal(conteudo.height, 1);
    const resultado = r.structuredContent!.resultado as Record<string, unknown>;
    assert.deepEqual(resultado.miniatura, { largura: 1, altura: 1 });
  });

  it("miniatura que falha não derruba o envio: sai sem miniatura e o resultado diz isso", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    // Cabeçalho de PNG válido (passa no tipo), corpo estragado (a decodificação falha).
    const estragado = Buffer.concat([PNG_1x1.subarray(0, 33), randomBytes(64)]);
    const p = arquivoTemp(m, "quebrada.png", estragado);
    const r = await clicar(c, await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p }), "");
    assert.equal(r.isError, undefined, textoDe(r));
    const conteudo = envios(s)[0]!.args[1] as Record<string, unknown>;
    assert.equal(conteudo.jpegThumbnail, "", "vazia: a Baileys não tenta de novo");
    const resultado = r.structuredContent!.resultado as Record<string, unknown>;
    assert.equal(resultado.miniatura, false);
    assert.match(String(resultado.frase), /sem miniatura/);
  });

  it("o gerador de miniatura só é usado no envio do dono, depois do clique (nunca com mídia recebida)", () => {
    const fontes = readdirSync(new URL("../src", import.meta.url), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const usam = fontes.filter((f) => /miniatura\.ts["']/.test(readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")));
    assert.deepEqual(usam, ["ferramentas/midia.ts"]);
    const midia = readFileSync(new URL("../src/ferramentas/midia.ts", import.meta.url), "utf8");
    assert.equal(midia.match(/gerarMiniatura\(/g)?.length, 1);
    // Dentro do `enviar` (o que roda no clique), depois da conferência do arquivo.
    assert.ok(midia.indexOf("gerarMiniatura(") > midia.indexOf("if (sha256(agora) !== c.sha256)"));
  });

  it("vídeo sai sem miniatura calculada (nada de ffmpeg) e voz sai como mensagem de voz", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    const v = arquivoTemp(m, "v.mp4", Buffer.from("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00", "latin1"));
    const o = arquivoTemp(m, "n.ogg", Buffer.concat([Buffer.from("OggS"), Buffer.alloc(24), Buffer.from("OpusHead")]));
    await clicar(c, await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: v }), "");
    const voz = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: o, voz: true });
    assert.equal(voz.isError, undefined, textoDe(voz));
    await clicar(c, voz);
    const [video, audio] = envios(s).map((e) => e.args[1] as Record<string, unknown>);
    assert.equal(video!.jpegThumbnail, "", "miniatura vazia: a Baileys não chama o ffmpeg");
    assert.equal(audio!.ptt, true);
    assert.equal(audio!.mimetype, "audio/ogg; codecs=opus");
  });

  it("grupo escolhido: o mesmo aviso de grupo do wa_responder", async () => {
    const { m, c } = await cenario({ ligar: true });
    const p = arquivoTemp(m, "a.txt", Buffer.from("oi"));
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: GRUPO, arquivo: p });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.match(String((previa._meta!.previa as Record<string, unknown>).destaque), /ENVIO PARA GRUPO: 12 participantes/);
  });

  it("recusa antes da prévia: envio desligado, número novo, caminho relativo, inexistente, pasta, vazio, grande demais, pasta de dados e segredos", async () => {
    const { m, c } = await cenario({ ligar: false });
    const p = arquivoTemp(m, "a.txt", Buffer.from("oi"));
    const desligado = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
    assert.match(erroDe(desligado), /wa_envio/);
    await ligarEnvio(c);
    const env = arquivoTemp(m, ".env", Buffer.from("SEGREDO=1"));
    const grande = arquivoTemp(m, "g.jpg", Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(17 * 1024 * 1024)]));
    const vazio = arquivoTemp(m, "v.txt", Buffer.alloc(0));
    const casos: Array<[Record<string, unknown>, RegExp]> = [
      [{ conversa: "5531999990000", arquivo: p }, /Não achei|não existe|wa_iniciar_conversa|conversa/],
      [{ conversa: ANA, arquivo: "relativo/a.txt" }, /caminho completo/],
      [{ conversa: ANA, arquivo: join(m.dir, "nao-existe.txt") }, /não existe/],
      [{ conversa: ANA, arquivo: m.dir }, /não é um arquivo/],
      [{ conversa: ANA, arquivo: vazio }, /vazio/],
      [{ conversa: ANA, arquivo: grande }, /16 MB/],
      [{ conversa: ANA, arquivo: join(m.config.dirDados, "indice.enc") }, /pasta de dados|não envio/],
      [{ conversa: ANA, arquivo: env }, /segredo|não envio/],
      [{ conversa: ANA, arquivo: p, voz: true }, /OGG\/Opus/],
    ];
    for (const [args, erro] of casos) {
      const r = await chamarCru(c, "wa_enviar_arquivo", args);
      assert.equal(r.isError, true, JSON.stringify(args));
      assert.match(erroDe(r), erro, JSON.stringify(args));
      assert.equal(r._meta, undefined, "sem prévia");
    }
  });

  it("arquivo que mudou depois da prévia: o clique não envia", async () => {
    const { m, s, c } = await cenario({ ligar: true });
    const p = arquivoTemp(m, "a.txt", Buffer.from("versão 1"));
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: p });
    writeFileSync(p, "versão 2");
    utimesSync(p, new Date(), new Date(Date.now() + 5000));
    const r = await clicar(c, previa, "");
    assert.equal(r.isError, true);
    assert.match(erroDe(r), /mudou/);
    assert.equal(envios(s).length, 0);
  });
});

describe("cartão, instruções e desconectar", () => {
  it("o cartão do arquivo: legenda pode ficar vazia; rótulo próprio", () => {
    assert.equal(podeEnviar("", 4096, "caracteres", true), true);
    assert.equal(podeEnviar("", 4096, "caracteres"), false, "nos outros pedidos, texto vazio não envia");
    assert.match(rotuloDoTextoEditavel("arquivo"), /Legenda/);
    assert.equal(arquivoParaMostrar({}), null);
  });

  it("instruções falam das duas ferramentas e de que os arquivos abertos ficam sem cifra", () => {
    assert.match(INSTRUCOES, /wa_abrir_midia/);
    assert.match(INSTRUCOES, /wa_enviar_arquivo/);
    assert.match(INSTRUCOES, /sem cifra/);
    assert.ok(!/ver ou baixar fotos/.test(INSTRUCOES), "não diz mais que não dá para ver mídia");
  });

  it("o cartão do wa_desconectar avisa que os arquivos abertos não são apagados", async () => {
    const { c } = await cenario();
    const r = await chamarCru(c, "wa_desconectar");
    const p = r._meta!.previa as { detalhes: string[] };
    assert.ok(p.detalhes.some((d) => /Downloads/.test(d) && /não (são|é) apagad/.test(d)), JSON.stringify(p.detalhes));
  });
});

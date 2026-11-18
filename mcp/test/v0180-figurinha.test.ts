// 0.18.0: envio de figurinha (sticker). O wa_enviar_arquivo ganha `figurinha: true`: o WebP vai como figurinha, não
// como foto. Sem a opção, nada muda (o .webp continua indo como imagem). Antes do cartão, o arquivo é lido e o contêiner
// RIFF/WebP é conferido por código, sem dependência nova (chunks VP8, VP8L, VP8X, ANIM e ANMF): WebP de verdade,
// exatamente 512x512, parada até 100 KB, animada até 500 KB. Figurinha não leva legenda e não combina com `voz` nem com
// `como_documento`: cada caso recusa com a frase e nada é preparado. Envia SÓ depois do clique.
// Os WebP de teste são montados aqui, byte a byte (cabeçalhos de verdade; o conteúdo da imagem não é decodificado por
// ninguém: nem por nós, nem pela Baileys no envio de figurinha).

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { FIGURINHA_ANIMADA_MAXIMA_BYTES, FIGURINHA_PARADA_MAXIMA_BYTES, lerWebp, tipoParaEnviar, validarFigurinha } from "../src/midia.ts";
import { INSTRUCOES } from "../src/servidor.ts";
import { arquivoParaMostrar } from "../ui/edicao.js";
import { ANA, assentar, chamar, chamarCru, clicar, confirmarPeloChat, conectar, conectarCliente, ligarEnvio, montar, pn, textoDe, type Montagem, type Resultado } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

// ---- WebP montado à mão ----

const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
};
const u24 = (n: number) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);
/** Um chunk RIFF: fourcc, tamanho e conteúdo, com o byte de preenchimento quando o tamanho é ímpar. */
const pedaco = (fourcc: string, conteudo: Buffer) => Buffer.concat([Buffer.from(fourcc, "latin1"), u32(conteudo.length), conteudo, conteudo.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
const riff = (...pedacos: Buffer[]) => {
  const corpo = Buffer.concat([Buffer.from("WEBP", "latin1"), ...pedacos]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32(corpo.length), corpo]);
};
/** VP8L (sem perda): assinatura 0x2f e 14 bits de largura-1 e altura-1. `extra` bytes de "imagem" depois. */
const vp8l = (w: number, h: number, extra = 16) => {
  const c = Buffer.alloc(5 + extra, 0x55);
  c[0] = 0x2f;
  c.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | (1 << 28)) >>> 0, 1);
  return pedaco("VP8L", c);
};
/** VP8 (com perda): marca do quadro-chave (bit 0 = 0), código 9d 01 2a, largura e altura de 14 bits. */
const vp8 = (w: number, h: number, extra = 16) => {
  const c = Buffer.alloc(10 + extra, 0x33);
  c[0] = 0x50;
  c[1] = 0x02;
  c[2] = 0x00;
  c[3] = 0x9d;
  c[4] = 0x01;
  c[5] = 0x2a;
  c.writeUInt16LE(w & 0x3fff, 6);
  c.writeUInt16LE(h & 0x3fff, 8);
  return pedaco("VP8 ", c);
};
/** VP8X: bandeiras (0x02 = animação, 0x10 = alfa) e a tela em 24 bits de largura-1 e altura-1. */
const vp8x = (w: number, h: number, bandeiras: number) => pedaco("VP8X", Buffer.concat([Buffer.from([bandeiras, 0, 0, 0]), u24(w - 1), u24(h - 1)]));
const anim = () => pedaco("ANIM", Buffer.from([0, 0, 0, 0, 0, 0]));
const anmf = (w: number, h: number, extra = 16) => pedaco("ANMF", Buffer.concat([u24(0), u24(0), u24(w - 1), u24(h - 1), u24(100), Buffer.from([0]), vp8l(w, h, extra)]));

const PARADA = riff(vp8l(512, 512));
const PARADA_COM_PERDA = riff(vp8(512, 512));
const PARADA_VP8X = riff(vp8x(512, 512, 0x10), vp8l(512, 512));
const ANIMADA = riff(vp8x(512, 512, 0x12), anim(), anmf(512, 512), anmf(512, 512));
const PNG_1x1 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a3c2d3e40000000049454e44ae426082", "hex");

describe("0.18.0: leitura do contêiner WebP (função pura)", () => {
  it("VP8L, VP8 e VP8X parados: 512x512, não animada", () => {
    for (const b of [PARADA, PARADA_COM_PERDA, PARADA_VP8X]) assert.deepEqual(lerWebp(b), { largura: 512, altura: 512, animada: false });
    assert.deepEqual(lerWebp(riff(vp8l(300, 200))), { largura: 300, altura: 200, animada: false });
    assert.deepEqual(lerWebp(riff(vp8(96, 64))), { largura: 96, altura: 64, animada: false });
  });

  it("VP8X com a bandeira de animação, ANIM e ANMF: animada, pela tela do VP8X", () => {
    assert.deepEqual(lerWebp(ANIMADA), { largura: 512, altura: 512, animada: true });
    assert.deepEqual(lerWebp(riff(vp8x(640, 480, 0x02), anim(), anmf(640, 480))), { largura: 640, altura: 480, animada: true });
  });

  it("não WebP, cortado ou incoerente: undefined", () => {
    assert.equal(lerWebp(PNG_1x1), undefined, "PNG");
    assert.equal(lerWebp(Buffer.from("RIFF\x04\x00\x00\x00WAVE", "latin1")), undefined, "WAV");
    assert.equal(lerWebp(PARADA.subarray(0, 20)), undefined, "cortado no meio do chunk");
    assert.equal(lerWebp(riff()), undefined, "sem chunk de imagem");
    assert.equal(lerWebp(riff(vp8x(512, 512, 0x02))), undefined, "bandeira de animação sem ANIM/ANMF");
    assert.equal(lerWebp(riff(vp8x(512, 512, 0x10))), undefined, "VP8X parado sem VP8/VP8L");
    assert.equal(lerWebp(riff(vp8x(512, 512, 0x10), anim(), anmf(512, 512))), undefined, "quadros sem a bandeira de animação");
    const semAssinatura = Buffer.from(PARADA);
    semAssinatura[20] = 0x00; // o 0x2f do VP8L
    assert.equal(lerWebp(semAssinatura), undefined, "VP8L sem a assinatura");
    const tamanhoMentiroso = Buffer.from(PARADA);
    tamanhoMentiroso.writeUInt32LE(PARADA.length * 2, 4);
    assert.equal(lerWebp(tamanhoMentiroso), undefined, "RIFF declara mais bytes do que o arquivo tem");
  });

  it("validarFigurinha: os tetos de 100 KB (parada) e 500 KB (animada) e o tamanho exato, com o valor encontrado na frase", () => {
    assert.equal(FIGURINHA_PARADA_MAXIMA_BYTES, 100 * 1024);
    assert.equal(FIGURINHA_ANIMADA_MAXIMA_BYTES, 500 * 1024);
    assert.deepEqual(validarFigurinha(PARADA), { animada: false, largura: 512, altura: 512 });
    assert.deepEqual(validarFigurinha(ANIMADA), { animada: true, largura: 512, altura: 512 });
    assert.throws(() => validarFigurinha(riff(vp8l(300, 300))), /512x512.*300x300/s);
    assert.throws(() => validarFigurinha(PNG_1x1), /WebP/);
    const grandeParada = riff(vp8l(512, 512, 101 * 1024));
    assert.throws(() => validarFigurinha(grandeParada), (e: Error) => /parada/.test(e.message) && /100 KB/.test(e.message) && e.message.includes(`${grandeParada.length} bytes`));
    // Animada de 200 KB passa (o teto dela é 500 KB); parada do mesmo tamanho não.
    assert.equal(validarFigurinha(riff(vp8x(512, 512, 0x02), anim(), anmf(512, 512, 200 * 1024))).animada, true);
    const grandeAnimada = riff(vp8x(512, 512, 0x02), anim(), anmf(512, 512, 501 * 1024));
    assert.throws(() => validarFigurinha(grandeAnimada), /animada.*500 KB/s);
  });

  it("tipoParaEnviar: sem `figurinha`, .webp continua imagem; com ela, figurinha (image/webp); com voz ou documento, erro", () => {
    assert.deepEqual(tipoParaEnviar("/a/f.webp", PARADA, {}), { tipo: "imagem", mimetype: "image/webp" });
    assert.deepEqual(tipoParaEnviar("/a/f.webp", PARADA, { figurinha: true }), { tipo: "figurinha", mimetype: "image/webp" });
    assert.throws(() => tipoParaEnviar("/a/f.webp", PARADA, { figurinha: true, voz: true }), /Nada foi preparado/);
    assert.throws(() => tipoParaEnviar("/a/f.webp", PARADA, { figurinha: true, como_documento: true }), /Nada foi preparado/);
    assert.throws(() => tipoParaEnviar("/a/f.png", PNG_1x1, { figurinha: true }), /WebP/);
  });
});

describe("0.18.0: o que a Baileys rc14 faz com o conteúdo que o transporte monta (sem rede: upload falso)", () => {
  it("vira stickerMessage com mimetype, 512x512 e isAnimated; só cifra e envia (nenhuma miniatura calculada)", async () => {
    const { generateWAMessageContent } = await import("@whiskeysockets/baileys");
    for (const [arquivoWebp, animada] of [[PARADA, false], [ANIMADA, true]] as const) {
      const uploads: Array<Record<string, unknown>> = [];
      const upload = async (_caminho: string, o: Record<string, unknown>) => {
        uploads.push(o);
        return { mediaUrl: "https://exemplo.invalid/m", directPath: "/m" };
      };
      // O mesmo objeto do ramo `figurinha` de transporte.enviarArquivo.
      const r = await generateWAMessageContent({ sticker: arquivoWebp, mimetype: "image/webp", isAnimated: animada, width: 512, height: 512 } as never, { upload } as never);
      const s = r.stickerMessage!;
      assert.ok(s, "stickerMessage, não imageMessage");
      assert.ok(!r.imageMessage, "nada de imageMessage");
      assert.equal(s.mimetype, "image/webp");
      assert.equal(s.width, 512);
      assert.equal(s.height, 512);
      assert.equal(s.isAnimated, animada);
      assert.equal(Number(s.fileLength), arquivoWebp.length);
      assert.ok(!s.pngThumbnail?.length && !("jpegThumbnail" in s), "sem miniatura");
      assert.deepEqual(uploads.map((u) => u.mediaType), ["sticker"]);
    }
  });
});

// ---- a ferramenta, com socket falso e a casa na pasta temporária ----

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const envios = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendMessage");
const presencas = (s: SocketFalso) => s.chamadas.filter((c) => c.metodo === "sendPresenceUpdate").map((c) => c.args[0]);
const erroDe = (r: Resultado) => String(r.structuredContent?.erro ?? textoDe(r));
type Obj = Record<string, unknown>;

async function cenario(): Promise<{ s: SocketFalso; c: Cliente; m: Montagem }> {
  m = await montar();
  const s = await conectar(m);
  await assentar(m);
  s.mensagens([msg({ jid: pn(ANA), id: "T1", texto: "oi", nome: "Ana" })]);
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  await ligarEnvio(cliente);
  return { s, c: cliente, m };
}

function arquivo(mm: Montagem, nome: string, conteudo: Buffer): string {
  const dir = join(mm.dir, "Pictures", "figurinhas");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, nome);
  writeFileSync(p, conteudo);
  return p;
}

describe("0.18.0: wa_enviar_arquivo com `figurinha`", () => {
  it("sem a opção, o .webp 512x512 continua indo como imagem (nada muda)", async () => {
    const { s, c, m } = await cenario();
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: arquivo(m, "f.webp", PARADA) });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.match(arquivoParaMostrar(previa._meta!.previa)!.tipo, /^imagem/);
    const r = await clicar(c, previa, "");
    assert.equal(r.isError, undefined, textoDe(r));
    const conteudo = envios(s)[0]!.args[1] as Obj;
    assert.deepEqual(conteudo.image, PARADA);
    assert.equal(conteudo.sticker, undefined);
  });

  it("figurinha parada: cartão diz 'figurinha', sem legenda editável e com a própria figurinha; envia como sticker só depois do clique", async () => {
    const { s, c, m } = await cenario();
    const caminho = arquivo(m, "gato.webp", PARADA);
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: caminho, figurinha: true });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as Obj;
    const arq = arquivoParaMostrar(p)!;
    assert.match(arq.tipo, /^figurinha \(/);
    assert.ok(!/animada/.test(arq.tipo));
    assert.match(arq.tamanho, /bytes/);
    assert.match(arq.caminho, /gato\.webp$/);
    assert.equal(arq.imagem, `data:image/webp;base64,${PARADA.toString("base64")}`, "o dono vê a figurinha no cartão");
    assert.equal("texto" in p, false, "figurinha não tem legenda: nada de campo editável");
    assert.equal("texto_editavel" in p, false);
    assert.equal(envios(s).length, 0, "nada sem o clique");

    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(envios(s).length, 1);
    const [jid, conteudo] = envios(s)[0]!.args as [string, Obj];
    assert.equal(jid, pn(ANA));
    assert.deepEqual(conteudo.sticker, PARADA);
    assert.equal(conteudo.mimetype, "image/webp");
    assert.equal(conteudo.isAnimated, false);
    assert.equal(conteudo.width, 512);
    assert.equal(conteudo.height, 512);
    assert.equal(conteudo.image, undefined, "não vai como foto");
    assert.equal(conteudo.caption, undefined);
    assert.ok(!("jpegThumbnail" in conteudo), "a Baileys não faz miniatura de figurinha; nada a mandar");
    assert.deepEqual(presencas(s).slice(-2), ["composing", "paused"]);

    // O que o próprio conector guarda do envio: figurinha, de mim, sem texto.
    const lida = await chamar(c, "wa_ler_conversa", { conversa: ANA });
    const ultima = (lida.mensagens as Obj[]).at(-1)!;
    assert.equal(ultima.tipo, "figurinha");
    assert.equal(ultima.de_mim, true);
    assert.equal(ultima.texto, undefined);
    assert.equal((await m.ctx.nucleo()).banco.enviosDoDia(Date.now()), 1, "conta no limite diário");
  });

  it("figurinha animada: detectada, o cartão diz 'figurinha animada' e o sticker sai com isAnimated", async () => {
    const { s, c, m } = await cenario();
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: arquivo(m, "danca.webp", ANIMADA), figurinha: true });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.match(arquivoParaMostrar(previa._meta!.previa)!.tipo, /^figurinha animada/);
    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    const conteudo = envios(s)[0]!.args[1] as Obj;
    assert.deepEqual(conteudo.sticker, ANIMADA);
    assert.equal(conteudo.isAnimated, true);
    assert.equal(conteudo.width, 512);
    assert.equal(conteudo.height, 512);
  });

  it("confirmação pelo chat (aba Code) também envia: pedido sem texto, sem `texto`", async () => {
    const { s, c, m } = await cenario();
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, arquivo: arquivo(m, "f.webp", PARADA_COM_PERDA), figurinha: true });
    const r = await confirmarPeloChat(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual((envios(s)[0]!.args[1] as Obj).sticker, PARADA_COM_PERDA);
  });

  it("recusas antes do cartão: tamanho errado, acima do teto, não WebP, legenda, com voz e com documento; nada preparado, nada enviado", async () => {
    const { s, c, m } = await cenario();
    const grandeParada = riff(vp8l(512, 512, 120 * 1024));
    const grandeAnimada = riff(vp8x(512, 512, 0x02), anim(), anmf(512, 512, 520 * 1024));
    const casos: Array<[Obj, RegExp]> = [
      [{ arquivo: arquivo(m, "pequena.webp", riff(vp8l(256, 256))), figurinha: true }, /512x512.*256x256/s],
      [{ arquivo: arquivo(m, "retangulo.webp", riff(vp8x(512, 300, 0x10), vp8l(512, 300))), figurinha: true }, /512x512.*512x300/s],
      [{ arquivo: arquivo(m, "grande.webp", grandeParada), figurinha: true }, new RegExp(`parada.*100 KB.*${grandeParada.length} bytes`, "s")],
      [{ arquivo: arquivo(m, "grande-animada.webp", grandeAnimada), figurinha: true }, new RegExp(`animada.*500 KB.*${grandeAnimada.length} bytes`, "s")],
      [{ arquivo: arquivo(m, "foto.png", PNG_1x1), figurinha: true }, /WebP/],
      [{ arquivo: arquivo(m, "falsa.webp", PNG_1x1), figurinha: true }, /WebP/],
      [{ arquivo: arquivo(m, "quebrada.webp", PARADA.subarray(0, 24)), figurinha: true }, /WebP/],
      [{ arquivo: arquivo(m, "l.webp", PARADA), figurinha: true, legenda: "olha isso" }, /legenda/],
      [{ arquivo: arquivo(m, "v.webp", PARADA), figurinha: true, voz: true }, /voz/],
      [{ arquivo: arquivo(m, "d.webp", PARADA), figurinha: true, como_documento: true }, /documento/],
    ];
    for (const [args, erro] of casos) {
      const r = await chamarCru(c, "wa_enviar_arquivo", { conversa: ANA, ...args });
      const rotulo = JSON.stringify({ ...args, arquivo: String(args.arquivo).split("/").pop() });
      assert.equal(r.isError, true, rotulo);
      assert.match(erroDe(r), erro, rotulo);
      assert.match(erroDe(r), /Nada foi preparado\.$/, rotulo);
      assert.equal(r._meta, undefined, `sem prévia: ${rotulo}`);
    }
    assert.equal(envios(s).length, 0);
    assert.equal((await m.ctx.nucleo()).banco.enviosDoDia(Date.now()), 0);
  });

  it("descrição da ferramenta e instruções do servidor falam da figurinha e dos requisitos", async () => {
    const { c } = await cenario();
    const f = (await c.listTools()).tools.find((t) => t.name === "wa_enviar_arquivo")!;
    for (const texto of [f.description ?? "", INSTRUCOES]) {
      assert.match(texto, /figurinha/);
      assert.match(texto, /512x512/);
      assert.match(texto, /100 KB/);
      assert.match(texto, /500 KB/);
    }
    const props = (f.inputSchema as { properties: Record<string, { default?: unknown }> }).properties;
    assert.equal(props.figurinha?.default, false);
  });
});

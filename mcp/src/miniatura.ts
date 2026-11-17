// Miniatura da foto que o DONO envia (wa_enviar_arquivo, 0.7.0): gerada aqui, depois do clique, e passada pronta à
// Baileys (`jpegThumbnail`, `width`, `height`).
//
// Por que aqui e não na Baileys: a rc14 procura `jimp`/`sharp` (lib/Utils/messages-media.js:16-26) e, com o jimp 1.x,
// confere `typeof Jimp === "object"` (linha 116), mas no jimp 1.x `Jimp` é uma classe (function): o caminho dela
// nunca funciona. E assim o jimp nunca é chamado pela Baileys (o `import("jimp")` dela continua externo e falha):
// só esta função, só com o arquivo que o dono está mandando, só depois do clique. Nunca com mídia recebida.
//
// Jimp "magro": só o núcleo, JPEG, PNG e redimensionar (cerca de 260 KB no pacote, contra 620 KB do jimp inteiro).
// WebP e o resto: sem miniatura. Limite de trabalho: as dimensões são lidas do cabeçalho ANTES de decodificar, e acima
// de 25 megapixels não decodifica (a decodificação é síncrona: não há como parar no meio). Falha nunca derruba o envio:
// quem chama manda sem miniatura e diz isso.

import { createJimp } from "@jimp/core";
import jpeg from "@jimp/js-jpeg";
import png from "@jimp/js-png";
import { methods as redimensionar } from "@jimp/plugin-resize";

const Jimp = createJimp({ formats: [jpeg, png], plugins: [redimensionar] });

/** Largura da miniatura (a mesma que a Baileys usa) e qualidade do JPEG. */
export const LARGURA_DA_MINIATURA = 32;
const QUALIDADE = 50;
/** Acima disso a foto não é decodificada para a miniatura (memória: ~4 bytes por pixel). */
export const MAXIMO_DE_MEGAPIXELS_DA_MINIATURA = 25;

export type Miniatura = { jpegThumbnail: string; width: number; height: number; bytes: number } | { erro: string };

/** Largura e altura pelo cabeçalho (PNG: IHDR; JPEG: o primeiro SOF). undefined se não der para ler. */
export function dimensoesDaImagem(b: Buffer): { largura: number; altura: number } | undefined {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString("latin1") === "IHDR") {
    return { largura: b.readUInt32BE(16), altura: b.readUInt32BE(20) };
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marca = b[i + 1]!;
      if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7) || marca === 0xff) {
        i += marca === 0xff ? 1 : 2;
        continue;
      }
      const tamanho = b.readUInt16BE(i + 2);
      // SOF0..SOF15, menos DHT (C4), JPG (C8) e DAC (CC).
      if (marca >= 0xc0 && marca <= 0xcf && marca !== 0xc4 && marca !== 0xc8 && marca !== 0xcc) {
        return { altura: b.readUInt16BE(i + 5), largura: b.readUInt16BE(i + 7) };
      }
      if (tamanho < 2) return undefined;
      i += 2 + tamanho;
    }
  }
  return undefined;
}

/** Gera a miniatura JPEG (base64) de uma foto JPEG ou PNG do dono. Nunca lança: devolve `{ erro }`. */
export async function gerarMiniatura(conteudo: Buffer, mimetype: string): Promise<Miniatura> {
  try {
    if (mimetype !== "image/jpeg" && mimetype !== "image/png") return { erro: "sem miniatura para esse formato (só JPEG e PNG)" };
    const d = dimensoesDaImagem(conteudo);
    if (!d || d.largura <= 0 || d.altura <= 0) return { erro: "não consegui ler o tamanho da imagem" };
    if (d.largura * d.altura > MAXIMO_DE_MEGAPIXELS_DA_MINIATURA * 1_000_000) return { erro: `imagem grande demais para a miniatura (mais de ${MAXIMO_DE_MEGAPIXELS_DA_MINIATURA} megapixels)` };
    const img = await Jimp.fromBuffer(conteudo, { "image/jpeg": { maxResolutionInMP: MAXIMO_DE_MEGAPIXELS_DA_MINIATURA, maxMemoryUsageInMB: 256 } });
    const largura = img.bitmap.width;
    const altura = img.bitmap.height;
    img.resize({ w: LARGURA_DA_MINIATURA });
    const jpg = await img.getBuffer("image/jpeg", { quality: QUALIDADE });
    return { jpegThumbnail: jpg.toString("base64"), width: largura, height: altura, bytes: jpg.length };
  } catch {
    return { erro: "não consegui gerar a miniatura" };
  }
}

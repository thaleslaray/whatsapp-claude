// Gera mcpb/icon.png (512x512, o tamanho que o mcpb recomenda): um quadrado escuro arredondado com um balão de conversa claro e três pontos laranja.
// Sem logo do WhatsApp nem marca de ninguém (nada de verde, nada de telefone). Só node:zlib, sem dependência.
// Rodar: npm run gerar-icone (o arquivo gerado é versionado; só precisa rodar de novo se o desenho mudar).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const LADO = 512;
const ESCALA = LADO / 256; // o desenho abaixo está em coordenadas de 0 a 256
const AMOSTRAS = 4; // 4x4 amostras por pixel: bordas suaves

const FUNDO = [0x1a, 0x1a, 0x1a];
const BALAO = [0xf5, 0xf2, 0xed];
const PONTO = [0xff, 0x4d, 0x00];

/** Dentro de um retângulo de cantos arredondados (x0,y0)-(x1,y1) com raio r? */
function noRetangulo(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/** Dentro do triângulo (a, b, c)? */
function noTriangulo(x, y, [ax, ay], [bx, by], [cx, cy]) {
  const s = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = s(x, y, ax, ay, bx, by);
  const d2 = s(x, y, bx, by, cx, cy);
  const d3 = s(x, y, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** Cor (ou null = transparente) de um ponto. */
function cor(xPx, yPx) {
  const x = xPx / ESCALA;
  const y = yPx / ESCALA;
  if (!noRetangulo(x, y, 8, 8, 248, 248, 56)) return null;
  for (const px of [92, 128, 164]) if ((x - px) ** 2 + (y - 116) ** 2 <= 13 ** 2) return PONTO;
  const balao = noRetangulo(x, y, 44, 56, 212, 176, 40) || noTriangulo(x, y, [70, 160], [112, 170], [62, 210]);
  return balao ? BALAO : FUNDO;
}

const linhas = [];
for (let y = 0; y < LADO; y++) {
  const linha = Buffer.alloc(1 + LADO * 4); // byte 0: filtro 0
  for (let x = 0; x < LADO; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < AMOSTRAS; sy++) {
      for (let sx = 0; sx < AMOSTRAS; sx++) {
        const c = cor(x + (sx + 0.5) / AMOSTRAS, y + (sy + 0.5) / AMOSTRAS);
        if (!c) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        a++;
      }
    }
    const o = 1 + x * 4;
    if (a > 0) {
      linha[o] = Math.round(r / a);
      linha[o + 1] = Math.round(g / a);
      linha[o + 2] = Math.round(b / a);
    }
    linha[o + 3] = Math.round((255 * a) / AMOSTRAS ** 2);
  }
  linhas.push(linha);
}

const TABELA = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABELA[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function bloco(tipo, dados) {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "ascii"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}

const cabecalho = Buffer.alloc(13);
cabecalho.writeUInt32BE(LADO, 0);
cabecalho.writeUInt32BE(LADO, 4);
cabecalho[8] = 8; // 8 bits por canal
cabecalho[9] = 6; // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  bloco("IHDR", cabecalho),
  bloco("IDAT", deflateSync(Buffer.concat(linhas), { level: 9 })),
  bloco("IEND", Buffer.alloc(0)),
]);
const saida = join(RAIZ, "mcpb", "icon.png");
writeFileSync(saida, png);
console.error(`gerar-icone: ${saida} (${png.length} bytes)`);

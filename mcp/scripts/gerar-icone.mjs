// Gera mcpb/icon.png (512x512, o tamanho que o mcpb recomenda): o logo do WhatsApp (balão verde com contorno e telefone
// brancos), ocupando a imagem inteira, com fundo transparente. Trocado em 18/11/2026 a pedido do dono, para a versão pública:
// antes era um balão genérico, de propósito sem a marca. A marca é da Meta; a descrição da extensão diz que o projeto
// não é oficial.
// Desenha a partir de um SVG com o `sharp` que já vem em node_modules (não entra no pacote: só o PNG gerado entra).
// Rodar: npm run gerar-icone (o arquivo gerado é versionado; só precisa rodar de novo se o desenho mudar).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const LADO = 512;
const VERDE = "#25D366";

// O símbolo num quadro de 24x24 (balão com a ponta embaixo à esquerda e o telefone dentro).
const SIMBOLO =
  "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z";

// O contorno de fora do símbolo (o balão inteiro), para pintar o verde por baixo do branco.
const BALAO =
  "M20.463 3.488A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z";

// O logo ocupa a imagem inteira (o dono pediu em 18/11/2026: com quadrado de fundo e margem, o Claude Desktop, que já
// põe a própria moldura em volta, mostrava o símbolo pequeno). Fundo transparente, 6 px de folga em cada lado.
const FOLGA = 6;
const escala = (LADO - 2 * FOLGA) / 24;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${LADO}" height="${LADO}" viewBox="0 0 ${LADO} ${LADO}">
  <g transform="translate(${FOLGA} ${FOLGA}) scale(${escala})">
    <path fill="${VERDE}" d="${BALAO}"/>
    <path fill="#ffffff" d="${SIMBOLO}"/>
  </g>
</svg>`;

let sharp;
try {
  ({ default: sharp } = await import("sharp"));
} catch {
  console.error("gerar-icone: falta o `sharp` em node_modules (rode `npm install`). Nada foi gerado.");
  process.exit(1);
}
const png = await sharp(Buffer.from(svg), { density: 72 }).resize(LADO, LADO).png({ compressionLevel: 9 }).toBuffer();
const saida = join(RAIZ, "mcpb", "icon.png");
writeFileSync(saida, png);
console.error(`gerar-icone: ${saida} (${png.length} bytes)`);

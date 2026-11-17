// Medida (não é teste da suíte; 0.11.0, item 10): o histórico do pareamento com 40 eventos, 300 conversas e 20 mil
// mensagens, conversas que se repetem entre eventos. Diz o tempo total e o maior trecho sem devolver o controle ao laço.
//   node --import ./test/setup.ts test/medir-pareamento.ts            # 50 conversas por evento, espalhado
//   PESADA=1 node --import ./test/setup.ts test/medir-pareamento.ts   # 60% das mensagens em 5 conversas
//   GIGANTE=1 node --import ./test/setup.ts test/medir-pareamento.ts  # 1 de cada 4 numa conversa que chega a 5.000
// Pasta temporária, rede bloqueada, socket falso.

import { assentar, conectar, montar, pn } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const m = await montar({ maxMensagens: 5_000 });
const s = await conectar(m);
await assentar(m);
const EVENTOS = 40;
const CONVERSAS = 300;
const POR_EVENTO = 20_000 / EVENTOS;
const base = Math.floor((Date.now() - 30 * 86_400_000) / 1_000) * 1_000;
let k = 0;
const eventos = Array.from({ length: EVENTOS }, (_, e) =>
  Array.from({ length: POR_EVENTO }, (_, i) => {
    const pesada = (process.env.PESADA === "1" && i % 5 < 3) || (process.env.GIGANTE === "1" && i % 4 === 0);
    const c = pesada ? (process.env.GIGANTE === "1" ? 0 : i % 5) : (e * 37 + (i % 50) * 6) % CONVERSAS;
    const numero = `55119${String(10_000_000 + c).padStart(8, "0")}`;
    const ts = base + k * 1_000;
    return msg({ jid: pn(numero), id: `H${k++}`, ts, texto: `mensagem ${k} com algum texto para pesar um pouco mais` });
  }),
);
let maior = 0;
let ultimo = performance.now();
const vigia = setInterval(() => {
  const agora = performance.now();
  maior = Math.max(maior, agora - ultimo);
  ultimo = agora;
}, 1);
const inicio = performance.now();
ultimo = inicio;
for (const messages of eventos) s.historico({ messages });
await assentar(m);
const total = performance.now() - inicio;
clearInterval(vigia);
const { banco } = await m.ctx.nucleo();
console.log(JSON.stringify({ total_ms: Math.round(total), maior_trecho_ms: Math.round(maior), conversas: banco.estatisticas().conversas }));
await m.fechar();

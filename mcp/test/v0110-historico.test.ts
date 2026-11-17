// 0.11.0: histórico.
// - wa_buscar_historico: a resposta decifrava o arquivo da conversa três vezes (antes, na gravação e depois); agora uma,
//   com o mesmo resultado (recebidas, novas, cortadas pelo teto).
// - histórico do pareamento: medida sintética (40 eventos, 300 conversas, 20 mil mensagens, conversas que se repetem
//   entre eventos) do tempo total e do maior trecho sem devolver o controle ao laço. Os números da máquina de
//   desenvolvimento estão no FICHA.md (0.11.0); aqui o teste só pega regressão grosseira (o laço preso por segundos).
// Sem rede, socket falso.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ANA, assentar, conectar, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

let m: Montagem | undefined;
afterEach(async () => {
  await m?.fechar();
  m = undefined;
});

const BASE = Math.floor((Date.now() - 86_400_000) / 1_000) * 1_000;

describe("0.11.0: wa_buscar_historico lê o arquivo da conversa uma vez", () => {
  it("uma leitura por resposta (eram três) e o mesmo resultado, com repetida e corte pelo teto", async () => {
    m = await montar({ maxMensagens: 4, esperaDoHistoricoMs: 2_000 });
    const s = await conectar(m);
    s.mensagens([1, 2, 3].map((i) => msg({ jid: pn(ANA), id: `A${i}`, texto: `atual ${i}`, ts: BASE + i * 60_000 })));
    await assentar(m);
    const { banco } = await m.ctx.nucleo();
    const ancora = banco.lerMensagens(pn(ANA))[0]!;
    // Três na resposta: uma repetida (A1) e duas mais antigas; com o teto de 4, a mais antiga das novas é cortada.
    s.aoPedirHistorico = (p) =>
      s.historicoSobDemanda(
        [msg({ jid: pn(ANA), id: "A1", texto: "atual 1", ts: BASE + 60_000 }), msg({ jid: pn(ANA), id: "H1", texto: "velha 1", ts: BASE - 2_000 }), msg({ jid: pn(ANA), id: "H2", texto: "velha 2", ts: BASE - 1_000 })],
        { sessao: p.id },
      );
    let leituras = 0;
    const original = banco.lerMensagens.bind(banco);
    banco.lerMensagens = (jid) => {
      if (jid === pn(ANA)) leituras++;
      return original(jid);
    };
    const r = await m.ctx.transporte!.buscarHistorico(pn(ANA), 10, { id: ancora.id, de_mim: false, ts: ancora.ts }, 2_000);
    banco.lerMensagens = original;
    assert.equal(r.chegou, true);
    assert.deepEqual({ recebidas: r.recebidas, novas: r.novas, cortadas: r.cortadas }, { recebidas: 3, novas: 1, cortadas: 1 });
    assert.equal(leituras, 1, "uma leitura do arquivo da conversa por resposta");
    assert.deepEqual(banco.lerMensagens(pn(ANA)).map((x) => x.id), ["H2", "A1", "A2", "A3"]);
  });
});

describe("0.11.0: histórico do pareamento (medida sintética)", () => {
  it("40 eventos, 300 conversas, 20 mil mensagens: tudo gravado, e o laço nunca fica preso por segundos", async () => {
    m = await montar({ maxMensagens: 5_000 });
    const s = await conectar(m);
    await assentar(m);
    const EVENTOS = 40;
    const CONVERSAS = 300;
    const POR_EVENTO = 500;
    let k = 0;
    const eventos = Array.from({ length: EVENTOS }, (_, e) =>
      Array.from({ length: POR_EVENTO }, (_, i) => {
        // Cada evento toca 50 conversas (que se repetem entre eventos) e, em 1 de cada 4 mensagens, a mesma conversa
        // grande (que chega a 5.000 mensagens): o pior caso de regravar a conversa inteira a cada evento.
        const c = i % 4 === 0 ? 0 : (e * 37 + (i % 50) * 6) % CONVERSAS;
        const numero = `55119${String(10_000_000 + c).padStart(8, "0")}`;
        const ts = BASE + k * 1_000;
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
    assert.equal(banco.estatisticas().conversas, CONVERSAS);
    assert.equal(banco.lerMensagens(pn("5511910000000")).length, 5_000);
    // Na máquina de desenvolvimento: ~4 s no total e ~26 ms no maior trecho (FICHA.md). O limite aqui é largo de
    // propósito (a suíte roda arquivos em paralelo e o sistema pode tirar a CPU do processo): pega o laço preso.
    assert.ok(maior < 1_000, `maior trecho sem ceder: ${Math.round(maior)} ms (total ${Math.round(total)} ms)`);
  });
});

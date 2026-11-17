// 0.13.1: wa_buscar_historico em GRUPO ESCOLHIDO sem mensagem guardada (experimento): o pedido parte de uma âncora
// sintética (agora_de_mim, agora_de_outro, sem_id), em rodízio no modo auto, ou a forçada por `ancora`. Com o socket
// falso e o relógio falso: o pedido sai com a âncora certa; a resposta com mensagens grava e o pedido seguinte usa a
// âncora real; silêncio nas três para o `ate_total` com `sem_partida` e conta só três pedidos; conversa individual sem
// mensagem e grupo não escolhido continuam recusados; a caixa-preta só leva o nome da variação e contagens.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { ANA, assentar, BETO, chamarCru, conectar, conectarCliente, GRUPO, montar, OUTRO_GRUPO, pn, RelogioFalso, textoDe, type Montagem, type Resultado } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const sc = (r: Resultado) => (r.structuredContent ?? {}) as Obj;
const ID_DO_CLIENTE = /^3EB0[0-9A-F]{18}$/;

async function esperarAte(cond: () => boolean, oQue: string, limiteMs = 3_000): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (!cond()) {
    if (Date.now() > fim) throw new Error(`não aconteceu: ${oQue}`);
    await new Promise((pronto) => setTimeout(pronto, 5));
  }
}

interface Cena {
  s: SocketFalso;
  c: Cliente;
  relogio: RelogioFalso;
  caixa: string[];
  /** Os pedidos ao celular: [quantidade, chave, data]. */
  pedidos: () => Array<[number, { remoteJid?: string; id?: string; fromMe?: boolean; participant?: string }, number]>;
  /** Liga ou desliga a resposta do celular (com `n` mensagens mais antigas que a âncora). */
  responder: (sim: boolean) => void;
}

/** O grupo escolhido e SEM mensagem guardada; Ana tem uma mensagem. */
async function cenario(): Promise<Cena> {
  const relogio = new RelogioFalso();
  const caixa: string[] = [];
  m = await montar({ temporizador: relogio, esperaDoHistoricoMs: 30, caixaPreta: new CaixaPreta({ saida: (l) => caixa.push(l) }) });
  const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Clientes", size: 3, participants: [] }, [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Outro", size: 3, participants: [] } } });
  await assentar(m);
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  s.mensagens([msg({ jid: pn(ANA), id: "ANCORA-ANA", texto: "oi", nome: "Ana", ts: Date.now() - 60_000 })]);
  await assentar(m);
  let n = 0;
  const responder = (sim: boolean) => {
    s.aoPedirHistorico = sim
      ? (p) => {
          const jid = p.chave.remoteJid!;
          s.historicoSobDemanda(
            Array.from({ length: Math.min(p.quantidade, 50) }, (_, i) => msg({ jid, id: `VELHA-${++n}`, texto: `velha ${n}`, ts: p.ts - (i + 1) * 60_000, participante: pn(BETO) })),
            { sessao: p.id },
          );
        }
      : undefined;
  };
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  const pedidos = () => s.chamadas.filter((x) => x.metodo === "fetchMessageHistory").map((x) => x.args as Cena extends { pedidos: () => Array<infer T> } ? T : never);
  return { s, c: cliente, relogio, caixa, pedidos, responder };
}

const historico = (c: Cliente, args: Obj) => chamarCru(c, "wa_buscar_historico", args);
const semFreio = () => m!.ctx.ultimoHistorico.clear();
const guardadas = async (jid: string) => (await m!.ctx.nucleo()).banco.lerMensagens(jid);

describe("0.13.1: histórico de grupo escolhido sem mensagem guardada", () => {
  it("o pedido sai com âncora sintética (agora_de_mim); a resposta com mensagens grava sem não lidas; o seguinte usa a âncora real", async () => {
    const { c, pedidos, responder } = await cenario();
    responder(true);
    const antes = Date.now();
    const r = await historico(c, { conversa: GRUPO, quantidade: 10 });
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).ancora_usada, "agora_de_mim");
    assert.equal(sc(r).resultado_do_celular, "com_mensagens");
    assert.equal((sc(r).diagnostico as Obj).ancora, "agora_de_mim");
    assert.equal(sc(r).novas, 10);
    const [qtd, chave, ts] = pedidos().at(-1)!;
    assert.equal(qtd, 10);
    assert.equal(chave.remoteJid, GRUPO);
    assert.match(String(chave.id), ID_DO_CLIENTE);
    assert.equal(chave.fromMe, true);
    assert.ok(ts >= antes && ts <= Date.now(), "data de agora");
    assert.match(String(sc(r).para_o_claude), /SEM mensagem de partida/);
    const lista = await guardadas(GRUPO);
    assert.equal(lista.length, 10);
    assert.equal((await m!.ctx.nucleo()).banco.entrada(GRUPO)?.nao_lidas ?? 0, 0, "histórico não conta não lidas");
    semFreio();
    const r2 = await historico(c, { conversa: GRUPO, quantidade: 10 });
    assert.equal(sc(r2).ancora_usada, "real");
    const [, chave2, ts2] = pedidos().at(-1)!;
    assert.equal(chave2.id, lista[0]!.id, "a mais antiga guardada");
    assert.equal(ts2, lista[0]!.ts);
  });

  it("modo auto em silêncio: uma âncora por pedido, em rodízio (agora_de_mim, agora_de_outro, sem_id)", async () => {
    const { c, pedidos } = await cenario();
    const usadas: string[] = [];
    for (let i = 0; i < 4; i++) {
      semFreio();
      const r = await historico(c, { conversa: GRUPO, quantidade: 5 });
      assert.equal(r.isError, undefined, textoDe(r));
      assert.equal(sc(r).resultado_do_celular, "silencio");
      usadas.push(String(sc(r).ancora_usada));
    }
    assert.deepEqual(usadas, ["agora_de_mim", "agora_de_outro", "sem_id", "agora_de_mim"]);
    const chaves = pedidos().map((p) => p[1]);
    assert.equal(chaves[1]!.fromMe, false);
    assert.match(String(chaves[1]!.id), ID_DO_CLIENTE);
    assert.equal(chaves[1]!.participant, undefined, "o pedido não leva participante (o proto não tem o campo)");
    assert.equal(chaves[2]!.id, "", "sem_id: id vazio");
  });

  it("`ancora` forçada", async () => {
    const { c, pedidos } = await cenario();
    const r = await historico(c, { conversa: GRUPO, quantidade: 5, ancora: "sem_id" });
    assert.equal(sc(r).ancora_usada, "sem_id");
    assert.equal(pedidos().at(-1)![1].id, "");
    semFreio();
    const r2 = await historico(c, { conversa: GRUPO, quantidade: 5, ancora: "agora_de_outro" });
    assert.equal(sc(r2).ancora_usada, "agora_de_outro");
    assert.equal(pedidos().at(-1)![1].fromMe, false);
  });

  it("ate_total em grupo vazio, em silêncio: uma tentativa de cada âncora e para com sem_partida, contando só três pedidos", async () => {
    const { c, relogio, pedidos, caixa } = await cenario();
    const args = { conversa: GRUPO, ate_total: 500 };
    assert.equal(sc(await historico(c, args)).em_andamento, true);
    for (let i = 1; i <= 2; i++) {
      await esperarAte(() => pedidos().length === i && relogio.pendentes.includes(30_000), `o pedido ${i}`);
      relogio.avancar(30_000);
    }
    await esperarAte(() => caixa.some((l) => l.includes('"historico_em_lote"') && l.includes('"parou"')), "a parada");
    relogio.avancar(60_000);
    await new Promise((pronto) => setTimeout(pronto, 30));
    assert.equal(pedidos().length, 3);
    const r = await historico(c, args);
    assert.deepEqual([sc(r).parou_porque, sc(r).pedidos_feitos, sc(r).pedidos_de_historico_hoje], ["sem_partida", 3, 3]);
    assert.deepEqual((sc(r).pedidos_sem_partida as Obj[]).map((x) => [x.ancora, x.resultado]), [["agora_de_mim", "silencio"], ["agora_de_outro", "silencio"], ["sem_id", "silencio"]]);
    assert.match(String(sc(r).para_o_claude), /não atendeu pedido sem mensagem de partida/);
    const semPartida = caixa.filter((l) => l.includes("historico_sem_partida"));
    assert.equal(semPartida.length, 3);
    for (const l of semPartida) {
      assert.ok(!l.includes("3EB0") && !l.includes("@g.us") && !l.includes(BETO), l);
      assert.match(l, /"ancora":"(agora_de_mim|agora_de_outro|sem_id)"/);
    }
  });

  it("ate_total em grupo vazio com resposta: o primeiro pedido é sintético, os seguintes com a âncora real", async () => {
    const { c, relogio, pedidos, caixa, responder } = await cenario();
    responder(true);
    await historico(c, { conversa: GRUPO, ate_total: 120 });
    await esperarAte(() => pedidos().length === 1 && relogio.pendentes.includes(30_000), "o primeiro pedido");
    assert.match(String(pedidos()[0]![1].id), ID_DO_CLIENTE);
    const maisAntiga = (await guardadas(GRUPO))[0]!;
    relogio.avancar(30_000);
    await esperarAte(() => pedidos().length === 2, "o segundo pedido");
    assert.equal(pedidos()[1]![1].id, maisAntiga.id, "âncora real");
    await esperarAte(() => relogio.pendentes.includes(30_000), "a espera");
    relogio.avancar(30_000);
    await esperarAte(() => caixa.some((l) => l.includes('"parou"')), "a parada");
    const r = await historico(c, { conversa: GRUPO, ate_total: 120 });
    assert.deepEqual([sc(r).parou_porque, sc(r).ancora_do_ultimo_pedido, (sc(r).pedidos_sem_partida as Obj[]).length], ["alvo_atingido", "real", 1]);
  });

  it("conversa individual sem mensagem e grupo não escolhido continuam recusados, sem pedido", async () => {
    const { c, pedidos } = await cenario();
    const { banco } = await m!.ctx.nucleo();
    banco.apagarMensagem(pn(ANA), "ANCORA-ANA", { de_mim: false, numero: ANA });
    const ind = await historico(c, { conversa: pn(ANA), quantidade: 5 });
    assert.equal(ind.isError, true);
    const indLote = await historico(c, { conversa: pn(ANA), ate_total: 100 });
    assert.equal(indLote.isError, true);
    assert.match(textoDe(ind), /só é tentado em grupo escolhido/);
    assert.match(textoDe(indLote), /só é tentado em grupo escolhido/);
    const nunca = await historico(c, { conversa: "+55 21 98765-0000", quantidade: 5 });
    assert.match(textoDe(nunca), /só é tentado em grupo escolhido/);
    const fora = await historico(c, { conversa: OUTRO_GRUPO, quantidade: 5 });
    assert.equal(fora.isError, true);
    const foraLote = await historico(c, { conversa: OUTRO_GRUPO, ate_total: 100 });
    assert.equal(foraLote.isError, true);
    assert.equal(pedidos().length, 0);
  });
});

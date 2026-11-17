// Medida (não é teste da suíte; 0.15.2): a agenda do celular chegando de uma vez. 4.000 contatos, metade com LID, e 265
// conversas guardadas (30 delas só pelo LID, que mudam para o número). Diz o tempo total e o maior trecho sem devolver o
// controle ao laço, como o medir-pareamento.ts.
//   node --import ./test/setup.ts test/medir-agenda.ts                     # a ressincronização: 2.000 lid-mapping.update
//                                                                          # seguidos (como a Baileys emite, sem buffer)
//                                                                          # e depois um contacts.upsert com os 4.000
//   CAMINHO=historico node --import ./test/setup.ts test/medir-agenda.ts   # os contatos e os pares no histórico do pareamento
//   CAMINHO=baileys node --import ./test/setup.ts test/medir-agenda.ts     # só a parte da Baileys: decifrar um retrato de
//                                                                          # 4.000 contactAction e gerar os eventos
// Pasta temporária, rede bloqueada, socket falso.

import { randomBytes } from "node:crypto";
import { decodeSyncdSnapshot, encodeSyncdPatch, newLTHashState, processSyncAction, proto } from "@whiskeysockets/baileys";
import { assentar, conectar, montar, pn } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const CONTATOS = 4_000;
const CONVERSAS = 265;
const SO_PELO_LID = Number(process.env.SO_PELO_LID ?? 30);

const numero = (i: number) => `55119${String(10_000_000 + i).padStart(8, "0")}`;
const lid = (i: number) => `${700_000_000_000 + i}@lid`;
const comLid = (i: number) => i % 2 === 0;

let maior = 0;
let ultimo = performance.now();
const vigia = setInterval(() => {
  const agora = performance.now();
  maior = Math.max(maior, agora - ultimo);
  ultimo = agora;
}, 1);
const medir = async (f: () => Promise<void>): Promise<{ total_ms: number; maior_trecho_ms: number }> => {
  await new Promise((pronto) => setTimeout(pronto, 20));
  maior = 0;
  const inicio = performance.now();
  ultimo = inicio;
  await f();
  await new Promise((pronto) => setTimeout(pronto, 5));
  return { total_ms: Math.round(performance.now() - inicio), maior_trecho_ms: Math.round(maior) };
};

if (process.env.CAMINHO === "baileys") {
  // O retrato da coleção montado com o codificador da própria Baileys (uma chave de teste), decifrado pelo mesmo caminho
  // do resyncAppState (decodeSyncdSnapshot) e depois os eventos (processSyncAction), como no chats.js:543-546.
  const keyId = randomBytes(6).toString("base64");
  const chave = { keyData: randomBytes(32), fingerprint: { rawId: 1, currentIndex: 1, deviceIndexes: [0] }, timestamp: 0 };
  const getKey = async () => chave as never;
  const records: unknown[] = [];
  let estado = newLTHashState();
  for (let i = 0; i < CONTATOS; i++) {
    const contactAction = { fullName: `Contato ${i}`, ...(comLid(i) ? { lidJid: lid(i) } : {}) };
    const r = await encodeSyncdPatch({ type: "critical_unblock_low", index: ["contact", pn(numero(i))], syncAction: { contactAction }, apiVersion: 2, operation: proto.SyncdMutation.SyncdOperation.SET } as never, keyId, estado, getKey);
    estado = r.state;
    records.push(r.patch.mutations![0]!.record);
  }
  const retrato = { version: { version: estado.version }, records, keyId: { id: Buffer.from(keyId, "base64") }, mac: Buffer.alloc(32) };
  let eventos = 0;
  const ev = { emit: () => eventos++ } as never;
  const decifrar = await medir(async () => {
    const { mutationMap } = await decodeSyncdSnapshot("critical_unblock_low", retrato as never, getKey, undefined, true);
    for (const k in mutationMap) processSyncAction(mutationMap[k]!, ev, undefined as never);
  });
  console.log(JSON.stringify({ caminho: "baileys", contatos: CONTATOS, eventos, ...decifrar }));
  clearInterval(vigia);
  process.exit(0);
}

const m = await montar({ maxMensagens: 5_000 });
const s = await conectar(m);
// As conversas guardadas: as primeiras 265 pessoas da agenda; 30 delas só pelo LID (o número ainda desconhecido).
const base = Date.now() - 86_400_000;
for (let c = 0; c < CONVERSAS; c++) {
  const jid = c < SO_PELO_LID ? lid(c * 2) : pn(numero(c * 2 + 1));
  s.mensagens([msg({ jid, id: `M${c}`, ts: base + c * 1_000, texto: "oi", ...(c % 3 === 0 ? { nome: `Público ${c}` } : {}) })]);
}
await assentar(m);
const { banco } = await m.ctx.nucleo();

const contatos = Array.from({ length: CONTATOS }, (_, i) => ({
  id: pn(numero(i)),
  name: `Contato ${i}`,
  ...(comLid(i) ? { lid: lid(i), phoneNumber: pn(numero(i)) } : {}),
}));
const pares = contatos.filter((_, i) => comLid(i)).map((_, j) => ({ lid: lid(j * 2), pn: pn(numero(j * 2)) }));

const r = await medir(async () => {
  if (process.env.CAMINHO === "historico") {
    s.historico({ contacts: contatos, lidPnMappings: pares });
  } else {
    // A Baileys emite um lid-mapping.update por contato, seguidos e sem buffer (sync-action-utils.js:40-47), e solta o
    // contacts.upsert consolidado depois (event-buffer.js).
    // PARTE=lid ou PARTE=contatos mede só um dos dois.
    if (process.env.PARTE !== "contatos") for (const p of pares) s.emitir("lid-mapping.update", p);
    if (process.env.PARTE !== "lid") s.emitir("contacts.upsert", contatos);
  }
  await assentar(m);
});
const est = banco.estatisticas();
const semNome = banco.conversasIndividuaisSemNome().size;
console.log(JSON.stringify({ caminho: process.env.CAMINHO ?? "ressincronizacao", ...(process.env.PARTE ? { parte: process.env.PARTE } : {}), contatos: CONTATOS, ...r, conversas: est.conversas, sem_nome: semNome, pelo_lid: banco.listarConversas().filter((e) => e.jid.endsWith("@lid")).length }));
clearInterval(vigia);
await m.fechar();

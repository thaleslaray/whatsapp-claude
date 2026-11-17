// 0.9.2: medição do custo do teto de mensagens por conversa (500 x 5.000). Banco em pasta temporária e chave de teste;
// nunca o banco real. Rodar: node --import ./test/setup.ts test/medir-teto.ts
import { mkdtempSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { Busca } from "../src/busca.ts";

const CHAVE = Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex");
const JID = "5511912345678@s.whatsapp.net";
const palavras = "contrato amanhã reunião pizza aluguel condomínio boleto cedo depois mando segue valeu obrigado projeto prazo".split(" ");

function mensagem(i: number, base: number): MensagemGuardada {
  let texto = "";
  const alvo = 20 + ((i * 37) % 181);
  while (texto.length < alvo) texto += `${palavras[(i + texto.length) % palavras.length]} `;
  const m: MensagemGuardada = { id: `ID${String(i).padStart(8, "0")}ABCDEF`, ts: base + i * 7 * 60_000, de_mim: i % 3 === 0, tipo: "texto", texto: texto.slice(0, alvo) };
  if (i % 10 === 0) {
    m.tipo = "imagem";
    m.midia = { baixavel: true, mimetype: "image/jpeg", tamanho: 123456, chave: Buffer.alloc(32, i).toString("base64"), caminho: "/v/t62.7118-24/12345678_123456789012345_1234567890123456789_n.enc?ccb=11-4&oh=01_Q5AaI&oe=67890ABC&_nc_sid=5e03e0", url: "https://mmg.whatsapp.net/v/t62.7118-24/12345678_n.enc?ccb=11-4", sha256: Buffer.alloc(32, 1).toString("base64"), sha256_cifrado: Buffer.alloc(32, 2).toString("base64") };
  }
  return m;
}

const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function medir(n: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wa-medir-"));
  try {
    const banco = new Banco({ dir, chave: CHAVE, maxMensagens: n });
    const base = Date.now() - n * 7 * 60_000 - 3_600_000;
    banco.gravarMensagens(JID, Array.from({ length: n }, (_, i) => mensagem(i, base)));
    const busca = new Busca();
    await busca.buscar(banco, { texto: "contrato", ordem: "relevancia", inicio: 0, limite: 5 });
    const gravar: number[] = [], ler: number[] = [], reindexar: number[] = [];
    for (let k = 0; k < 7; k++) {
      let t = performance.now();
      banco.gravarMensagens(JID, [mensagem(n + k, base)]);
      gravar.push(performance.now() - t);
      t = performance.now();
      banco.lerMensagens(JID);
      ler.push(performance.now() - t);
      t = performance.now();
      await busca.buscar(banco, { texto: "contrato", ordem: "relevancia", inicio: 0, limite: 5 });
      reindexar.push(performance.now() - t);
    }
    // 0.9.2: o lote ao vivo de 300 mensagens novas, uma gravação por mensagem (antes) e uma só (depois).
    const lote = (de: number) => Array.from({ length: 300 }, (_, i) => mensagem(de + i, base));
    let t = performance.now();
    for (const x of lote(n + 100)) banco.gravarMensagens(JID, [x], { contarNaoLidas: true });
    const loteAntes = performance.now() - t;
    t = performance.now();
    banco.gravarEmSequencia(JID, lote(n + 1000).map((x) => ({ novas: [x], opcoes: { contarNaoLidas: true } })));
    const loteDepois = performance.now() - t;
    console.log(`${n}: lote de 300 novas: uma por uma ${loteAntes.toFixed(0)} ms | gravarEmSequencia ${loteDepois.toFixed(0)} ms`);
    const arquivo = join(dir, "conversas", readdirSync(join(dir, "conversas"))[0]!);
    console.log(`${n}: gravar 1 nova ${mediana(gravar).toFixed(1)} ms | lerMensagens ${mediana(ler).toFixed(1)} ms | reindexar+buscar ${mediana(reindexar).toFixed(1)} ms | arquivo ${(statSync(arquivo).size / 1024).toFixed(0)} KB | guardadas ${banco.lerMensagens(JID).length}`);
    busca.fechar();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

await medir(500);
await medir(5000);

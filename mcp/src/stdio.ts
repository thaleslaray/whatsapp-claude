#!/usr/bin/env node
// Entrada do servidor por stdio. stdout é do protocolo: todo log vai para stderr.
// A conexão com o WhatsApp vive só enquanto o Claude Desktop mantém este processo: quando a entrada padrão
// fecha (o app fechou) ou chega SIGTERM/SIGINT, o socket fecha e o lock de dono da conexão é solto. No Windows o
// SIGTERM não chega (o app só fecha a entrada padrão ou mata o processo); a entrada padrão fechada basta, e o lock de
// um processo morto é tomado pelo próximo (lock.ts).
//
// A PRIMEIRA importação é a saída segura (saida-segura.ts): ela cala o console.log/info/debug antes de qualquer
// módulo carregar a Baileys e a libsignal, que escrevem chaves de sessão no console (e o stdout é do protocolo).
//
// 0.7.3: a caixa-preta (caixa-preta.ts) registra a partida, cada saída com o MOTIVO, o código no "exit", os erros
// soltos, o erro de escrita no stdout (EPIPE) e o laço de eventos travado. Só observa: quando e como o processo sai
// continua igual.

import "./saida-segura.ts";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { CaixaPreta, instalarRastroDaSaida } from "./caixa-preta.ts";
import { escolherCofre } from "./cofre.ts";
import { lerConfig, protocoloModerno, semOnDemandReady } from "./config.ts";
import { Contexto } from "./contexto.ts";
import { log } from "./log.ts";
import { declararProntoParaHistoricoSobDemanda } from "./registro-do-aparelho.ts";
import { fabricaDeServidor, NOME_SERVIDOR } from "./servidor.ts";
import { instalarTratadoresDeErro, observarErrosSoltos } from "./saida-segura.ts";
import { midiaDoAutoteste, socketDeAutoteste } from "./socket-de-autoteste.ts";
import { conferirWasm } from "./wasm.ts";

// Erro solto depois da partida vira uma linha limpa no stderr (o processo segue); na partida, sai.
let iniciado = false;
instalarTratadoresDeErro(() => iniciado);

/** EPIPE e afins: o outro lado fechou o cano do stdout. */
const codigoDe = (erro: unknown): string | undefined => {
  const c = (erro as { code?: unknown } | null)?.code;
  return typeof c === "string" ? c : undefined;
};

/** A saída já começou pelo `sair` (o `process.exit` que vier depois é o nosso). */
let saindo = false;

function iniciar(): void {
  const config = lerConfig();
  // 0.7.5: o aparelho se declara pronto para histórico sob demanda (hipótese, registro-do-aparelho.ts). Na partida,
  // antes de qualquer socket da Baileys existir; `WA_SEM_ON_DEMAND_READY=1` desliga.
  const pronto = declararProntoParaHistoricoSobDemanda(semOnDemandReady());
  log(`[${NOME_SERVIDOR}] registro do aparelho: ${pronto ? "declara pronto para histórico sob demanda" : "sem declarar pronto (WA_SEM_ON_DEMAND_READY=1)"}`);
  // 0.7.3: a caixa-preta, na pasta de logs (a do autoteste com WA_LOGS_DIR). Logo depois da config: antes de qualquer
  // coisa que possa travar ou cair.
  const caixa = new CaixaPreta({ dir: config.dirLogs });
  // 0.11.0: o rastro da saída logo depois de a caixa-preta existir (antes, o `exit` só era ouvido depois do cofre e do
  // Contexto: a falha nesse trecho saía sem `saiu`). Também o `process.exit` chamado direto e o laço que esvazia.
  let ctx: Contexto | undefined;
  instalarRastroDaSaida(caixa, { estaSaindo: () => saindo, aoSair: () => ctx?.lock.liberar() });
  caixa.partida();
  void caixa.varrerMortos();
  observarErrosSoltos((tipo, nome, frase, codigo) => caixa.erroSolto(tipo, nome, frase, codigo));
  caixa.vigiarLaco();
  const aoErroDoTransporte = (erro: Error) => {
    log(`[${NOME_SERVIDOR}] ${erro.message}`);
    const codigo = codigoDe(erro);
    if (codigo === "EPIPE" || codigo === "ERR_STREAM_DESTROYED") caixa.erroDeEscrita("stdout", codigo);
  };
  // O cofre automático do sistema (Keychain no Mac, DPAPI no Windows; cofre.ts). Outro sistema: o servidor não sobe.
  const cofre = escolherCofre(config.dirDados);
  // Autoteste (só com a trava de teste, ver config.ts): socket inerte, sem rede, e a conferência do WASM da Baileys.
  ctx = new Contexto({
    config,
    cofre,
    caixaPreta: caixa,
    ...(config.socketDeTeste ? { criarSocket: socketDeAutoteste(config.dirDados), buscarMidia: midiaDoAutoteste(config.dirDados) } : {}),
  });
  if (config.socketDeTeste) {
    const w = conferirWasm();
    log(`[${NOME_SERVIDOR}] autoteste: socket falso; WASM da Baileys: md5 ${w.md5 ? "ok" : "ERRADO"}, hkdf ${w.hkdf ? "ok" : "ERRADO"}`);
  }
  const fabrica = fabricaDeServidor(ctx);
  const contexto = ctx;

  const sair = (codigo: number, motivo: string) => {
    if (saindo) return;
    saindo = true;
    caixa.saindo(motivo);
    const forcar = setTimeout(() => process.exit(codigo), 5_000);
    forcar.unref();
    void contexto.encerrar().finally(() => process.exit(codigo));
  };
  // Último recurso: o `exit` (instalarRastroDaSaida) registra o `saiu` e solta o lock mesmo numa saída abrupta (os dois
  // são síncronos).
  process.on("SIGTERM", () => sair(0, "SIGTERM"));
  process.on("SIGINT", () => sair(0, "SIGINT"));
  // 0.7.3: SIGHUP (terminal ou app que fecha) pelo mesmo caminho do SIGTERM, para deixar rastro.
  process.on("SIGHUP", () => sair(0, "SIGHUP"));
  // 0.11.0: no Windows, Ctrl+Break chega como SIGBREAK (sem tratador, o processo morria sem rastro).
  if (process.platform === "win32") process.on("SIGBREAK", () => sair(0, "SIGBREAK"));
  process.stdin.on("end", () => sair(0, "entrada padrão terminou"));
  process.stdin.on("close", () => sair(0, "entrada padrão fechou"));
  // 0.11.0: o cano da entrada quebrou (EIO, ECONNRESET): o cliente não fala mais com esta cópia. Antes só virava linha
  // no stderr e a cópia ficava no ar, segurando a conexão sem cliente.
  process.stdin.on("error", () => sair(0, "entrada padrão falhou"));

  const moderno = protocoloModerno();
  if (moderno) {
    const transporte = new StdioServerTransport();
    serveStdio(fabrica, { onerror: aoErroDoTransporte, transport: transporte });
    // 0.11.0: no protocolo moderno, o transporte que fecha (stdout quebrado: EPIPE) não saía, e a cópia ficava no ar sem
    // cliente, segurando a conexão. O `serveStdio` põe o `onclose` dele no transporte; este embrulha e sai como no de 2025.
    const doServe = transporte.onclose;
    transporte.onclose = () => {
      doServe?.();
      sair(0, "transporte fechou");
    };
  } else {
    // Era de 2025 (igual ao Instagram): um servidor só, ligado direto ao transporte.
    const transporte = new StdioServerTransport();
    transporte.onerror = aoErroDoTransporte;
    transporte.onclose = () => sair(0, "transporte fechou");
    void fabrica().connect(transporte);
  }
  log(`[${NOME_SERVIDOR}] no ar por stdio (protocolo ${moderno ? "2026 e 2025" : "2025"})`);
  void contexto.partida().catch((erro) => log(`[${NOME_SERVIDOR}] a conexão não partiu: ${erro instanceof Error ? erro.message : String(erro)}`));
}

try {
  iniciar();
  iniciado = true;
} catch (erro) {
  log(`[${NOME_SERVIDOR}] não iniciou: ${erro instanceof Error ? erro.message : String(erro)}`);
  process.exit(1);
}

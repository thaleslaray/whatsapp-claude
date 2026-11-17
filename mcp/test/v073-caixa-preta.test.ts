// 0.7.3: caixa-preta do processo (caixa-preta.ts). A cópia dona saiu sozinha sem deixar rastro; aqui se prova que
// cada saída, exceção, promessa rejeitada, laço travado, repasse que falhou e troca de papel vira uma linha, que a morte
// sem aviso é descoberta pela próxima cópia (pelo arquivo "vivo"), que o wa_estado mostra a última queda, e que nada
// de conteúdo (jid, número, nome, texto, ids, argumentos, caminhos) entra na caixa-preta nem nos arquivos "vivo".
// Sem rede (test/setup.ts) e com pastas temporárias.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import { getMediaKeys, type WAMessage } from "@whiskeysockets/baileys";
import { ARQUIVO_DA_CAIXA_PRETA, CaixaPreta, ETAPAS, nomeDoVivo, type RelogioDaVigia } from "../src/caixa-preta.ts";
import { chamarPeloCanal, ErroDoCanal } from "../src/canal.ts";
import { FRASE_DO_LEITOR } from "../src/contexto.ts";
import { FRASE_DA_QUEDA } from "../src/ferramentas/leitura.ts";
import { inicioDesteProcesso } from "../src/lock.ts";
import type { MotorDeTranscricao, OpcoesDaTranscricao } from "../src/transcricao.ts";
import { VERSAO_SERVIDOR } from "../src/versao.ts";
import { ANA, assentar, BETO, chamar, chamarCru, conectar, conectarCliente, DONO, GRUPO, montar, pn, textoDe, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const pastas: string[] = [];
const montagens: Montagem[] = [];
const fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.splice(0).reverse()) await f();
  for (const mm of montagens.splice(0).reverse()) await mm.fechar();
  for (const p of pastas.splice(0)) rmSync(p, { recursive: true, force: true });
});

function pasta(): string {
  const p = mkdtempSync(join(tmpdir(), "wa-caixa-"));
  pastas.push(p);
  return p;
}
const linhasDe = (dir: string): Array<Record<string, unknown>> => {
  const caminho = join(dir, ARQUIVO_DA_CAIXA_PRETA);
  if (!existsSync(caminho)) return [];
  return readFileSync(caminho, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
};
const eventos = (dir: string, evento: string) => linhasDe(dir).filter((l) => l.evento === evento);
const nunca = () => new Promise<never>(() => {});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: toda saída deixa rastro (o servidor de verdade, por stdio)", () => {
  /** Sobe src/stdio.ts com a trava de teste (socket inerte, cofre em memória, pastas temporárias) e sem rede. */
  function subir(): { filho: ReturnType<typeof spawn>; logs: string; pronto: Promise<void>; saiu: Promise<number | null> } {
    const base = pasta();
    const logs = join(base, "logs");
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("WA_")) env[k] = v;
    Object.assign(env, { HOME: base, WA_TESTE_CHAVE: randomBytes(32).toString("hex"), WA_DADOS_DIR: join(base, "dados"), WA_LOGS_DIR: logs, WA_TESTE_SOCKET: "falso" });
    const filho = spawn(process.execPath, ["--import", pathToFileURL(join(RAIZ, "test", "setup.ts")).href, join(RAIZ, "src", "stdio.ts")], { env, stdio: ["pipe", "pipe", "pipe"] });
    let erro = "";
    const pronto = new Promise<void>((ok, falha) => {
      const relogio = setTimeout(() => falha(new Error(`o servidor não subiu:\n${erro}`)), 20_000);
      filho.stderr!.on("data", (parte) => {
        erro += parte;
        if (erro.includes("papel_definido")) {
          clearTimeout(relogio);
          ok();
        }
      });
    });
    const saiu = new Promise<number | null>((ok) => filho.on("exit", (codigo) => ok(codigo)));
    const matar = setTimeout(() => filho.kill("SIGKILL"), 30_000);
    void saiu.then(() => clearTimeout(matar));
    return { filho, logs, pronto, saiu };
  }

  it("SIGTERM, SIGINT, SIGHUP, entrada padrão terminada e stdout quebrado (EPIPE): saindo com o motivo, saiu com o código, sem arquivo vivo", async () => {
    const casos: Array<[string, (f: ReturnType<typeof spawn>) => void]> = [
      ["SIGTERM", (f) => f.kill("SIGTERM")],
      ["SIGINT", (f) => f.kill("SIGINT")],
      ["SIGHUP", (f) => f.kill("SIGHUP")],
      ["entrada padrão terminou", (f) => f.stdin!.end()],
      [
        "transporte fechou",
        (f) => {
          // O Claude Desktop fechou a ponta de leitura do stdout: a resposta seguinte dá EPIPE e o transporte fecha.
          f.stdout!.destroy();
          f.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } })}\n`);
        },
      ],
    ];
    await Promise.all(
      casos.map(async ([motivo, agir]) => {
        const s = subir();
        await s.pronto;
        agir(s.filho);
        const codigo = await s.saiu;
        assert.equal(codigo, 0, motivo);
        const saindo = eventos(s.logs, "saindo");
        assert.equal(saindo.length, 1, `${motivo}: ${JSON.stringify(linhasDe(s.logs))}`);
        assert.equal(saindo[0]!.motivo, motivo);
        assert.equal(typeof saindo[0]!.no_ar_ha_s, "number");
        assert.equal(saindo[0]!.em_andamento, 0);
        const saiu = eventos(s.logs, "saiu");
        assert.equal(saiu.length, 1, motivo);
        assert.equal(saiu[0]!.codigo, 0);
        assert.equal(saiu[0]!.versao, VERSAO_SERVIDOR);
        assert.equal(saiu[0]!.papel, "dono");
        assert.equal(eventos(s.logs, "partida").length, 1);
        assert.deepEqual(readdirSync(s.logs).filter((n) => n.startsWith("vivo-")), [], `${motivo}: o arquivo vivo ficou`);
        if (motivo === "transporte fechou") {
          const escrita = eventos(s.logs, "erro_de_escrita");
          assert.equal(escrita.length, 1);
          assert.deepEqual({ onde: escrita[0]!.onde, codigo_do_erro: escrita[0]!.codigo_do_erro }, { onde: "stdout", codigo_do_erro: "EPIPE" });
        }
      }),
    );
  });

  it("cada motivo (inclusive entrada padrão fechada) vira saindo; motivo desconhecido vira 'outro'; uma vez só", () => {
    for (const motivo of ["SIGTERM", "SIGINT", "SIGHUP", "entrada padrão terminou", "entrada padrão fechou", "transporte fechou", "inventado"]) {
      const dir = pasta();
      const c = new CaixaPreta({ dir, pid: 7001, saida: () => {} });
      c.partida();
      c.saindo(motivo);
      c.saindo("SIGTERM");
      c.saiu(0);
      const s = eventos(dir, "saindo");
      assert.equal(s.length, 1);
      assert.equal(s[0]!.motivo, motivo === "inventado" ? "outro" : motivo);
      assert.equal(eventos(dir, "saiu")[0]!.codigo, 0);
      assert.ok(!existsSync(join(dir, nomeDoVivo(7001))));
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: exceção e promessa rejeitada soltas", () => {
  it("viram linha com o NOME do erro e a frase limpa; EPIPE vira erro_de_escrita uma vez; o processo segue", () => {
    const dir = pasta();
    const codigo = `
      const { instalarTratadoresDeErro, observarErrosSoltos } = await import(${JSON.stringify(join(RAIZ, "src", "saida-segura.ts"))});
      const { CaixaPreta } = await import(${JSON.stringify(join(RAIZ, "src", "caixa-preta.ts"))});
      const c = new CaixaPreta({ dir: ${JSON.stringify(dir)}, saida: () => {} });
      instalarTratadoresDeErro(() => true);
      observarErrosSoltos((t, n, f, cod) => c.erroSolto(t, n, f, cod));
      class ErroDoMotor extends Error { name = "ErroDoMotor"; }
      Promise.reject(new TypeError("falhou para ${pn(ANA)} e ${ANA}\\nsegunda linha"));
      setTimeout(() => { throw new ErroDoMotor("estourou no motor"); }, 5);
      setTimeout(() => { throw new ErroDoMotor("estourou no motor"); }, 8);
      setTimeout(() => { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; }, 12);
      setTimeout(() => { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; }, 16);
      setTimeout(() => process.stdout.write("vivo"), 60);
    `;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", codigo], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "vivo");
    const erros = eventos(dir, "erro_solto");
    assert.equal(erros.length, 2, JSON.stringify(erros));
    const promessa = erros.find((e) => e.tipo === "promessa_rejeitada")!;
    assert.equal(promessa.nome, "TypeError");
    assert.match(String(promessa.frase), /falhou para ‹jid› e ‹número›/);
    const excecao = erros.find((e) => e.tipo === "excecao")!;
    assert.equal(excecao.nome, "ErroDoMotor");
    assert.equal(excecao.frase, "estourou no motor");
    assert.equal(eventos(dir, "erro_de_escrita").length, 1);
    const bruto = readFileSync(join(dir, ARQUIVO_DA_CAIXA_PRETA), "utf8");
    assert.ok(!bruto.includes(ANA) && !bruto.includes("segunda linha") && !bruto.includes("@s.whatsapp.net"));
  });

  it("a mesma exceção não é registrada de novo antes de 60 s (protege o histórico); frase cortada em 200", () => {
    const dir = pasta();
    let agora = 1_000_000;
    const c = new CaixaPreta({ dir, pid: 7002, agora: () => agora, saida: () => {} });
    for (let i = 0; i < 5; i++) c.erroSolto("excecao", "Error", "sempre igual");
    agora += 61_000;
    c.erroSolto("excecao", "Error", "sempre igual");
    c.erroSolto("excecao", "Nome inválido!", "x".repeat(500));
    const erros = eventos(dir, "erro_solto");
    assert.equal(erros.length, 3);
    assert.equal(erros[1]!.repeticoes_nao_registradas, 4);
    assert.equal(erros[2]!.nome, "Error");
    assert.equal(String(erros[2]!.frase).length, 200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: o arquivo vivo e a morte sem aviso", () => {
  it("pid morto vira morreu_sem_aviso com a ferramenta e a etapa em andamento, e o arquivo some; pid vivo fica em paz", async () => {
    const dir = pasta();
    const morto = new CaixaPreta({ dir, pid: 424242, saida: () => {} });
    morto.partida();
    morto.definirPapel("dono");
    void morto.acompanharFerramenta("wa_transcrever", nunca);
    void morto.etapa(ETAPAS.transcrever, nunca);
    const vivo = JSON.parse(readFileSync(join(dir, nomeDoVivo(424242)), "utf8")) as Record<string, unknown>;
    assert.deepEqual(vivo.ferramentas, { wa_transcrever: 1 });
    assert.deepEqual(vivo.etapas, ["transcrevendo"]);
    assert.equal(vivo.papel, "dono");
    // Outro processo, vivo, com o seu arquivo: fica em paz (mesma hora de início).
    const outro = new CaixaPreta({ dir, pid: 515151, saida: () => {} });
    outro.partida();

    const nova = new CaixaPreta({ dir, pid: 616161, saida: () => {}, processoVivo: (pid) => pid !== 424242, inicioDe: async () => outro.inicio });
    nova.partida();
    assert.equal(await nova.varrerMortos(), 1);
    const m = eventos(dir, "morreu_sem_aviso");
    assert.equal(m.length, 1);
    const d = m[0]!.morto as Record<string, unknown>;
    assert.equal(d.pid, 424242);
    assert.equal(d.papel, "dono");
    assert.equal(d.versao, VERSAO_SERVIDOR);
    assert.deepEqual(d.ferramentas_em_andamento, { wa_transcrever: 1 });
    assert.deepEqual(d.etapas_em_andamento, ["transcrevendo"]);
    assert.equal(typeof d.no_ar_pelo_menos_s, "number");
    assert.equal(m[0]!.pid, 616161, "quem registra é a cópia nova");
    assert.ok(!existsSync(join(dir, nomeDoVivo(424242))), "o arquivo do morto foi apagado");
    assert.ok(existsSync(join(dir, nomeDoVivo(515151))), "o do vivo ficou");
    // Uma segunda varredura não registra de novo.
    assert.equal(await nova.varrerMortos(), 0);
  });

  it("pid vivo mas reaproveitado (outra hora de início) também é morto; ilegível é apagado; o próprio pid reaproveitado é registrado na partida", async () => {
    const dir = pasta();
    const velho = new CaixaPreta({ dir, pid: 717171, inicio: Date.now() - 3_600_000, saida: () => {} });
    velho.partida();
    writeFileSync(join(dir, nomeDoVivo(818181)), "{lixo");
    const nova = new CaixaPreta({ dir, pid: 919191, saida: () => {}, processoVivo: () => true, inicioDe: async () => Date.now() });
    nova.partida();
    assert.equal(await nova.varrerMortos(), 1);
    assert.ok(!existsSync(join(dir, nomeDoVivo(818181))), "ilegível apagado");
    assert.equal(eventos(dir, "morreu_sem_aviso").length, 1);
    // O próprio pid: um arquivo vivo de outro processo com o MESMO pid (que só pode estar morto).
    const mesmoPid = new CaixaPreta({ dir, pid: 717171, saida: () => {} });
    const antigo = new CaixaPreta({ dir, pid: 717171, inicio: Date.now() - 7_200_000, saida: () => {} });
    antigo.partida();
    mesmoPid.partida();
    assert.equal(eventos(dir, "morreu_sem_aviso").length, 2);
  });

  it("o arquivo vivo muda só quando algo muda e acompanha o começo e o fim das ferramentas", async () => {
    const dir = pasta();
    const c = new CaixaPreta({ dir, pid: 7003, saida: () => {} });
    c.partida();
    const ler = () => JSON.parse(readFileSync(join(dir, nomeDoVivo(7003)), "utf8")) as Record<string, unknown>;
    let soltar!: () => void;
    const p = c.acompanharFerramenta("wa_estado", () => new Promise<number>((ok) => (soltar = () => ok(42))));
    assert.deepEqual(ler().ferramentas, { wa_estado: 1 });
    assert.equal(ler().em_andamento, 1);
    soltar();
    assert.equal(await p, 42, "o resultado passa como veio");
    assert.deepEqual(ler().ferramentas, {});
    await assert.rejects(c.acompanharFerramenta("wa_ler_conversa", async () => { throw new Error("o erro passa como veio"); }), /o erro passa como veio/);
    assert.equal(ler().em_andamento, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: teto de tamanho e falha de escrita", () => {
  it("passou do teto: fica a metade mais recente, linha inteira", () => {
    const dir = pasta();
    const c = new CaixaPreta({ dir, pid: 7004, tetoBytes: 4_000, saida: () => {} });
    for (let i = 0; i < 200; i++) c.registrar("teste", { n: i });
    const tamanho = statSync(join(dir, ARQUIVO_DA_CAIXA_PRETA)).size;
    assert.ok(tamanho <= 4_000 + 200, `tamanho ${tamanho}`);
    const l = linhasDe(dir);
    assert.equal(l.at(-1)!.n, 199);
    assert.ok((l[0]!.n as number) > 100, "as antigas saíram");
  });

  it("pasta impossível e stderr quebrado não derrubam nada", async () => {
    const base = pasta();
    const arquivo = join(base, "nao-e-pasta");
    writeFileSync(arquivo, "x");
    const c = new CaixaPreta({ dir: arquivo, pid: 7005, saida: () => { throw new Error("stderr fechado"); } });
    c.partida();
    c.definirPapel("leitor");
    c.registrar("teste");
    c.repasseFalhou("wa_responder", "tempo_esgotado_no_aperto");
    c.erroSolto("excecao", "Error", "x");
    assert.equal(await c.acompanharFerramenta("wa_estado", async () => 42), 42);
    assert.equal(await c.etapa(ETAPAS.decodificar, async () => "ok"), "ok");
    assert.equal(await c.varrerMortos(), 0);
    assert.equal(c.ultimaQueda(), null);
    c.saindo("SIGTERM");
    c.saiu(0);
    // stderr quebrado com pasta boa: o arquivo recebe a linha mesmo assim.
    const dir = pasta();
    const d = new CaixaPreta({ dir, pid: 7006, saida: () => { throw new Error("EPIPE"); } });
    d.registrar("teste");
    assert.equal(eventos(dir, "teste").length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
class RelogioFalsoDaVigia implements RelogioDaVigia {
  agoraMs = 1_000_000;
  f: (() => void) | undefined;
  agora() {
    return this.agoraMs;
  }
  setInterval(f: () => void) {
    this.f = f;
    return { unref() {} };
  }
  clearInterval() {
    this.f = undefined;
  }
  tique(ms: number) {
    this.agoraMs += ms;
    this.f?.();
  }
}

describe("0.7.3: laço de eventos travado", () => {
  it("atraso acima de 2 s registra com a duração e o que esteve em andamento; no máximo um a cada 10 s; contador total", async () => {
    const dir = pasta();
    const c = new CaixaPreta({ dir, pid: 7007, saida: () => {} });
    const r = new RelogioFalsoDaVigia();
    const parar = c.vigiarLaco({ relogio: r });
    r.tique(1_000);
    assert.equal(c.lacoTravadoVezes, 0);
    // Uma etapa síncrona e pesada que já acabou quando o tique roda: aparece mesmo assim.
    await c.etapa(ETAPAS.decodificar, async () => {});
    r.tique(5_000);
    assert.equal(c.lacoTravadoVezes, 1);
    let t = eventos(dir, "laco_travado");
    assert.equal(t.length, 1);
    assert.equal(t[0]!.atraso_ms, 4_000);
    assert.deepEqual(t[0]!.fazendo, ["decodificando o áudio"]);
    r.tique(4_000); // trava de novo, 4 s depois do registro: conta, não registra
    assert.equal(c.lacoTravadoVezes, 2);
    assert.equal(eventos(dir, "laco_travado").length, 1);
    r.tique(1_000);
    r.tique(7_000);
    t = eventos(dir, "laco_travado");
    assert.equal(t.length, 2);
    assert.equal(t[1]!.vezes, 3);
    assert.deepEqual(t[1]!.fazendo, []);
    parar();
    assert.equal(r.f, undefined);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: repasse que falhou e papel que mudou", () => {
  it("o canal diz o TIPO da falha: canal ausente, tempo esgotado no aperto de mão, dono fechou", async () => {
    const base = pasta();
    const chave = randomBytes(32);
    const pedido = { ferramenta: "wa_estado", argumentos: {}, temTela: false };
    const tipo = async (endereco: string, limites = {}) => {
      try {
        await chamarPeloCanal({ endereco, chave, pedido, limites });
        return "sem erro";
      } catch (erro) {
        assert.ok(erro instanceof ErroDoCanal);
        return erro.tipo;
      }
    };
    assert.equal(await tipo(join(base, "nao-existe.sock")), "canal_ausente");
    const mudo = net.createServer(() => {});
    const fechaLogo = net.createServer((s) => s.destroy());
    await new Promise<void>((ok) => mudo.listen(join(base, "mudo.sock"), ok));
    await new Promise<void>((ok) => fechaLogo.listen(join(base, "fecha.sock"), ok));
    try {
      assert.equal(await tipo(join(base, "mudo.sock"), { apertoMs: 50 }), "tempo_esgotado_no_aperto");
      assert.equal(await tipo(join(base, "fecha.sock")), "dono_fechou");
    } finally {
      await new Promise<void>((ok) => mudo.close(() => ok()));
      await new Promise<void>((ok) => fechaLogo.close(() => ok()));
    }
  });

  it("leitor: repasse_falhou com a ferramenta e o tipo (sem endereço); leitor que vira dono: papel_mudou", async () => {
    const logs = pasta();
    const dono = await montar({ caixaPreta: new CaixaPreta({ dir: logs, pid: 71001, saida: () => {} }) });
    montagens.push(dono);
    await dono.ctx.partida();
    const leitor = await montar({ dir: dono.dir, pareada: false, intervaloDoLockMs: 50, caixaPreta: new CaixaPreta({ dir: logs, pid: 71002, saida: () => {} }) });
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    const { cliente, fechar } = await conectarCliente(leitor.ctx);
    fechamentos.push(async () => {
      await fechar();
      await leitor.ctx.encerrar();
    });
    // O canal do dono passa a apontar para um "dono" que fecha a conexão na hora.
    const caminhoDoLock = join(dono.config.dirDados, "conexao.lock");
    const lock = JSON.parse(readFileSync(caminhoDoLock, "utf8")) as Record<string, unknown>;
    const falso = join(logs, "dono-falso.sock");
    const servidor = net.createServer((s) => s.destroy());
    await new Promise<void>((ok) => servidor.listen(falso, ok));
    fechamentos.push(() => new Promise<void>((ok) => servidor.close(() => ok())));
    writeFileSync(caminhoDoLock, JSON.stringify({ ...lock, canal: falso }));
    const r = await chamarCru(cliente, "wa_responder", { conversa: ANA, texto: "oi" });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), new RegExp(FRASE_DO_LEITOR.slice(0, 30)));
    const falhas = eventos(logs, "repasse_falhou");
    assert.equal(falhas.length, 1);
    assert.deepEqual({ ferramenta: falhas[0]!.ferramenta, tipo: falhas[0]!.tipo, papel: falhas[0]!.papel, pid: falhas[0]!.pid }, { ferramenta: "wa_responder", tipo: "dono_fechou", papel: "leitor", pid: 71002 });
    assert.ok(!readFileSync(join(logs, ARQUIVO_DA_CAIXA_PRETA), "utf8").includes("dono-falso"), "o endereço do canal não entra");
    // Lock sem canal (dono de versão antiga, ou saindo): canal_ausente.
    writeFileSync(caminhoDoLock, JSON.stringify({ ...lock, canal: undefined }));
    await chamarCru(cliente, "wa_responder", { conversa: ANA, texto: "oi" });
    assert.equal(eventos(logs, "repasse_falhou").at(-1)!.tipo, "canal_ausente");
    // O dono sai e solta o lock: o leitor vira dono.
    writeFileSync(caminhoDoLock, JSON.stringify(lock));
    await dono.ctx.encerrar();
    for (let i = 0; i < 100 && (leitor.ctx.papel as string) !== "dono_da_conexao"; i++) await new Promise((p) => setTimeout(p, 20));
    assert.equal(leitor.ctx.papel as string, "dono_da_conexao");
    const mudou = eventos(logs, "papel_mudou");
    assert.equal(mudou.length, 1);
    assert.deepEqual({ de: mudou[0]!.de, para: mudou[0]!.para, pid: mudou[0]!.pid }, { de: "leitor", para: "dono", pid: 71002 });
    assert.deepEqual(eventos(logs, "papel_definido").map((l) => [l.pid, l.papel]), [[71001, "dono"], [71002, "leitor"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("0.7.3: wa_estado mostra o processo e a última queda", () => {
  it("processo.ultima_queda traz como, papel, versão e o que fazia (sem pid); queda das últimas 24 h vira uma frase", async () => {
    const logs = pasta();
    const agora = Date.now();
    writeFileSync(
      join(logs, nomeDoVivo(999991)),
      JSON.stringify({ pid: 999991, versao: "0.7.2", inicio: agora - 60_000, papel: "dono", ferramentas: { wa_transcrever: 1 }, em_andamento: 1, etapas: ["transcrevendo"], mudou_em: agora - 1_000 }),
    );
    const cp = new CaixaPreta({ dir: logs, pid: 71003, saida: () => {}, processoVivo: (pid) => pid !== 999991 });
    cp.partida();
    assert.equal(await cp.varrerMortos(), 1);
    const m = await montar({ caixaPreta: cp });
    montagens.push(m);
    await conectar(m);
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fechamentos.push(fechar);
    const e = await chamar(cliente, "wa_estado");
    const p = e.processo as Record<string, unknown>;
    assert.equal(p.papel, "dono");
    assert.equal(p.laco_travado_vezes, 0);
    assert.equal(typeof p.no_ar_ha_s, "number");
    const q = p.ultima_queda as Record<string, unknown>;
    assert.match(String(q.como), /morreu sem aviso/);
    assert.deepEqual({ papel: q.papel, versao: q.versao, fazendo: q.fazendo }, { papel: "dono", versao: "0.7.2", fazendo: ["wa_transcrever", "transcrevendo"] });
    assert.ok(!Number.isNaN(Date.parse(String(q.quando))));
    assert.ok(!JSON.stringify(p).includes("999991") && !JSON.stringify(p).includes("pid") && !JSON.stringify(p).includes(logs), "sem pid e sem caminho");
    assert.ok(String(e.para_o_claude).includes(FRASE_DA_QUEDA));
    // A mesma queda vista 25 h depois: fica no processo, sem a frase.
    const depois = new CaixaPreta({ dir: logs, pid: 71004, agora: () => agora + 25 * 3_600_000, saida: () => {} });
    assert.equal(depois.quedaRecente(depois.ultimaQueda()), false);
  });

  it("saída com código de erro e saída com trabalho em andamento também são quedas; saída limpa não é", () => {
    const logs = pasta();
    const c = new CaixaPreta({ dir: logs, pid: 7008, saida: () => {} });
    c.saindo("SIGTERM");
    c.saiu(0);
    assert.equal(c.ultimaQueda(), null, "saída limpa e sem trabalho");
    const d = new CaixaPreta({ dir: logs, pid: 7009, saida: () => {} });
    void d.acompanharFerramenta("wa_transcrever", nunca);
    d.saindo("entrada padrão terminou");
    assert.deepEqual({ ...d.ultimaQueda(), quando: "" }, { quando: "", como: "saiu (entrada padrão terminou) com trabalho em andamento", papel: "indefinido", versao: VERSAO_SERVIDOR, fazendo: ["wa_transcrever"] });
    const e = new CaixaPreta({ dir: logs, pid: 7010, saida: () => {} });
    e.saiu(1);
    assert.equal(e.ultimaQueda()?.como, "saiu com código 1");
  });

  it("sem caixa-preta no disco (o padrão dos testes): ultima_queda null e nenhuma frase", async () => {
    const m = await montar({ pareada: false });
    montagens.push(m);
    await m.ctx.partida();
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fechamentos.push(fechar);
    const e = await chamar(cliente, "wa_estado");
    assert.equal((e.processo as Record<string, unknown>).ultima_queda, null);
    assert.ok(!String(e.para_o_claude).includes(FRASE_DA_QUEDA));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Vazamento: um cenário com conversas, nomes, números, textos, ids e um áudio transcrito; nada disso pode aparecer na
// caixa-preta nem nos arquivos vivo (inclusive no meio de uma transcrição).

async function cifrarAudio(plano: Buffer) {
  const mediaKey = randomBytes(32);
  const k = await getMediaKeys(mediaKey, "audio");
  const c = createCipheriv("aes-256-cbc", k.cipherKey!, k.iv!);
  const enc = Buffer.concat([c.update(plano), c.final()]);
  const mac = createHmac("sha256", k.macKey!).update(k.iv!).update(enc).digest().subarray(0, 10);
  const arquivo = Buffer.concat([enc, mac]);
  return { mediaKey, arquivo, fileSha256: createHash("sha256").update(plano).digest(), fileEncSha256: createHash("sha256").update(arquivo).digest() };
}

class MotorSeguro implements MotorDeTranscricao {
  segurar: Promise<void> | undefined;
  async transcrever(_pcm: Int16Array, _o: OpcoesDaTranscricao): Promise<string> {
    if (this.segurar) await this.segurar;
    return "Juliana falou do orçamento secreto do condomínio";
  }
  async liberar(): Promise<void> {}
}

describe("0.7.3: nada de conteúdo na caixa-preta nem nos arquivos vivo", () => {
  it("conversas, nomes, números, textos, ids, argumentos e caminhos ficam de fora", async () => {
    const logs = pasta();
    const cp = new CaixaPreta({ dir: logs, pid: 72001, saida: () => {} });
    cp.partida();
    const CONTEUDO_DO_MODELO = Buffer.from("modelo-de-teste-".repeat(64));
    const modelo = { url: "https://huggingface.co/x/modelo.bin", tamanho: CONTEUDO_DO_MODELO.length, sha256: createHash("sha256").update(CONTEUDO_DO_MODELO).digest("hex"), nome: "modelo-de-teste.bin" };
    const plano = Buffer.alloc(64);
    plano.write("OggS", 0, "latin1");
    plano.write("OpusHead", 28, "latin1");
    const cifrado = await cifrarAudio(plano);
    const caminhoDaMidia = "/v/t62.7117-24/CAMINHOSECRETO.enc?ccb=11-4";
    const motor = new MotorSeguro();
    let soltar!: () => void;
    motor.segurar = new Promise<void>((ok) => (soltar = ok));
    const m = await montar({
      caixaPreta: cp,
      buscarMidia: async () => new Response(new Uint8Array(cifrado.arquivo), { status: 200 }),
      modeloEsperado: modelo,
      decodificarAudio: async () => new Int16Array(16_000 * 3),
      carregarMotor: async () => motor,
      esperaDaTranscricaoMs: 50,
      esperaDoHistoricoMs: 30,
    });
    montagens.push(m);
    mkdirSync(join(m.config.dirDados, "modelos"), { recursive: true });
    writeFileSync(join(m.config.dirDados, "modelos", modelo.nome), CONTEUDO_DO_MODELO);
    const s = await conectar(m, { grupos: { [GRUPO]: { id: GRUPO, subject: "Família Secreta", size: 3, participants: [] } } });
    await assentar(m);
    (await m.ctx.nucleo()).banco.permitirGrupo(GRUPO);
    const audio: WAMessage = msg({
      jid: pn(ANA),
      id: "AUDIOSECRETO01",
      nome: "Ana Secreta",
      message: { audioMessage: { mimetype: "audio/ogg; codecs=opus", mediaKey: cifrado.mediaKey, directPath: caminhoDaMidia, url: `https://mmg.whatsapp.net${caminhoDaMidia}`, fileSha256: cifrado.fileSha256, fileEncSha256: cifrado.fileEncSha256, fileLength: plano.length, seconds: 3, ptt: true } },
    });
    s.mensagens([
      msg({ jid: pn(ANA), id: "MSGSECRETA0001", texto: "texto confidencial da Ana", nome: "Ana Secreta" }),
      msg({ jid: pn(BETO), id: "MSGSECRETA0002", texto: "texto confidencial do Beto", nome: "Beto Secreto" }),
      msg({ jid: GRUPO, id: "MSGSECRETA0003", texto: "texto confidencial do grupo", participante: pn(BETO) }),
      audio,
    ]);
    await assentar(m);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fechamentos.push(fechar);

    const lista = await chamar(cliente, "wa_listar_conversas");
    const ids = (lista.conversas as Array<{ id: string }>).map((c) => c.id);
    assert.ok(ids.length >= 3);
    await chamar(cliente, "wa_estado");
    await chamar(cliente, "wa_ler_conversa", { conversa: ids[0] });
    await chamar(cliente, "wa_ler_conversa", { conversa: "Família Secreta" });
    await chamar(cliente, "wa_buscar", { texto: "confidencial" });
    await chamarCru(cliente, "wa_responder", { conversa: ANA, texto: "resposta sigilosa para a Ana" });
    await chamarCru(cliente, "wa_ler_conversa", { conversa: pn(BETO) });
    await chamarCru(cliente, "wa_buscar_historico", { conversa: ANA, quantidade: 5 });
    // Transcrição segurada no meio: o arquivo vivo mostra a ferramenta e a etapa, e nada mais.
    const t1 = await chamar(cliente, "wa_transcrever", { conversa: ANA, mensagem: "AUDIOSECRETO01" });
    assert.equal(t1.situacao, "em_andamento", JSON.stringify(t1));
    const vivoNoMeio = readFileSync(join(logs, nomeDoVivo(72001)), "utf8");
    assert.deepEqual(JSON.parse(vivoNoMeio).etapas, ["transcrevendo"]);
    soltar();
    let t2: Record<string, unknown> = {};
    for (let i = 0; i < 50 && t2.situacao !== "pronta"; i++) t2 = await chamar(cliente, "wa_transcrever", { conversa: ANA, mensagem: "AUDIOSECRETO01" });
    assert.equal(t2.situacao, "pronta");
    cp.erroSolto("excecao", "Error", `falhou para ${pn(ANA)} (${ANA}) e ${DONO}`);
    cp.repasseFalhou("wa_responder", "tempo_esgotado_no_aperto");
    cp.saindo("SIGTERM");
    const vivoNoFim = readFileSync(join(logs, nomeDoVivo(72001)), "utf8");
    cp.saiu(0);

    const caixa = readFileSync(join(logs, ARQUIVO_DA_CAIXA_PRETA), "utf8");
    for (const ev of ["partida", "papel_definido", "erro_solto", "repasse_falhou", "saindo", "saiu"]) assert.ok(caixa.includes(`"evento":"${ev}"`), `sem ${ev}`);
    assert.match(String(eventos(logs, "erro_solto")[0]!.frase), /falhou para ‹jid› \(‹número›\) e ‹número›/);
    const proibidos = [
      ANA, BETO, DONO, ANA.slice(-8), "@s.whatsapp.net", "@lid", "@g.us", GRUPO.split("@")[0]!,
      "Ana Secreta", "Beto Secreto", "Família Secreta", "Ana", "Beto",
      "confidencial", "sigilosa", "Juliana", "orçamento", "condomínio",
      "MSGSECRETA", "AUDIOSECRETO01", "CAMINHOSECRETO", ...ids,
      m.dir, logs, "modelo-de-teste.bin", CONTEUDO_DO_MODELO.subarray(0, 16).toString(),
    ];
    for (const [onde, texto] of [["caixa-preta", caixa], ["vivo no meio", vivoNoMeio], ["vivo no fim", vivoNoFim]] as const) {
      for (const p of proibidos) assert.ok(!texto.includes(p), `${onde} traz ${p}: ${texto.slice(0, 300)}`);
    }
  });
});

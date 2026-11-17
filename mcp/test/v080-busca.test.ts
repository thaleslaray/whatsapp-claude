// 0.8.0: busca com índice em memória (busca.ts). O motor é testado na partida (fts5 ou varredura), o índice acompanha
// os arquivos pelo carimbo (inclusive o que outro processo mudou), a consulta não deixa a sintaxe do FTS5 vazar, e
// nada vai para o disco nem para log, registro ou caixa-preta. Rede bloqueada, socket falso, como os outros testes.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Banco, type MensagemGuardada } from "../src/banco.ts";
import { Busca, expressaoDoIndice, expressaoDoPedaco, testarMotor, termosDe } from "../src/busca.ts";
import { CaixaPreta } from "../src/caixa-preta.ts";
import { CofreEmMemoria } from "../src/cofre.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { ANA, BETO, CHAVE_TESTE, chamar, chamarCru, conectarCliente, montar, pn, textoDe, type Montagem, type OpcoesMontagem } from "./ajuda.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
let restaurarLog: (() => void) | undefined;
let pastaParaApagar: string | undefined;
afterEach(async () => {
  restaurarLog?.();
  restaurarLog = undefined;
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
  if (pastaParaApagar) rmSync(pastaParaApagar, { recursive: true, force: true });
  pastaParaApagar = undefined;
});

const NEGADO = () => {
  throw new Error("node:sqlite negado neste teste");
};

/** Uma mensagem guardada (ts em ms; `dias` atrás de uma data fixa). */
const BASE = new Date(2026, 9, 10, 12, 0, 0).getTime();
const DIA = 86_400_000;
function mg(id: string, texto: string | undefined, o: Partial<MensagemGuardada> & { dias?: number } = {}): MensagemGuardada {
  const { dias = 0, ...resto } = o;
  return { id, ts: BASE - dias * DIA, de_mim: false, tipo: "texto", ...(texto !== undefined ? { texto } : {}), ...resto };
}

async function cenario(opcoes: OpcoesMontagem = {}): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar(opcoes);
  const { banco } = await m.ctx.nucleo();
  banco.gravarMensagens(pn(ANA), [
    mg("A1", "Amanhã a gente fala do ALUGUEL do apartamento", { dias: 5 }),
    mg("A2", "o aluguel subiu de novo", { dias: 3, de_mim: true }),
    mg("A3", "reunião do condomínio às 19h", { dias: 2 }),
    mg("A4", undefined, { dias: 1, tipo: "nota_de_voz", midia: { baixavel: false, mimetype: "audio/ogg" }, transcricao: { texto: "liga pro encanador amanhã cedo", idioma: "pt", em: BASE } }),
    mg("A5", "segue o contrato", { dias: 0.5, tipo: "documento", midia: { baixavel: false, nome: "contrato-locacao.pdf" } }),
  ]);
  banco.gravarMensagens(pn(BETO), [
    mg("B1", "aluguel aluguel aluguel, falei do aluguel o dia todo", { dias: 4 }),
    mg("B2", "vamos de pizza hoje?", { dias: 1 }),
  ]);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const buscar = (c: Cliente, args: Record<string, unknown>) => chamar(c, "wa_buscar", args);
const ids = (r: Record<string, unknown>) => (r.resultados as Array<{ mensagem_id: string }>).map((x) => x.mensagem_id);
const resultados = (r: Record<string, unknown>) => r.resultados as Array<Record<string, unknown>>;

describe("0.8.0: o teste do motor na partida", () => {
  it("com node:sqlite escolhe fts5 (e o trigram, se o tokenizador existir)", () => {
    const cap = testarMotor();
    assert.equal(cap.motor, "fts5");
    assert.equal(typeof cap.trigram, "boolean");
  });

  it("com o módulo negado (erro ou ausente) escolhe varredura, sem derrubar nada", () => {
    assert.deepEqual(testarMotor(NEGADO), { motor: "varredura", trigram: false });
    assert.deepEqual(testarMotor(() => undefined), { motor: "varredura", trigram: false });
    // Um módulo que existe mas não tem FTS5 (DatabaseSync que falha): varredura.
    const quebrado = { DatabaseSync: class { constructor() { throw new Error("sem fts5"); } } } as unknown as typeof import("node:sqlite");
    assert.equal(testarMotor(() => quebrado).motor, "varredura");
  });
});

describe("0.8.0: a expressão do FTS5 não deixa a sintaxe vazar", () => {
  it("aspas em cada termo, aspas internas dobradas, prefixo só no último com 2+ caracteres", () => {
    assert.equal(expressaoDoIndice(termosDe("aluguel apartamento")), '"aluguel" "apartamento"*');
    assert.equal(expressaoDoIndice(termosDe("aluguel a")), '"aluguel" "a"');
    assert.equal(expressaoDoIndice(termosDe('di"z OR x*')), '"di""z" "OR" "x*"*');
    assert.equal(expressaoDoIndice(termosDe("NEAR(a b) col:valor ^início")), '"NEAR(a" "b)" "col:valor" "^início"*');
    assert.equal(expressaoDoIndice(termosDe(": ( ) *")), null, "só pontuação: nada vai ao índice");
    assert.equal(expressaoDoPedaco(termosDe("ab luguel")), '"luguel"');
  });
});

describe("0.8.0: wa_buscar com o índice", () => {
  it("sem acento e sem diferença de maiúscula; dois termos são AND; o último termo vale como prefixo", async () => {
    const { c } = await cenario();
    const r = await buscar(c, { texto: "AMANHA aluguel" });
    assert.deepEqual(ids(r), ["A1"]);
    assert.equal(r.caminho, "indice");
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "condominio" }))), new Set(["A3"]));
    const prefixo = await buscar(c, { texto: "reuniao condo" });
    assert.deepEqual(ids(prefixo), ["A3"], "prefixo no último termo");
    assert.equal(prefixo.caminho, "indice");
    // O prefixo é só no último: "condo" no meio não acha pelo índice; quem acha é o pedaço de palavra.
    assert.equal((await buscar(c, { texto: "condo reuniao" })).caminho, "pedaco");
  });

  it("pedaço de palavra pelo trigram quando o índice não acha", async () => {
    const { c } = await cenario();
    assert.ok(m!.ctx.busca.trigram, "este Node tem o tokenizador trigram");
    const r = await buscar(c, { texto: "partamen" });
    assert.deepEqual(ids(r), ["A1"]);
    assert.equal(r.caminho, "pedaco");
  });

  it("ordem por relevância (o texto com mais ocorrências primeiro) e por recentes", async () => {
    const { c } = await cenario();
    const rel = await buscar(c, { texto: "aluguel" });
    assert.equal(ids(rel)[0], "B1", "quatro vezes 'aluguel' vem primeiro");
    assert.deepEqual(new Set(ids(rel)), new Set(["A1", "A2", "B1"]));
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", ordem: "recentes" })), ["A2", "B1", "A1"]);
  });

  it("filtros conversa, de_mim, desde e ate (datas inclusivas)", async () => {
    const { c } = await cenario();
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", conversa: pn(ANA), ordem: "recentes" })), ["A2", "A1"]);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", de_mim: true })), ["A2"]);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", de_mim: false, ordem: "recentes" })), ["B1", "A1"]);
    const dia = (dias: number) => {
      const d = new Date(BASE - dias * DIA);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", desde: dia(4), ordem: "recentes" })), ["A2", "B1"]);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", ate: dia(4), ordem: "recentes" })), ["B1", "A1"]);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", desde: dia(4), ate: dia(4) })), ["B1"]);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", desde: new Date(BASE - 3 * DIA).toISOString() })), ["A2"], "data com hora: o instante, inclusive");
    const r = await chamarCru(c, "wa_buscar", { texto: "aluguel", desde: dia(1), ate: dia(4) });
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /desde.*depois de .*ate/);
  });

  it("paginação com cursor e total", async () => {
    const { c } = await cenario();
    const p1 = await buscar(c, { texto: "aluguel", ordem: "recentes", limite: 2 });
    assert.deepEqual(ids(p1), ["A2", "B1"]);
    assert.equal(p1.total, 3);
    assert.equal(p1.quantidade, 2);
    assert.equal(p1.proximo, "2");
    const p2 = await buscar(c, { texto: "aluguel", ordem: "recentes", limite: 2, cursor: p1.proximo });
    assert.deepEqual(ids(p2), ["A1"]);
    assert.equal(p2.total, 3);
    assert.equal(p2.proximo, null);
  });

  it("achado na transcrição e no nome do arquivo, com achado_em; a transcrição vai em conteudo_de_terceiros", async () => {
    const { c } = await cenario();
    const t = resultados(await buscar(c, { texto: "encanador" }));
    assert.equal(t.length, 1);
    assert.equal(t[0]!.achado_em, "transcricao");
    assert.match(JSON.stringify(t[0]!.conteudo_de_terceiros), /liga pro encanador/);
    const a = resultados(await buscar(c, { texto: "locacao" }));
    assert.equal(a.length, 1);
    assert.equal(a[0]!.mensagem_id, "A5");
    assert.equal(a[0]!.achado_em, "arquivo");
    const x = resultados(await buscar(c, { texto: "contrato" }));
    assert.equal(x[0]!.achado_em, "texto", "a legenda pesa mais que o nome do arquivo");
    const meu = resultados(await buscar(c, { texto: "subiu" }));
    assert.equal(meu[0]!.trecho, "o aluguel subiu de novo", "do dono: trecho no nível de cima, como antes");
    assert.equal(meu[0]!.achado_em, "texto");
  });

  it("mensagem nova, editada, apagada, transcrição nova e conversa bloqueada aparecem na busca seguinte", async () => {
    const { c, banco } = await cenario();
    assert.deepEqual(ids(await buscar(c, { texto: "pizza" })), ["B2"]);
    banco.gravarMensagens(pn(ANA), [mg("A6", "pizza de calabresa", { dias: 0.1 })]);
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "pizza" }))), new Set(["B2", "A6"]));
    assert.ok(banco.editarMensagem(pn(ANA), "A6", "lasanha de berinjela", { de_mim: false }));
    assert.deepEqual(ids(await buscar(c, { texto: "pizza" })), ["B2"]);
    assert.deepEqual(ids(await buscar(c, { texto: "berinjela" })), ["A6"]);
    assert.ok(banco.apagarMensagem(pn(ANA), "A6", { de_mim: false }));
    assert.deepEqual(ids(await buscar(c, { texto: "berinjela" })), []);
    banco.gravarMensagens(pn(BETO), [mg("B3", undefined, { tipo: "nota_de_voz", midia: { baixavel: false } })]);
    assert.ok(banco.gravarTranscricao(pn(BETO), "B3", { texto: "o orçamento chegou", idioma: "pt", em: BASE }));
    assert.deepEqual(ids(await buscar(c, { texto: "orcamento" })), ["B3"]);
    banco.bloquear(pn(BETO));
    assert.deepEqual(ids(await buscar(c, { texto: "pizza" })), []);
    assert.deepEqual(ids(await buscar(c, { texto: "aluguel", ordem: "recentes" })), ["A2", "A1"]);
  });

  it("mudança feita por OUTRA instância do banco na mesma pasta aparece", async () => {
    const { c } = await cenario();
    assert.deepEqual(ids(await buscar(c, { texto: "pizza" })), ["B2"]);
    const outro = new Banco({ dir: m!.config.dirDados, chave: await new CofreEmMemoria(CHAVE_TESTE).obterChave() });
    outro.gravarMensagens(pn(ANA), [mg("X1", "pizza de outro processo", { dias: 0.2 })]);
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "pizza" }))), new Set(["B2", "X1"]));
    outro.apagarConversa(pn(BETO));
    assert.deepEqual(ids(await buscar(c, { texto: "pizza" })), ["X1"]);
  });

  it("aspas, *, OR, : e parênteses no texto não quebram nem mudam a semântica", async () => {
    const { c } = await cenario();
    for (const texto of ['"aluguel"', "aluguel*", "aluguel OR pizza", "aluguel:", "(aluguel)", 'NEAR("aluguel" pizza)', "^aluguel", "*:()\""]) {
      const r = await chamarCru(c, "wa_buscar", { texto });
      assert.equal(r.isError, undefined, `${texto}: ${textoDe(r)}`);
    }
    assert.equal((await buscar(c, { texto: "aluguel OR pizza" })).total, 0, "OR é palavra, não operador");
    assert.deepEqual(new Set(ids(await buscar(c, { texto: '"aluguel"' }))), new Set(["A1", "A2", "B1"]));
    assert.deepEqual(new Set(ids(await buscar(c, { texto: "(aluguel)" }))), new Set(["A1", "A2", "B1"]));
  });

  it("wa_estado.busca: motor, trigram e o tamanho do índice (null até a primeira busca)", async () => {
    const { c } = await cenario();
    const antes = (await chamar(c, "wa_estado")).busca as Record<string, unknown>;
    assert.deepEqual(antes, { motor: "fts5", trigram: true, mensagens_indexadas: null, conversas_indexadas: null, montado_em_ms: null });
    await buscar(c, { texto: "aluguel" });
    const depois = (await chamar(c, "wa_estado")).busca as Record<string, unknown>;
    assert.equal(depois.mensagens_indexadas, 7);
    assert.equal(depois.conversas_indexadas, 2);
    assert.equal(typeof depois.montado_em_ms, "number");
  });
});

describe("0.8.0: plano B (varredura)", () => {
  it("com o módulo negado, responde pela varredura o mesmo conjunto que o índice", async () => {
    const consultas = ["aluguel", "condominio", "encanador", "locacao", "pizza", "nada-disso"];
    const comIndice: Array<Set<string>> = [];
    {
      const { c } = await cenario();
      for (const texto of consultas) {
        const r = await buscar(c, { texto });
        if (r.total) assert.equal(r.caminho, "indice", texto);
        comIndice.push(new Set(ids(r)));
      }
      await fecharCliente!();
      fecharCliente = undefined;
      await m!.fechar();
      m = undefined;
    }
    const { c } = await cenario({ carregarSqlite: NEGADO });
    assert.equal(m!.ctx.busca.motor, "varredura");
    for (const [i, texto] of consultas.entries()) {
      const r = await buscar(c, { texto });
      assert.equal(r.caminho, "varredura");
      assert.deepEqual(new Set(ids(r)), comIndice[i], texto);
    }
    const estado = (await chamar(c, "wa_estado")).busca as Record<string, unknown>;
    assert.deepEqual(estado, { motor: "varredura", trigram: false, mensagens_indexadas: null, conversas_indexadas: null, montado_em_ms: null });
    // Filtros e paginação também na varredura.
    const p = await buscar(c, { texto: "aluguel", de_mim: false, limite: 1 });
    assert.deepEqual(ids(p), ["B1"]);
    assert.equal(p.total, 2);
    assert.equal(p.proximo, "1");
  });

  it("com o índice, termo de 1 caractere sem achado cai na varredura", async () => {
    const { c } = await cenario();
    const r = await buscar(c, { texto: "19h" });
    assert.deepEqual(ids(r), ["A3"]);
    // "h" não é palavra no índice (o token é "19h") e é curto demais para o trigram: a varredura acha o pedaço de texto.
    const v = await buscar(c, { texto: "o h" });
    assert.equal(v.caminho, "varredura");
    assert.ok(ids(v).includes("A3"));
  });
});

describe("0.8.0: wa_ler_conversa com em_volta_de", () => {
  async function conversaLonga(): Promise<Cliente> {
    m = await montar();
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), Array.from({ length: 20 }, (_, i) => mg(`M${String(i).padStart(2, "0")}`, `mensagem ${i}`, { dias: 20 - i })));
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    return cliente;
  }
  const janela = (r: Record<string, unknown>) => (r.mensagens as Array<{ id: string; pedida?: boolean }>);

  it("no meio: 5 antes, a pedida (marcada) e 5 depois, na ordem de sempre", async () => {
    const c = await conversaLonga();
    const r = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M10" });
    assert.deepEqual(janela(r).map((x) => x.id), ["M05", "M06", "M07", "M08", "M09", "M10", "M11", "M12", "M13", "M14", "M15"]);
    assert.deepEqual(janela(r).filter((x) => x.pedida).map((x) => x.id), ["M10"]);
    assert.equal(r.mais_antigas, "15");
    const antes = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), antes_de: r.mais_antigas, limite: 2 });
    assert.deepEqual(janela(antes).map((x) => x.id), ["M03", "M04"], "mais_antigas continua de onde a janela começa");
  });

  it("no começo e no fim a janela se desloca; limite muda o tamanho", async () => {
    const c = await conversaLonga();
    const ini = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M01" });
    assert.deepEqual(janela(ini).map((x) => x.id), Array.from({ length: 11 }, (_, i) => `M${String(i).padStart(2, "0")}`));
    assert.equal(ini.mais_antigas, null);
    const fim = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M19", limite: 3 });
    assert.deepEqual(janela(fim).map((x) => x.id), ["M17", "M18", "M19"]);
    assert.equal(janela(fim)[2]!.pedida, true);
  });

  it("erros claros: id que não existe e combinação com antes_de ou desde_o_ultimo_resumo", async () => {
    const c = await conversaLonga();
    const nao = await chamarCru(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "NAO-EXISTE" });
    assert.equal(nao.isError, true);
    assert.match(textoDe(nao), /Não achei essa mensagem nesta conversa/);
    for (const extra of [{ antes_de: "3" }, { desde_o_ultimo_resumo: true }]) {
      const r = await chamarCru(c, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: "M10", ...extra });
      assert.equal(r.isError, true);
      assert.match(textoDe(r), /não combina/);
    }
    const normal = await chamar(c, "wa_ler_conversa", { conversa: pn(ANA) });
    assert.equal(janela(normal).length, 20, "sem em_volta_de: o padrão de 30 continua");
  });
});

describe("0.8.0: a busca não vaza nem grava", () => {
  const listarTudo = (pasta: string): string[] => {
    if (!existsSync(pasta)) return [];
    return readdirSync(pasta, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(pasta.length))
      .sort();
  };

  it("valores sensíveis buscados não aparecem em log, registro nem caixa-preta; nenhum arquivo novo nas pastas", async () => {
    const SEGREDO = "palavrasecreta";
    const ID_SECRETO = "ID-SECRETO-0800";
    const linhas: string[] = [];
    restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
    // A caixa-preta grava de verdade na pasta de logs da montagem.
    const dir = mkdtempSync(join(tmpdir(), "wa-teste-"));
    pastaParaApagar = dir;
    const caixa = new CaixaPreta({ dir: join(dir, "logs"), saida: (l) => linhas.push(l) });
    m = await montar({ dir, pareada: false, caixaPreta: caixa });
    const { banco } = await m.ctx.nucleo();
    banco.gravarMensagens(pn(ANA), [mg(ID_SECRETO, `o ${SEGREDO} do cofre é ${BETO}`), mg("Q2", undefined, { tipo: "nota_de_voz", midia: { baixavel: false }, transcricao: { texto: `transcrição com ${SEGREDO}`, idioma: "pt", em: BASE } })]);
    const { cliente, fechar } = await conectarCliente(m.ctx);
    fecharCliente = fechar;
    const dadosAntes = listarTudo(m.config.dirDados);
    const logsAntes = listarTudo(m.config.dirLogs);
    for (const texto of [SEGREDO, BETO, ANA, `${SEGREDO} cofre`, "secre", ID_SECRETO, '"OR" palavra*']) {
      await chamar(cliente, "wa_buscar", { texto });
      await chamar(cliente, "wa_buscar", { texto, ordem: "recentes", de_mim: false });
    }
    await chamar(cliente, "wa_ler_conversa", { conversa: pn(ANA), em_volta_de: ID_SECRETO });
    // 0.9.0: as duas mensagens têm a mesma data (um bloco só): a contagem por mensagem continua 2.
    const r = await chamar(cliente, "wa_buscar", { texto: SEGREDO, agrupar: "mensagem" });
    assert.equal(r.total, 2, "a busca achou (senão o teste não prova nada)");
    const registro = existsSync(m.caminhoRegistro) ? readFileSync(m.caminhoRegistro, "utf8") : "";
    const caixaPreta = readFileSync(join(m.config.dirLogs, "caixa-preta.jsonl"), "utf8");
    for (const [onde, texto] of [["log", linhas.join("\n")], ["registro", registro], ["caixa-preta", caixaPreta]] as const) {
      for (const proibido of [SEGREDO, "secre", ID_SECRETO, ANA, BETO, "cofre", "@s.whatsapp.net", "c_"]) {
        assert.ok(!texto.includes(proibido), `${onde} traz ${proibido}`);
      }
    }
    const eventos = caixaPreta.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.evento === "indice_de_busca");
    assert.equal(eventos.length, 1, "uma vez: na primeira montagem");
    const { quando: _q, pid: _p, versao: _v, papel: _pa, evento: _e, ...campos } = eventos[0]!;
    assert.deepEqual(Object.keys(campos).sort(), ["conversas", "duracao_ms", "mensagens", "motor", "trigram"]);
    assert.deepEqual(listarTudo(m.config.dirDados), dadosAntes, "a busca não criou arquivo na pasta de dados");
    const novosNosLogs = listarTudo(m.config.dirLogs).filter((f) => !logsAntes.includes(f));
    assert.ok(novosNosLogs.every((f) => /caixa-preta\.jsonl$|vivo-\d+\.json$/.test(f)), `arquivo novo nos logs: ${novosNosLogs.join(", ")}`);
    assert.ok(!listarTudo(m.dir).some((f) => /sqlite|\.db$|-journal$|-wal$|-shm$/i.test(f)), "nenhum arquivo de SQLite em disco");
  });

  it("a busca é fechada com o contexto (nada fica aberto)", async () => {
    const b = new Busca();
    assert.equal(b.motor, "fts5");
    b.fechar();
    b.fechar();
  });
});

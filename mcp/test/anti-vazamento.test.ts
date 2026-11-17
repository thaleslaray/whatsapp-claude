// Anti-vazamento (adaptado do MCP do Instagram, test/anti-vazamento.test.ts). Com a chave da instalação e as
// credenciais da Baileys carregadas, roda TODAS as ferramentas registradas em vários cenários (sem sessão,
// conectado com dados, leitor, cofre com erro) e confere que nenhuma saída, log, stderr ou registro de ações
// traz a chave (hex ou base64), uma chave privada das credenciais, um número de telefone inteiro ou um jid.
//
// Genérico: percorre `listTools()` e `listPrompts()`. Ferramenta nova com argumento obrigatório: acrescente em ARGUMENTOS_DE_EXEMPLO.
// Fase 2: o cenário "conectado com dados" também liga o envio e responde com cliques de verdade (wa_confirmar_tela), e
// guarda uma mídia com chave e caminho: nem a chave nem o caminho da mídia podem sair. O que vai no `_meta` (para o
// cartão) também é conferido.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Cofre } from "../src/cofre.ts";
import { trocarSaidaDoLog } from "../src/log.ts";
import { esquecerSegredos } from "../src/segredos.ts";
import { ANA, assentar, BETO, CHAVE_TESTE, conectar, conectarCliente, DONO, GRUPO, montar, pn, type Montagem } from "./ajuda.ts";
import { msg } from "./socket-falso.ts";

const ARGUMENTOS_DE_EXEMPLO: Record<string, Array<Record<string, unknown>>> = {
  wa_ler_conversa: [{ conversa: ANA }, { conversa: pn(BETO) }, { conversa: "Família" }, { conversa: "c_000000000000" }, { conversa: `${ANA.slice(0, 6)}@lid` }],
  wa_buscar: [{ texto: "segredo" }, { texto: "oi", conversa: pn(ANA) }, { texto: `${ANA} "OR" segr*`, ordem: "recentes", de_mim: false, desde: "2020-01-01", ate: "2099-12-31", cursor: "1" }],
  wa_escolher_grupos: [{ adicionar: [GRUPO, "Família"], remover: ["5511912345678-1600000000@g.us"] }],
  wa_bloquear_conversas: [{ bloquear: [pn(BETO), "+55 11 91234-5678"], liberar: [pn(BETO)] }, {}],
  wa_listar_grupos: [{}, { atualizar: true }],
  wa_responder: [{ conversa: ANA, texto: "resposta curta" }, { conversa: GRUPO, texto: "para o grupo" }, { conversa: pn(BETO), texto: "x", citar: "nao-existe" }],
  wa_envio: [{}, { ligar: true }, { ligar: false }],
  wa_confirmar: [{ id: "00000000", codigo: "errado" }],
  wa_confirmar_tela: [{ id: "00000000", codigo: "errado" }],
  wa_cancelar: [{ id: "00000000" }],
  wa_cancelar_pedido: [{ id: "00000000" }],
  wa_estado_pedido_tela: [{ id: "00000000" }],
  wa_estado_pareamento_tela: [{ id: "00000000" }],
  wa_marcar_resumo: [{ conversas: [{ conversa: GRUPO, marca: "1" }, { conversa: ANA, marca: "1" }] }],
  // 0.7.0
  wa_iniciar_conversa: [{ numero: `+${ANA}`, texto: "oi" }, { numero: "abc", texto: "oi" }],
  wa_reagir: [{ conversa: ANA, mensagem: "nao-existe", emoji: "👍" }, { conversa: GRUPO, mensagem: "nao-existe", emoji: "" }],
  wa_editar: [{ conversa: ANA, mensagem: "nao-existe", texto: "novo" }],
  wa_apagar: [{ conversa: pn(BETO), mensagem: "nao-existe" }],
  // Conversa que não existe: recusa antes de pedir ao celular (senão o teste esperaria a resposta).
  wa_buscar_historico: [{ conversa: "c_000000000000", quantidade: 5 }],
  // 0.7.0, parte 2: abrir a mídia guardada (o download falso recusa) e enviar um arquivo que não existe.
  wa_abrir_midia: [{ conversa: ANA, mensagem: "MIDIA1" }, { conversa: ANA, mensagem: "nao-existe" }],
  wa_transcrever: [{ conversa: ANA, mensagem: "MIDIA1" }, { conversa: ANA, mensagem: "nao-existe" }],
  wa_enviar_arquivo: [{ conversa: ANA, arquivo: "/nao/existe/contrato.pdf", legenda: "x" }, { conversa: ANA, arquivo: "relativo.pdf" }],
};
ARGUMENTOS_DE_EXEMPLO.wa_ler_conversa!.push({ conversa: GRUPO, desde_o_ultimo_resumo: true });
ARGUMENTOS_DE_EXEMPLO.wa_ler_conversa!.push({ conversa: ANA, em_volta_de: "nao-existe" }, { conversa: ANA, em_volta_de: "MIDIA1", limite: 3 });
// 0.9.0: blocos na busca, o bloco aberto pelo em_volta_de e a triagem da lista.
ARGUMENTOS_DE_EXEMPLO.wa_ler_conversa!.push({ conversa: ANA, em_volta_de: "MIDIA1" });
ARGUMENTOS_DE_EXEMPLO.wa_buscar!.push({ texto: "segredo qualquer", agrupar: "bloco" }, { texto: `um ${ANA}`, agrupar: "mensagem", ordem: "recentes" }, { texto: "oi segredo", agrupar: "bloco", de_mim: false });
// 0.10.0: a memória (a citação "oi" não está na mídia: recusada; a do texto entra).
ARGUMENTOS_DE_EXEMPLO.wa_anotar = [
  { conversa: ANA, resumo: "resumo sigiloso da conversa", ate: "1", compromissos: [{ tipo: "promessa", quem_deve: "outro", o_que: "algo sigiloso", mensagem_id: "MIDIA1", citacao: "oi" }] },
  { conversa: GRUPO, resumo: "resumo do grupo", ate: "1", compromissos: [{ tipo: "pedido", quem_deve: "dono", o_que: "responder", mensagem_id: "nao-existe", citacao: "oi grupo", prazo: "+1d" }], fechar: [{ id: "k_00000000", estado: "cumprido" }] },
  { conversa: "c_000000000000", fechar: [{ id: "k_00000000", estado: "cancelado", evidencia_mensagem_id: "nao-existe" }] },
];
ARGUMENTOS_DE_EXEMPLO.wa_memoria = [{}, { conversa: ANA, incluir_fechados: true }, { quem_deve: "dono", so_vencidos: true, limite: 5, cursor: "1" }, { conversa: "c_000000000000" }];
ARGUMENTOS_DE_EXEMPLO.wa_esquecer = [{ conversa: ANA }, { conversa: "c_000000000000" }, { tudo: true }];
ARGUMENTOS_DE_EXEMPLO.wa_listar_conversas = [
  {},
  { esperando_resposta: true },
  { sem_encerramento: true, com_novidades: true },
  { esperando_resposta: true, sem_encerramento: true, com_novidades: true, filtro: "Ana", desde_horas: 24 },
  // 0.11.0: filtro com emoji.
  { filtro: "🤖 Fam" },
];
// 0.11.0: wa_listar_grupos paginado (e com filtro de emoji); prazo "nenhum" no wa_anotar.
ARGUMENTOS_DE_EXEMPLO.wa_listar_grupos!.push({ limite: 1, cursor: "0" }, { filtro: "🏠 Fam", limite: 100 });
ARGUMENTOS_DE_EXEMPLO.wa_anotar!.push({ conversa: GRUPO, compromissos: [{ tipo: "pedido", quem_deve: "outro", o_que: "lid", mensagem_id: "GLID1", citacao: "pelo lid no grupo", prazo: "nenhum" }] });

// 0.12.0: o modo de aprendizado (tipo e regra com o número; respondendo_a com o número; ids que não existem).
ARGUMENTOS_DE_EXEMPLO.wa_meu_jeito = [{}, { conversa: ANA }, { conversa: GRUPO }, { tipo: `cliente ${ANA}` }, { conversa: "c_000000000000" }];
ARGUMENTOS_DE_EXEMPLO.wa_exemplos_do_meu_jeito = [{ conversa: ANA }, { conversa: GRUPO, quantos: 3 }, { conversa: pn(ANA), respondendo_a: `um segredo ${ANA}` }, { conversa: "c_000000000000" }];
ARGUMENTOS_DE_EXEMPLO.wa_edicoes_dos_rascunhos = [{}, { conversa: ANA, incluir_vistas: true }, { ids: ["e_00000000"] }];
ARGUMENTOS_DE_EXEMPLO.wa_aprender = [
  { tipo_da_conversa: [{ conversa: ANA, tipo: "tipo sigiloso" }, { conversa: "c_000000000000", tipo: "x" }] },
  { regra_do_dono: { texto: "regra sigilosa", escopo: "conversa", conversa: ANA } },
  { propor: [{ texto: "proposta sigilosa", escopo: "geral", edicoes: ["e_00000000", "e_00000001"] }], decidir: { id: "r_00000000", decisao: "aceitar" } },
  { desligar: ["r_00000000"], apagar: ["r_00000000"], marcar_vistas: ["e_00000000"] },
  { ligar: false },
  { ligar: true },
];
ARGUMENTOS_DE_EXEMPLO.wa_esquecer!.push({ conversa: ANA, aprendizado: true }, { aprendizado: true });

// 0.13.0: wa_como_eu_respondi (com o número na pergunta, filtros, rascunhos da IA, conversa e tipo que não existem) e o
// ate_total do histórico (conversa que não existe: recusa antes de começar o trabalho em segundo plano).
ARGUMENTOS_DE_EXEMPLO.wa_como_eu_respondi = [
  { pergunta: "um segredo qualquer?" },
  { pergunta: `qual o número ${ANA} do segredo`, conversa: ANA, limite: 10 },
  { pergunta: "pelo lid no grupo", so_grupos: true, incluir_rascunhos_da_ia: true },
  { pergunta: "oi grupo", conversa: GRUPO },
  { pergunta: "qualquer coisa", tipo: `cliente ${ANA}` },
  { pergunta: "segredo", conversa: "c_000000000000" },
];
ARGUMENTOS_DE_EXEMPLO.wa_buscar_historico!.push({ conversa: "g_000000000000", ancora: "sem_id" }, { conversa: "c_000000000000", ate_total: 500, ancora: "agora_de_outro" }, { conversa: `${ANA.slice(0, 6)}@lid`, ate_total: 2_000, quantidade: 50 });

// 0.14.0: wa_conferir_rascunho (rascunho com o número, várias mensagens, conversa que não existe), tipo_de_mensagem no
// wa_meu_jeito e no wa_exemplos_do_meu_jeito, e `propor` com um candidato que não existe.
ARGUMENTOS_DE_EXEMPLO.wa_conferir_rascunho = [
  { conversa: ANA, texto: `Prezado, meu número é ${ANA}. Atenciosamente!` },
  { conversa: GRUPO, mensagens: ["oi segredo", `ligue ${ANA}`] },
  { conversa: "c_000000000000", texto: "segredo" },
];
ARGUMENTOS_DE_EXEMPLO.wa_meu_jeito!.push({ tipo_de_mensagem: "resposta" }, { conversa: GRUPO, tipo_de_mensagem: "aviso" }, { tipo: `cliente ${ANA}`, tipo_de_mensagem: "pergunta" });
ARGUMENTOS_DE_EXEMPLO.wa_exemplos_do_meu_jeito!.push({ conversa: GRUPO, tipo_de_mensagem: "aviso" }, { conversa: ANA, tipo_de_mensagem: "qualquer", quantos: 3 });
ARGUMENTOS_DE_EXEMPLO.wa_aprender!.push({ propor: [{ candidato: "cand_00000000" }] });
// 0.15.0: a ferramenta dos contatos.
ARGUMENTOS_DE_EXEMPLO.wa_atualizar_contatos = [{}];

/** A chave e o caminho de uma mídia guardada: ficam no banco cifrado e nunca podem sair. */
const CHAVE_DA_MIDIA = Buffer.from("chave-de-midia-de-teste-32-bytes").toString("base64");
const CAMINHO_DA_MIDIA = "/v/t62.7117-24/caminho-secreto-da-midia";

const formasDaChave = [CHAVE_TESTE, CHAVE_TESTE.toUpperCase(), Buffer.from(CHAVE_TESTE, "hex").toString("base64")];
const numeros = [ANA, BETO, DONO];

function conferir(textos: string[], extras: string[], onde: string): void {
  for (const texto of textos) {
    for (const p of [...formasDaChave, ...extras]) assert.ok(!texto.includes(p), `${onde}: segredo numa saída: ${texto.slice(0, 160)}`);
    for (const n of numeros) assert.ok(!texto.includes(n), `${onde}: número inteiro ${n} numa saída: ${texto.slice(0, 160)}`);
    assert.ok(!/\d{5,}(?::\d+)?@(s\.whatsapp\.net|lid)/.test(texto), `${onde}: jid numa saída: ${texto.slice(0, 160)}`);
  }
}

type Cenario = "sem sessão" | "conectado com dados" | "leitor" | "cofre com erro";

describe("anti-vazamento: chave, credenciais e números não saem em lugar nenhum", () => {
  let m: Montagem;
  let leitor: Montagem | undefined;
  let linhas: string[];
  let stderr: string[];
  let restaurarLog: () => void;
  let stderrOriginal: typeof process.stderr.write;

  beforeEach(() => {
    esquecerSegredos();
    linhas = [];
    stderr = [];
    restaurarLog = trocarSaidaDoLog((l) => linhas.push(l));
    stderrOriginal = process.stderr.write;
    process.stderr.write = ((t: string | Uint8Array) => {
      stderr.push(String(t));
      return true;
    }) as typeof process.stderr.write;
  });
  afterEach(async () => {
    process.stderr.write = stderrOriginal;
    restaurarLog();
    await leitor?.ctx.encerrar();
    leitor = undefined;
    await m.fechar();
    esquecerSegredos();
  });

  for (const cenario of ["sem sessão", "conectado com dados", "leitor", "cofre com erro"] as Cenario[]) {
    it(cenario, async () => {
      let alvo: Montagem;
      const privadas: string[] = [];
      if (cenario === "cofre com erro") {
        const cofre: Cofre = {
          obterChave: async () => {
            throw new Error(`O cofre recusou a chave ${CHAVE_TESTE} (conta ${pn(ANA)})`);
          },
        };
        m = await montar({ pareada: false, cofre });
        alvo = m;
      } else {
        m = await montar({ pareada: cenario !== "sem sessão" });
        if (cenario === "sem sessão") await m.ctx.partida();
        else {
          const s = await conectar(m);
          const creds = s.config.auth!.creds;
          for (const k of [creds.noiseKey.private, creds.signedIdentityKey.private, creds.signedPreKey.keyPair.private]) {
            privadas.push(Buffer.from(k).toString("base64"), Buffer.from(k).toString("hex"));
          }
          privadas.push(CHAVE_DA_MIDIA, CAMINHO_DA_MIDIA, "caminho-secreto-da-midia");
          // 0.11.0: participantes com LID e número (o mapa aprende) e mensagens de grupo só com o LID.
          s.grupos = { [GRUPO]: { id: GRUPO, subject: "Família", size: 3, participants: [{ id: pn(ANA) }, { id: "88888000002@lid", phoneNumber: pn(BETO) }] } };
          (await m.ctx.nucleo()).banco.permitirGrupo(GRUPO);
          s.mensagens([
            msg({ jid: pn(ANA), texto: "um segredo qualquer", nome: "Ana" }),
            msg({
              jid: pn(ANA),
              id: "MIDIA1",
              message: { imageMessage: { mimetype: "image/jpeg", fileLength: 1000, url: "https://mmg.whatsapp.net/x", directPath: CAMINHO_DA_MIDIA, mediaKey: Buffer.from(CHAVE_DA_MIDIA, "base64") } },
            }),
            msg({ jid: GRUPO, texto: "oi grupo", participante: pn(BETO), nome: "Beto" }),
            msg({ jid: GRUPO, id: "GLID1", texto: "pelo lid no grupo", participante: "88888000002@lid", nome: "Beto" }),
            msg({ jid: GRUPO, texto: "lid com alt", participante: "88888000003@lid", participanteAlt: pn(BETO), nome: "Beto" }),
            msg({ jid: "77777000001@lid", texto: "pelo lid" }),
          ]);
          s.emitir("contacts.upsert", [{ id: pn(BETO), name: "Beto" }]);
          await assentar(m);
        }
        alvo = m;
        if (cenario === "leitor") {
          leitor = await montar({ dir: m.dir, pareada: false });
          await leitor.ctx.partida();
          alvo = leitor;
        }
      }

      const saidas: string[] = [];
      const { cliente, fechar } = await conectarCliente(alvo.ctx);
      try {
        const { tools } = await cliente.listTools();
        assert.equal(tools.length, 38);
        saidas.push(JSON.stringify(tools), cliente.getInstructions() ?? "");
        for (const p of (await cliente.listPrompts()).prompts) saidas.push(JSON.stringify(await cliente.getPrompt({ name: p.name, arguments: {} })));
        if (cenario === "conectado com dados") {
          // Cliques de verdade: liga o envio e responde à Ana citando a mensagem dela.
          const clicar = async (r: { structuredContent?: unknown; _meta?: unknown }) => {
            const id = (r.structuredContent as { pedido?: string }).pedido!;
            const codigo = (r._meta as { codigo?: string }).codigo!;
            return cliente.callTool({ name: "wa_confirmar_tela", arguments: { id, codigo } });
          };
          const envio = await cliente.callTool({ name: "wa_envio", arguments: { ligar: true } });
          saidas.push(JSON.stringify(envio), JSON.stringify(await clicar(envio)));
          const resposta = await cliente.callTool({ name: "wa_responder", arguments: { conversa: ANA, texto: "minha resposta" } });
          saidas.push(JSON.stringify(resposta));
          const enviada = await clicar(resposta);
          assert.equal(enviada.isError, undefined, JSON.stringify(enviada));
          saidas.push(JSON.stringify(enviada));
        }
        for (const ferramenta of tools) {
          for (const args of ARGUMENTOS_DE_EXEMPLO[ferramenta.name] ?? [{}]) {
            const r = await cliente.callTool({ name: ferramenta.name, arguments: args });
            saidas.push(JSON.stringify(r));
            // As consultas do cartão não abrem o banco: respondem "inexistente" mesmo sem chave.
            const semBanco = ["wa_estado_pedido_tela", "wa_estado_pareamento_tela"].includes(ferramenta.name);
            if (cenario === "cofre com erro" && !semBanco) assert.equal(r.isError, true, `${ferramenta.name} deveria falhar sem chave`);
          }
        }
      } finally {
        await fechar();
      }
      await alvo.ctx.transporte?.esperar();
      if (cenario === "cofre com erro") assert.ok(saidas.some((t) => t.includes("‹segredo›")), "a chave do erro foi trocada pela marca");

      const registro = existsSync(alvo.caminhoRegistro) ? [readFileSync(alvo.caminhoRegistro, "utf8")] : [];
      conferir(saidas, privadas, "ferramenta");
      conferir(linhas, privadas, "log");
      conferir(stderr, privadas, "stderr");
      conferir(registro, privadas, "registro de ações");
    });
  }
});

describe("segredos só entram por onde devem", () => {
  const raizSrc = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const arquivos = (pasta: string): string[] =>
    readdirSync(pasta).flatMap((nome) => {
      const caminho = join(pasta, nome);
      return statSync(caminho).isDirectory() ? arquivos(caminho) : caminho.endsWith(".ts") ? [caminho] : [];
    });
  const fontes = arquivos(raizSrc).map((caminho) => ({ caminho, texto: readFileSync(caminho, "utf8") }));

  it("nenhuma ferramenta aceita chave, token, senha ou credencial como parâmetro", async () => {
    const m = await montar({ pareada: false });
    const { cliente, fechar } = await conectarCliente(m.ctx);
    try {
      for (const ferramenta of (await cliente.listTools()).tools) {
        const propriedades = Object.keys((ferramenta.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
        for (const nome of propriedades) assert.ok(!/token|secret|segredo|senha|password|chave|key|credencia|credential|auth/i.test(nome), `${ferramenta.name} aceita "${nome}"`);
      }
    } finally {
      await fechar();
      await m.fechar();
    }
  });

  it("o código só lê estas variáveis de ambiente, e nada de .env", () => {
    const permitidas = new Set(["WA_DADOS_DIR", "WA_LOGS_DIR", "WA_TESTE_CHAVE", "WA_INSTALACAO", "WA_PROTOCOLO", "WA_LIMITE_DIARIO", "WA_LIMITE_NOVAS_CONVERSAS", "WA_IDIOMA_TRANSCRICAO", "WA_PEDIDOS_DE_HISTORICO_POR_DIA", "WA_TESTE_SOCKET", "WA_SEM_ON_DEMAND_READY", "WA_APARELHO_DESKTOP", "WA_LEITURA_LOCAL", "SystemRoot", "windir"]);
    for (const { caminho, texto } of fontes) {
      for (const m of texto.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)) assert.ok(permitidas.has(m[1]!), `${caminho} lê ${m[1]}`);
      for (const m of texto.matchAll(/["'`](WA_[A-Z_]+)["'`]/g)) assert.ok(permitidas.has(m[1]!), `${caminho} usa ${m[1]}`);
      if (/process\.env\b/.test(texto)) assert.ok(/(config|cofre)\.ts$/.test(caminho), `${caminho} usa process.env`);
      assert.ok(!/dotenv|["'`]\.env/.test(texto), `${caminho} menciona .env`);
    }
  });

  it("nenhum comando do sistema passa por shell; child_process só em sistema.ts", () => {
    for (const { caminho, texto } of fontes) {
      assert.ok(!/\bshell\s*:/.test(texto), `${caminho} usa a opção shell`);
      assert.ok(!/\b(execSync|spawnSync|execFileSync)\b|(?<![.\w])exec\(/.test(texto), `${caminho} usa exec/sync`);
      if (!caminho.endsWith("sistema.ts")) assert.ok(!/child_process/.test(texto), `${caminho} importa child_process fora de sistema.ts`);
    }
  });

  it("a chave, o caminho, o endereço e os hashes da mídia só são lidos no banco: apresentacao.ts escolhe campo a campo e nunca os cita", () => {
    const apresentacao = fontes.find((f) => f.caminho.endsWith("apresentacao.ts"))!.texto;
    assert.ok(!/\.chave\b|\.caminho\b|\.url\b|\.sha256|mediaKey|directPath|fileSha256|fileEncSha256/.test(apresentacao));
    // A mídia que sai é montada só com estes campos.
    assert.match(apresentacao, /mimetype[\s\S]*tamanho_bytes[\s\S]*duracao_s[\s\S]*nome_do_arquivo/);
    // 0.7.0 (parte 2 vai baixar): o endereço passa a ser guardado, mas só de mídia que passou nas travas (enderecoDeMidiaValido),
    // dentro do objeto `paraBaixar` (que exige `baixavel`).
    const conversao = fontes.find((f) => f.caminho.endsWith("conversao.ts"))!.texto;
    assert.match(conversao, /const paraBaixar =\s*baixavel && chave && m\.directPath/);
    assert.match(conversao, /baixavel = !unica && enderecoDeMidiaValido\(m\.url, m\.directPath\)/);
  });
});

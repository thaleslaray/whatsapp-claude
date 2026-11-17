// Autoteste do PACOTE (npm run autoteste, depois de npm run pack): o mesmo caminho do Claude Desktop, sem rede e sem WhatsApp.
//  1. Extrai whatsapp-pessoal.mcpb numa pasta temporária e confere o que vai dentro.
//  2. Sobe o servidor extraído por stdio como o Claude Desktop sobe (comando e env do manifest, com o padrão do campo
//     do limite), mais a trava de teste: WA_TESTE_CHAVE (cofre em memória, nunca o Keychain), WA_DADOS_DIR/WA_LOGS_DIR
//     (pasta temporária, nunca a de verdade) e WA_TESTE_SOCKET=falso (socket inerte no lugar da Baileys).
//     HOME também aponta para a pasta temporária, por garantia.
//  3. O processo do servidor roda com scripts/sem-rede.mjs (`node --import`): toda tentativa de rede é bloqueada e anotada.
//  4. Confere: ferramentas e roteiros, os dois endereços do cartão, wa_estado "não pareado", a Baileys e o WASM
//     carregados (o servidor compara md5/hkdf da ponte em WASM com o node:crypto e diz no stderr), o pareamento até o
//     QR FALSO como matriz no cartão, pelos dois caminhos (aba Code: wa_confirmar e wa_qr; conversa comum: clique e
//     wa_estado_pareamento_tela), sem o socket de teste falar com ninguém, e que nada tentou sair para a rede.
//  5. 0.6.0: sobe uma SEGUNDA cópia do servidor na mesma pasta e com a mesma chave (como o Claude Desktop faz com a
//     conversa comum e a aba Code). Ela vira leitora e repassa ao dono pelo canal local: pela leitora, prova o
//     pareamento (QR falso, "leitura" simulada pelo socket de teste) e uma resposta com o clique, sem rede.
//  6. Confere que WA_TESTE_SOCKET é recusado fora da trava.
//  7. 0.7.0, parte 3: o motor de transcrição nativo DESTA máquina carrega de dentro do pacote (sha256 conferido, nada no
//     stdout) e o wa_transcrever sem o modelo mostra o cartão de baixar (sem clicar: nada é baixado). Com
//     WA_TESTE_MODELO=<caminho do ggml-small-q5_1.bin> (e o áudio em WA_TESTE_AUDIO, ou <pasta do modelo>/../audio/a60.ogg),
//     transcreve de ponta a ponta um OGG de verdade pelo pacote, servido cifrado pela pasta de teste, e confere palavras.
//  8. 0.7.3: depois de derrubar as duas cópias, a caixa-preta (WA_LOGS_DIR) tem a saída de cada uma e nenhum arquivo
//     "vivo" sobrou.
// Nunca conecta ao WhatsApp, nunca gera QR de verdade e não toca na pasta de dados nem no Keychain de verdade.

import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { codigoDeConversa, codigoEditado } from "../ui/edicao.js";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");
const PACOTE = join(RAIZ, "whatsapp-pessoal.mcpb");
const SEM_REDE = pathToFileURL(join(RAIZ, "scripts", "sem-rede.mjs")).href;
const VERSAO = JSON.parse(readFileSync(join(RAIZ, "package.json"), "utf8")).version;
const CAPACIDADE_DE_TELA = { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } };

const DO_MODELO = [
  "wa_abrir_midia", "wa_anotar", "wa_apagar", "wa_aprender", "wa_atualizar_contatos", "wa_bloquear_conversas", "wa_buscar", "wa_buscar_historico", "wa_cancelar", "wa_como_eu_respondi", "wa_conferir_rascunho", "wa_confirmar", "wa_desconectar", "wa_editar",
  "wa_edicoes_dos_rascunhos", "wa_enviar_arquivo", "wa_envio", "wa_escolher_grupos", "wa_esquecer", "wa_estado", "wa_exemplos_do_meu_jeito", "wa_iniciar_conversa", "wa_ler_conversa", "wa_listar_conversas", "wa_listar_grupos",
  "wa_marcar_resumo", "wa_memoria", "wa_meu_jeito", "wa_parear", "wa_qr", "wa_reagir", "wa_responder", "wa_transcrever",
];
const NATIVOS = ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"];
const NATIVO_DAQUI = `${process.platform}-${process.arch}`;
// Parte 3: o modelo de verdade (opcional) e o áudio de teste. Sem WA_TESTE_MODELO, a transcrição de ponta a ponta é pulada.
const MODELO = process.env.WA_TESTE_MODELO ? process.env.WA_TESTE_MODELO : undefined;
const AUDIO = MODELO ? (process.env.WA_TESTE_AUDIO || join(dirname(MODELO), "..", "audio", "a60.ogg")) : undefined;
const PALAVRAS = ["Juliana", "Rodrigo", "orçamento", "condomínio"];
const ID_DO_AUDIO = "AUTOTESTEAUDIO01";
const DA_TELA = ["wa_cancelar_pedido", "wa_confirmar_tela", "wa_estado_pareamento_tela", "wa_estado_pedido_tela"];
const ROTEIROS = ["wa_caixa_do_dia", "wa_resumo_dos_grupos"];

if (!existsSync(PACOTE)) {
  console.error(`Autoteste: ${PACOTE} não existe. Rode npm run pack antes.`);
  process.exit(1);
}

const TEMP = mkdtempSync(join(tmpdir(), "wa-autoteste-"));
const EXTRAIDO = join(TEMP, "extensao");
const CASA = join(TEMP, "casa");
mkdirSync(EXTRAIDO);
mkdirSync(CASA);

const passos = [];
const passo = (nome) => passos.push(nome);

/** Todos os arquivos de uma pasta, com o caminho relativo. */
function arquivos(pasta) {
  return readdirSync(pasta, { recursive: true })
    .map(String)
    .filter((f) => statSync(join(pasta, f)).isFile())
    .sort();
}

/** O comando, os argumentos e o env do manifest, como o Claude Desktop monta (campo do usuário com o padrão). */
function comandoDoManifest(manifesto) {
  const cfg = manifesto.server.mcp_config;
  const trocar = (s) =>
    s.replaceAll("${__dirname}", EXTRAIDO).replace(/\$\{user_config\.([A-Z_]+)\}/g, (_, k) => String(manifesto.user_config[k].default ?? ""));
  return { comando: cfg.command, args: (cfg.args ?? []).map(trocar), env: Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, trocar(v)])) };
}

/** Ambiente mínimo do servidor: o do sistema, o do manifest e a casa temporária. */
const base = (envDoManifest) => ({ ...getDefaultEnvironment(), ...envDoManifest, HOME: CASA });

/** Roda `node <args>` e guarda o stdout e o stderr separados. */
function rodarCapturando(args) {
  return new Promise((pronto) => {
    const filho = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let saida = "";
    let erro = "";
    filho.stdout.on("data", (p) => (saida += p));
    filho.stderr.on("data", (p) => (erro += p));
    const relogio = setTimeout(() => filho.kill(), 30_000);
    filho.on("exit", (codigo) => {
      clearTimeout(relogio);
      pronto({ codigo, saida, erro });
    });
  });
}

/**
 * Cifra um áudio como o WhatsApp cifra (HKDF "WhatsApp Audio Keys", AES-256-CBC e HMAC-SHA256 de 10 bytes) e deixa a
 * mensagem para o socket do autoteste entregar e o arquivo cifrado para o "servidor de mídia" da pasta de teste.
 */
function prepararAudio(dirDados, plano, segundos) {
  const mediaKey = randomBytes(32);
  const k = Buffer.from(hkdfSync("sha256", mediaKey, Buffer.alloc(0), Buffer.from("WhatsApp Audio Keys"), 112));
  const [iv, cipherKey, macKey] = [k.subarray(0, 16), k.subarray(16, 48), k.subarray(48, 80)];
  const c = createCipheriv("aes-256-cbc", cipherKey, iv);
  const enc = Buffer.concat([c.update(plano), c.final()]);
  const arquivo = Buffer.concat([enc, createHmac("sha256", macKey).update(iv).update(enc).digest().subarray(0, 10)]);
  const caminho = `/v/t62.7117-24/${ID_DO_AUDIO}.enc?ccb=11-4`;
  mkdirSync(join(dirDados, "autoteste-midia"), { recursive: true });
  writeFileSync(join(dirDados, "autoteste-midia", `${ID_DO_AUDIO}.enc`), arquivo);
  const b64 = (b) => b.toString("base64");
  writeFileSync(
    join(dirDados, "autoteste-audio.json"),
    JSON.stringify({
      id: ID_DO_AUDIO,
      audioMessage: {
        mimetype: "audio/ogg; codecs=opus",
        url: `https://mmg.whatsapp.net${caminho}&mms3=true`,
        directPath: caminho,
        mediaKey: b64(mediaKey),
        fileSha256: b64(createHash("sha256").update(plano).digest()),
        fileEncSha256: b64(createHash("sha256").update(arquivo).digest()),
        fileLength: plano.length,
        seconds: segundos,
        ptt: true,
      },
    }),
  );
}

/** Sobe o servidor e espera ele sair sozinho (para as recusas). */
function rodarAteSair(args, env) {
  return new Promise((pronto) => {
    const filho = spawn(process.execPath, ["--import", SEM_REDE, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    let erro = "";
    filho.stderr.on("data", (parte) => (erro += parte));
    const relogio = setTimeout(() => filho.kill(), 10_000);
    filho.on("exit", (codigo) => {
      clearTimeout(relogio);
      pronto({ codigo, erro });
    });
  });
}

let cliente;
let leitora;
let stderr = "";
let stderrDaLeitora = "";
try {
  // 0. O bloqueio de rede funciona de verdade (senão "nada saiu" não provaria nada).
  const prova = execFileSync(
    process.execPath,
    ["--import", SEM_REDE, "-e", `
      const net = require("node:net");
      let bloqueios = 0;
      try { net.connect(443, "example.com"); } catch { bloqueios++; }
      fetch("https://example.com").catch(() => { bloqueios++; });
      require("node:dns").lookup("example.com", (e) => { if (e) bloqueios++; });
      setTimeout(() => console.log(bloqueios), 50);
    `],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(prova.trim(), "3", "o bloqueio de rede deixou passar algo");
  passo("bloqueio de rede (scripts/sem-rede.mjs) barra net.connect, fetch e DNS");

  // 1. Extrai o pacote e confere o conteúdo.
  execFileSync("/usr/bin/unzip", ["-q", PACOTE, "-d", EXTRAIDO]);
  const conteudo = arquivos(EXTRAIDO);
  const esperado = ["icon.png", "manifest.json", join("server", "index.mjs"), ...NATIVOS.map((n) => join("server", "nativo", n, "index.node"))].sort();
  assert.deepEqual(conteudo, esperado, `conteúdo inesperado: ${conteudo.join(", ")}`);
  const manifesto = JSON.parse(readFileSync(join(EXTRAIDO, "manifest.json"), "utf8"));
  assert.equal(manifesto.name, "whatsapp-pessoal");
  assert.equal(manifesto.display_name, "WhatsApp pessoal");
  assert.equal(manifesto.version, VERSAO);
  const desempacotado = conteudo.reduce((t, f) => t + statSync(join(EXTRAIDO, f)).size, 0);
  passo(`pacote extraído: só ${conteudo.join(", ")} (${(statSync(PACOTE).size / 1024 / 1024).toFixed(1)} MB zipado, ${(desempacotado / 1024 / 1024).toFixed(1)} MB aberto)`);

  const entrada = join(EXTRAIDO, manifesto.server.entry_point);
  const bundle = readFileSync(entrada, "utf8");
  assert.ok(!/sharp-(darwin|linux|win32)|sharp[^"']*\.node["']/.test(bundle), "o build leva o carregador nativo do sharp");
  // Parte 3: cada motor do pacote confere com o sha256 que o servidor confere antes de carregar.
  for (const n of NATIVOS) {
    const h = createHash("sha256").update(readFileSync(join(EXTRAIDO, "server", "nativo", n, "index.node"))).digest("hex");
    assert.ok(bundle.includes(`"${h}"`), `o sha256 do motor ${n} não está no servidor`);
  }
  passo(`motores de transcrição no pacote (${NATIVOS.join(", ")}), cada sha256 igual ao que o servidor confere`);
  // O motor desta máquina carrega de dentro do pacote, por caminho absoluto, sem escrever nada no stdout.
  if (NATIVOS.includes(NATIVO_DAQUI)) {
    const carga = await rodarCapturando([
      "-e",
      `const m = { exports: {} }; process.dlopen(m, ${JSON.stringify(join(EXTRAIDO, "server", "nativo", NATIVO_DAQUI, "index.node"))});
       if (typeof m.exports.WhisperContext !== "function") process.exit(2);
       process.stderr.write("motor-ok\\n");`,
    ]);
    assert.equal(carga.codigo, 0, `o motor ${NATIVO_DAQUI} não carregou: ${carga.erro}`);
    assert.match(carga.erro, /motor-ok/);
    assert.equal(carga.saida, "", `o motor escreveu no stdout: ${carga.saida.slice(0, 200)}`);
    passo(`motor nativo desta máquina (${NATIVO_DAQUI}) carregado do pacote por caminho absoluto, com WhisperContext e stdout vazio`);
  } else {
    passo(`motor nativo: não há motor para ${NATIVO_DAQUI} (só Mac e Windows); carga NÃO provada aqui`);
  }
  let sharpAchado = true;
  try {
    createRequire(entrada).resolve("sharp");
  } catch {
    sharpAchado = false;
  }
  assert.equal(sharpAchado, false, "sharp encontrado a partir do pacote extraído");
  assert.match(bundle, /import\("sharp"\)/, "a Baileys deveria tentar import('sharp') e seguir sem ele");
  passo("sharp fora do pacote: a Baileys tenta import(\"sharp\"), falha e segue (só usaria para miniatura de imagem enviada)");

  // 2. Sobe o servidor extraído.
  const { comando, args, env: envDoManifest } = comandoDoManifest(manifesto);
  assert.equal(comando, "node");
  assert.deepEqual(args, [entrada]);
  assert.deepEqual(envDoManifest, { WA_LIMITE_DIARIO: "30", WA_LIMITE_NOVAS_CONVERSAS: "5", WA_IDIOMA_TRANSCRICAO: "pt", WA_PEDIDOS_DE_HISTORICO_POR_DIA: "30", WA_INSTALACAO: "extensao" });
  const trava = {
    WA_TESTE_CHAVE: randomBytes(32).toString("hex"),
    WA_DADOS_DIR: join(TEMP, "dados"),
    WA_LOGS_DIR: join(TEMP, "logs"),
    WA_TESTE_SOCKET: "falso",
  };
  // Parte 3: o áudio que a "conexão" vai entregar (o de verdade com o modelo; senão, um OGG/Opus mínimo que nunca é baixado).
  mkdirSync(trava.WA_DADOS_DIR, { recursive: true });
  if (MODELO) {
    assert.ok(existsSync(MODELO), `WA_TESTE_MODELO não existe: ${MODELO}`);
    assert.ok(existsSync(AUDIO), `o áudio de teste não existe: ${AUDIO}`);
    mkdirSync(join(trava.WA_DADOS_DIR, "modelos"), { recursive: true });
    const destino = join(trava.WA_DADOS_DIR, "modelos", "ggml-small-q5_1.bin");
    try {
      linkSync(MODELO, destino);
    } catch {
      copyFileSync(MODELO, destino);
    }
    prepararAudio(trava.WA_DADOS_DIR, readFileSync(AUDIO), 60);
  } else {
    const ogg = Buffer.alloc(64);
    ogg.write("OggS", 0, "latin1");
    ogg.write("OpusHead", 28, "latin1");
    prepararAudio(trava.WA_DADOS_DIR, ogg, 3);
  }
  const errosDoStdio = [];
  cliente = new Client({ name: "autoteste-whatsapp-pessoal", version: "1.0.0" }, { capabilities: CAPACIDADE_DE_TELA });
  const transporte = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SEM_REDE, ...args],
    env: { ...base(envDoManifest), ...trava },
    cwd: EXTRAIDO,
    stderr: "pipe",
  });
  transporte.stderr?.on("data", (parte) => (stderr += parte));
  await cliente.connect(transporte);
  // Qualquer linha que não seja JSON-RPC no stdout do servidor (ex.: log do motor nativo) aparece aqui como erro.
  const onerrorOriginal = transporte.onerror;
  transporte.onerror = (erro) => {
    errosDoStdio.push(String(erro?.message ?? erro));
    onerrorOriginal?.(erro);
  };
  assert.equal(cliente.getServerVersion()?.version, VERSAO);
  assert.match(cliente.getInstructions() ?? "", /conteudo_de_terceiros/);
  passo(`servidor do pacote no ar por stdio (versão ${VERSAO}, com instruções)`);

  // 3. Ferramentas e roteiros.
  const { tools } = await cliente.listTools();
  const nomes = tools.map((t) => t.name).sort();
  assert.deepEqual(nomes, [...DO_MODELO, ...DA_TELA].sort());
  for (const t of tools) {
    assert.ok(t.title || t.annotations?.title, `${t.name} sem título`);
    assert.ok(t.description, `${t.name} sem descrição`);
    for (const chave of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof t.annotations?.[chave], "boolean", `${t.name}: anotação ${chave} ausente`);
    }
  }
  const daTela = tools.filter((t) => JSON.stringify(t._meta?.ui?.visibility) === '["app"]').map((t) => t.name).sort();
  assert.deepEqual(daTela, DA_TELA);
  assert.deepEqual(manifesto.tools.map((t) => t.name).sort(), [...DO_MODELO].sort(), "o manifest lista outras ferramentas");
  passo(`${tools.length} ferramentas (${DO_MODELO.length} do modelo, iguais às do manifest, e ${DA_TELA.length} só do cartão)`);
  const { prompts } = await cliente.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ROTEIROS);
  passo(`roteiros: ${ROTEIROS.join(", ")}`);

  // 4. Os dois endereços do cartão.
  const comVersao = `ui://whatsapp/confirmar-v${VERSAO.replaceAll(".", "-")}.html`;
  const telas = [];
  for (const uri of [comVersao, "ui://whatsapp/confirmar.html"]) {
    const r = await cliente.readResource({ uri });
    assert.equal(r.contents[0].mimeType, "text/html;profile=mcp-app", uri);
    assert.ok(r.contents[0].text.includes(`v${VERSAO}</p>`), `${uri} sem a versão no rodapé`);
    assert.match(r.contents[0].text, /wa_confirmar_tela/);
    telas.push(r.contents[0].text);
  }
  assert.equal(telas[0], telas[1], "os dois endereços servem cartões diferentes");
  const anunciado = tools.find((t) => t.name === "wa_responder")._meta?.ui?.resourceUri;
  assert.equal(anunciado, comVersao);
  passo(`cartão nos dois endereços (${comVersao} e ui://whatsapp/confirmar.html), rodapé v${VERSAO}`);

  // 5. wa_estado sem sessão.
  const estado = await cliente.callTool({ name: "wa_estado", arguments: {} });
  assert.ok(!estado.isError, JSON.stringify(estado.content));
  const e = estado.structuredContent;
  assert.equal(e.situacao, "nao_pareado");
  assert.equal(e.conectado, false);
  assert.equal(e.papel, "dono_da_conexao");
  assert.equal(e.limite_diario, 30, "o padrão do campo do limite não chegou");
  assert.equal(e.envio_ligado, false);
  assert.equal(e.versao, VERSAO);
  assert.match(String(e.para_o_claude), /wa_parear/);
  passo("wa_estado: nao_pareado, dono da conexão, envio desligado, limite 30 (padrão do campo)");

  // 6. A Baileys e o WASM carregaram dentro do pacote.
  assert.match(stderr, /autoteste: socket falso; WASM da Baileys: md5 ok, hkdf ok/, `sem a conferência do WASM no stderr:\n${stderr}`);
  passo("Baileys e WASM (whatsapp-rust-bridge) carregados: md5 e hkdf da ponte iguais aos do node:crypto");

  // 7. Pareamento até o QR FALSO no cartão (o socket de teste não fala com ninguém), pelos dois caminhos.
  const matrizValida = (m) =>
    m && Number.isInteger(m.tamanho) && m.tamanho >= 21 && Array.isArray(m.linhas) && m.linhas.length === m.tamanho && m.linhas.every((l) => new RegExp(`^[01]{${m.tamanho}}$`).test(l));
  const semQr = (r) => !JSON.stringify(r.structuredContent ?? {}).includes("AUTOTESTE-NAO-E-QR") && !JSON.stringify(r.content ?? []).includes("AUTOTESTE-NAO-E-QR");
  //   7a. Aba Code (cartão sem serverTools): o clique manda o código no chat e o modelo chama wa_confirmar.
  const previa = await cliente.callTool({ name: "wa_parear", arguments: {} });
  assert.ok(!previa.isError, JSON.stringify(previa.content));
  assert.equal(previa._meta?.previa?.botao, "Entendo o risco, mostrar o QR");
  // 0.16.0: pelo chat vai o código DE CONVERSA (o cartão o calcula do de tela, o do `_meta`); o de tela é recusado.
  const pedido = { id: previa.structuredContent.pedido, codigo: codigoDeConversa(previa._meta.codigo) };
  const deTela = await cliente.callTool({ name: "wa_confirmar", arguments: { id: pedido.id, codigo: previa._meta.codigo } });
  assert.ok(deTela.isError, "o wa_confirmar aceitou o código de tela do `_meta`");
  const peloChat = await cliente.callTool({ name: "wa_confirmar", arguments: pedido });
  assert.ok(!peloChat.isError, JSON.stringify(peloChat.content));
  assert.equal(peloChat.structuredContent?.etapa, "qr");
  assert.equal(peloChat._meta?.pareamento?.pedido, pedido.id);
  assert.ok(matrizValida(peloChat._meta?.qr_matriz), "o cartão do wa_confirmar não trouxe a matriz do QR");
  assert.match(String(peloChat.structuredContent?.para_o_claude), /wa_qr/);
  assert.ok(semQr(peloChat) && !JSON.stringify(peloChat.structuredContent).includes("linhas"), "o QR chegou ao modelo");
  const novoQr = await cliente.callTool({ name: "wa_qr", arguments: { pedido: pedido.id } });
  assert.ok(!novoQr.isError, JSON.stringify(novoQr.content));
  assert.ok(matrizValida(novoQr._meta?.qr_matriz) && semQr(novoQr));
  passo("aba Code: wa_confirmar começa o pareamento e desenha o cartão com o QR falso (matriz só no _meta); wa_qr mostra o QR atual");
  //   7b. Conversa comum (cartão com serverTools): clique e consulta pelo cartão.
  const outra = await cliente.callTool({ name: "wa_parear", arguments: {} });
  const pedido2 = { id: outra.structuredContent.pedido, codigo: outra._meta.codigo };
  const clique = await cliente.callTool({ name: "wa_confirmar_tela", arguments: pedido2 });
  assert.ok(!clique.isError, JSON.stringify(clique.content));
  let qr;
  for (let i = 0; i < 50; i++) {
    qr = await cliente.callTool({ name: "wa_estado_pareamento_tela", arguments: { id: pedido2.id } });
    if (qr.structuredContent?.etapa === "qr") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(qr.structuredContent?.etapa, "qr");
  assert.ok(matrizValida(qr._meta?.qr_matriz), "sem a matriz do QR");
  assert.equal(qr._meta?.qr_imagem, undefined, "imagem em data URL não existe mais");
  assert.ok(semQr(qr), "o texto do QR chegou ao modelo");
  const recusa = await cliente.callTool({ name: "wa_responder", arguments: { conversa: "5511900000000", texto: "x" } });
  assert.equal(recusa.isError, true, "wa_responder sem sessão deveria recusar");
  passo("conversa comum: clique, QR falso como matriz só no _meta de wa_estado_pareamento_tela; wa_responder recusa");

  // 7c. 0.6.0: a segunda cópia (leitora) na mesma pasta, com a mesma chave. Tudo passa por ela; o dono executa.
  const lock = JSON.parse(readFileSync(join(trava.WA_DADOS_DIR, "conexao.lock"), "utf8"));
  assert.match(String(lock.canal), /(canal|whatsapp-claude)-[0-9a-f]{16}\.sock$/, "o lock do dono não traz o endereço do canal");
  leitora = new Client({ name: "autoteste-aba-code", version: "1.0.0" }, { capabilities: CAPACIDADE_DE_TELA });
  const transporteB = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", SEM_REDE, ...args],
    env: { ...base(envDoManifest), ...trava },
    cwd: EXTRAIDO,
    stderr: "pipe",
  });
  transporteB.stderr?.on("data", (parte) => (stderrDaLeitora += parte));
  await leitora.connect(transporteB);
  const chamarB = async (name, a = {}) => {
    const r = await leitora.callTool({ name, arguments: a });
    assert.ok(!r.isError, `${name} pela leitora: ${JSON.stringify(r.content)}`);
    return r;
  };
  const estadoB = await chamarB("wa_estado");
  assert.equal(estadoB.structuredContent.por_outra_sessao_do_claude, true, "o wa_estado da leitora não veio do dono");
  assert.match(String(estadoB.structuredContent.para_o_claude), /outra sessão do Claude/);
  passo("segunda cópia na mesma pasta: vira leitora e o wa_estado dela vem do dono pelo canal (por_outra_sessao_do_claude)");

  const previaB = await chamarB("wa_parear");
  const qrB = await chamarB("wa_confirmar", { id: previaB.structuredContent.pedido, codigo: codigoDeConversa(previaB._meta.codigo) });
  assert.equal(qrB.structuredContent?.etapa, "qr");
  assert.ok(matrizValida(qrB._meta?.qr_matriz) && semQr(qrB), "o QR pela leitora não veio como matriz só no _meta");
  writeFileSync(join(trava.WA_DADOS_DIR, "autoteste-qr-lido"), "");
  let conectado;
  for (let i = 0; i < 150 && !conectado?.conectado; i++) {
    await new Promise((r) => setTimeout(r, 100));
    conectado = (await chamarB("wa_estado")).structuredContent;
  }
  assert.equal(conectado?.conectado, true, `o pareamento pela leitora não conectou: ${JSON.stringify(conectado)}`);
  passo("pareamento pela leitora: wa_parear, wa_confirmar com o QR falso (matriz), \"leitura\" simulada e conectado");

  const envioB = await chamarB("wa_envio", { ligar: true });
  await chamarB("wa_confirmar_tela", { id: envioB.structuredContent.pedido, codigo: envioB._meta.codigo });
  let conversaB;
  for (let i = 0; i < 50 && !conversaB; i++) {
    const lista = (await chamarB("wa_listar_conversas")).structuredContent;
    conversaB = (lista.conversas ?? [])[0]?.id;
    if (!conversaB) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(conversaB, "a mensagem falsa não chegou à lista pela leitora");
  const texto = "Resposta do autoteste";
  const respostaB = await chamarB("wa_responder", { conversa: conversaB, texto });
  const enviadaB = await chamarB("wa_confirmar_tela", { id: respostaB.structuredContent.pedido, codigo: codigoEditado(respostaB._meta.codigo, texto), texto });
  assert.equal(typeof enviadaB.structuredContent?.resultado?.mensagem_id, "string", `a resposta pela leitora não saiu: ${JSON.stringify(enviadaB.structuredContent)}`);
  passo("resposta pela leitora: wa_envio e wa_responder com o clique, enviados pelo socket de teste do dono (mensagem_id)");

  // 0.7.0: uma reação (direta, sem cartão) pela leitora, na mensagem falsa que chegou.
  const reacaoB = await chamarB("wa_reagir", { conversa: conversaB, mensagem: "AUTOTESTE00000001", emoji: "👍" });
  assert.equal(reacaoB.structuredContent?.reacao, "feita", `a reação pela leitora não saiu: ${JSON.stringify(reacaoB.structuredContent ?? reacaoB.content)}`);
  passo("0.7.0: wa_reagir pela leitora, direto, pelo socket de teste do dono");

  // 0.7.0, parte 2: wa_abrir_midia pela leitora numa mensagem de texto recusa sem baixar nada (o download de verdade
  // falaria com o servidor de mídia do WhatsApp; aqui a rede está bloqueada e nada é baixado).
  const semMidia = await leitora.callTool({ name: "wa_abrir_midia", arguments: { conversa: conversaB, mensagem: "AUTOTESTE00000001" } });
  assert.equal(semMidia.isError, true, "wa_abrir_midia numa mensagem de texto deveria recusar");
  assert.match(JSON.stringify(semMidia.structuredContent), /não é mídia/);
  assert.ok(!existsSync(join(CASA, "Downloads")), "a recusa não deveria criar a pasta Downloads");
  passo("0.7.0, parte 2: wa_abrir_midia pela leitora recusa mensagem sem mídia, sem baixar nem criar arquivo");

  // 0.8.0: a busca do servidor do pacote (sem acento, prefixo no último termo) e o motor que ele escolheu na partida.
  const achou = await chamarB("wa_buscar", { texto: "MENSAGEM fals" });
  assert.deepEqual((achou.structuredContent?.resultados ?? []).map((r) => r.mensagem_id), ["AUTOTESTE00000001"], `a busca não achou a mensagem falsa: ${JSON.stringify(achou.structuredContent)}`);
  const motorDaBusca = (await chamarB("wa_estado")).structuredContent?.busca;
  assert.ok(["fts5", "varredura"].includes(motorDaBusca?.motor), `wa_estado sem busca.motor: ${JSON.stringify(motorDaBusca)}`);
  if (motorDaBusca.motor === "fts5") assert.equal(achou.structuredContent.caminho, "indice", "com fts5, a busca deveria vir do índice");
  // O node:sqlite vem do próprio Node (process.getBuiltinModule), nunca empacotado nem importado de forma estática.
  assert.match(bundle, /getBuiltinModule\?\.\(["']node:sqlite["']\)/, "o servidor não carrega o node:sqlite do Node");
  assert.ok(!/from\s*["']node:sqlite["']|import\(["']node:sqlite["']\)/.test(bundle), "node:sqlite importado de forma estática no bundle");
  passo(`0.8.0: wa_buscar pela leitora acha a mensagem falsa (caminho ${achou.structuredContent.caminho}); motor da busca do pacote: ${motorDaBusca.motor} (trigram ${motorDaBusca.trigram ? "sim" : "não"})`);

  // Miniatura: uma foto PNG feita aqui (sem rede, sem biblioteca), enviada pela leitora com o clique. A miniatura é gerada
  // DENTRO do server/index.mjs empacotado (jimp magro no bundle), e o resultado diz o tamanho da foto.
  // 0.16.0: só sai arquivo das pastas permitidas da casa (aqui, a casa temporária do HOME).
  mkdirSync(join(CASA, "Pictures"), { recursive: true });
  const foto = join(CASA, "Pictures", "foto-do-autoteste.png");
  writeFileSync(foto, pngDeTeste(48, 24));
  const previaFoto = await chamarB("wa_enviar_arquivo", { conversa: conversaB, arquivo: foto });
  assert.match(String(previaFoto._meta?.previa?.arquivo?.imagem), /^data:image\/png;base64,/, "o cartão não trouxe a foto");
  const enviadaFoto = await chamarB("wa_confirmar_tela", { id: previaFoto.structuredContent.pedido, codigo: codigoEditado(previaFoto._meta.codigo, ""), texto: "" });
  assert.deepEqual(enviadaFoto.structuredContent?.resultado?.miniatura, { largura: 48, altura: 24 }, `a miniatura não foi gerada no pacote: ${JSON.stringify(enviadaFoto.structuredContent)}`);
  passo("miniatura: foto PNG enviada pela leitora com o clique; miniatura JPEG gerada no pacote (48x24), foto no cartão");

  // 0.7.0, parte 3: wa_transcrever pela leitora (o dono transcreve).
  if (!MODELO) {
    const cartao = await chamarB("wa_transcrever", { conversa: conversaB, mensagem: ID_DO_AUDIO });
    assert.equal(cartao._meta?.previa?.tipo, "modelo", `sem o modelo, o wa_transcrever deveria mostrar o cartão: ${JSON.stringify(cartao.structuredContent)}`);
    assert.match(cartao._meta.previa.detalhes.join(" "), /190 MB, de huggingface\.co, uma vez só/);
    assert.ok(!existsSync(join(trava.WA_DADOS_DIR, "modelos")), "a pasta do modelo foi criada sem o clique");
    passo("0.7.0, parte 3: sem o modelo, wa_transcrever pela leitora mostra o cartão \"190 MB, de huggingface.co, uma vez só\" (sem clicar: nada baixado)");
    passo("transcrição de ponta a ponta PULADA: sem WA_TESTE_MODELO (rode com WA_TESTE_MODELO=<caminho do ggml-small-q5_1.bin>)");
  } else {
    const t0 = Date.now();
    let r = await chamarB("wa_transcrever", { conversa: conversaB, mensagem: ID_DO_AUDIO });
    for (let i = 0; i < 60 && r.structuredContent?.situacao === "em_andamento"; i++) {
      await new Promise((p) => setTimeout(p, 1000));
      r = await chamarB("wa_transcrever", { conversa: conversaB, mensagem: ID_DO_AUDIO });
    }
    assert.equal(r.structuredContent?.situacao, "pronta", `a transcrição não ficou pronta: ${JSON.stringify(r.structuredContent)}`);
    const texto = String(r.structuredContent.conteudo_de_terceiros?.transcricao ?? "");
    const faltam = PALAVRAS.filter((p) => !texto.toLowerCase().includes(p.toLowerCase()));
    assert.ok(faltam.length <= 1, `faltam palavras esperadas (${faltam.join(", ")}) em: ${texto}`);
    assert.match(String(r.structuredContent.para_o_claude), /AUTOMÁTICA/);
    const lida = await chamarB("wa_ler_conversa", { conversa: conversaB });
    const doAudio = lida.structuredContent.mensagens.find((x) => x.id === ID_DO_AUDIO);
    assert.equal(doAudio?.conteudo_de_terceiros?.transcricao_automatica, texto, "a transcrição não ficou guardada com a mensagem");
    passo(
      `transcrição de ponta a ponta pelo pacote (whisper.cpp nativo, ${NATIVO_DAQUI}): áudio de ${r.structuredContent.duracao_s} s em ${((Date.now() - t0) / 1000).toFixed(1)} s ` +
        `(motor ${r.structuredContent.tempo_gasto_s} s), ${PALAVRAS.length - faltam.length} de ${PALAVRAS.length} palavras esperadas${faltam.length ? ` (faltou: ${faltam.join(", ")})` : ""}, guardada e mostrada no wa_ler_conversa`,
    );
  }

  await leitora.close();
  leitora = undefined;
  assert.ok(!stderrDaLeitora.includes("SEM-REDE: tentativa"), `a leitora tentou sair para a rede:\n${stderrDaLeitora}`);
  assert.match(stderrDaLeitora, /SEM-REDE: ativo/, "o bloqueio de rede não carregou na leitora");

  await cliente.close();
  cliente = undefined;

  // 0.7.3: as duas cópias foram derrubadas (entrada padrão fechada pelo cliente): a caixa-preta do autoteste tem a
  // partida, a saída com o motivo e o "saiu" com o código de cada uma, e nenhum arquivo "vivo" sobrou.
  const caixaPreta = join(trava.WA_LOGS_DIR, "caixa-preta.jsonl");
  assert.ok(existsSync(caixaPreta), "a caixa-preta do autoteste não foi criada");
  const linhasDaCaixa = readFileSync(caixaPreta, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const pids = [...new Set(linhasDaCaixa.filter((l) => l.evento === "partida").map((l) => l.pid))];
  assert.equal(pids.length, 2, `a caixa-preta deveria ter a partida das duas cópias: ${JSON.stringify(linhasDaCaixa)}`);
  for (const pid of pids) {
    const saindo = linhasDaCaixa.find((l) => l.pid === pid && l.evento === "saindo");
    const saiu = linhasDaCaixa.find((l) => l.pid === pid && l.evento === "saiu");
    assert.ok(saindo && typeof saindo.motivo === "string", `sem a linha de saída (saindo) da cópia ${pid}`);
    assert.ok(saiu && saiu.codigo === 0 && saiu.versao === VERSAO, `sem a linha "saiu" (código 0) da cópia ${pid}`);
  }
  assert.ok(linhasDaCaixa.some((l) => l.evento === "papel_definido" && l.papel === "leitor"), "a caixa-preta não viu a leitora");
  assert.deepEqual(readdirSync(trava.WA_LOGS_DIR).filter((n) => n.startsWith("vivo-")), [], "sobrou arquivo vivo depois da saída limpa");
  const motivos = pids.map((pid) => linhasDaCaixa.find((l) => l.pid === pid && l.evento === "saindo").motivo).join(", ");
  passo(`0.7.3: caixa-preta do autoteste com a partida, a saída (${motivos}) e o "saiu" com código 0 das duas cópias; nenhum arquivo vivo sobrou`);

  assert.deepEqual(errosDoStdio, [], `o stdout do servidor teve algo que não é JSON-RPC: ${errosDoStdio.join(" | ")}`);
  passo(`stdout do servidor só com JSON-RPC${MODELO ? " (inclusive com o motor nativo transcrevendo)" : ""}`);

  // 8. Nada saiu para a rede.
  assert.match(stderr, /SEM-REDE: ativo/, "o bloqueio de rede não carregou no servidor");
  assert.ok(!stderr.includes("SEM-REDE: tentativa"), `o servidor tentou sair para a rede:\n${stderr}`);
  passo("nenhuma tentativa de rede (net, DNS, fetch, WebSocket) durante todo o teste");

  // 9. As pastas de verdade não foram tocadas: tudo ficou na pasta temporária.
  assert.ok(existsSync(join(TEMP, "dados")), "a pasta de dados de teste não foi criada");
  assert.ok(!existsSync(join(CASA, "Library")), "algo foi gravado na casa (pasta de dados padrão)");
  passo("dados só na pasta temporária");

  // 10. WA_TESTE_SOCKET fora da trava: o servidor não sobe.
  for (const [nome, extra] of [
    ["sem a trava", { WA_TESTE_SOCKET: "falso" }],
    ["sem WA_DADOS_DIR", { WA_TESTE_SOCKET: "falso", WA_TESTE_CHAVE: trava.WA_TESTE_CHAVE }],
    ["com outro valor", { ...trava, WA_TESTE_SOCKET: "real" }],
  ]) {
    const r = await rodarAteSair(args, { ...base(envDoManifest), ...extra });
    assert.equal(r.codigo, 1, `${nome}: deveria sair com código 1`);
    assert.match(r.erro, /WA_TESTE_SOCKET só vale no autoteste/, nome);
    assert.ok(!r.erro.includes("SEM-REDE: tentativa"), nome);
  }
  passo("WA_TESTE_SOCKET recusado fora da trava (sem a trava, sem WA_DADOS_DIR, valor diferente de \"falso\")");


  for (const nome of passos) console.error(`  ok  ${nome}`);
  console.error(`Autoteste do pacote passou (${passos.length} verificações).`);
} catch (erro) {
  for (const nome of passos) console.error(`  ok  ${nome}`);
  console.error(`Autoteste FALHOU: ${erro instanceof Error ? erro.message : String(erro)}`);
  if (stderr) console.error(`--- stderr do servidor ---\n${stderr}`);
  if (stderrDaLeitora) console.error(`--- stderr da leitora ---\n${stderrDaLeitora}`);
  process.exitCode = 1;
} finally {
  await leitora?.close().catch(() => {});
  await cliente?.close().catch(() => {});
  rmSync(TEMP, { recursive: true, force: true });
}

/** Um PNG RGB de `l` x `a` pixels, feito à mão (zlib do Node): sem biblioteca de imagem no autoteste. */
function pngDeTeste(l, a) {
  const bloco = (tipo, dados) => {
    const t = Buffer.from(tipo, "latin1");
    const tam = Buffer.alloc(4);
    tam.writeUInt32BE(dados.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, dados])) >>> 0);
    return Buffer.concat([tam, t, dados, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(l, 0);
  ihdr.writeUInt32BE(a, 4);
  ihdr[8] = 8; // bits
  ihdr[9] = 2; // RGB
  const linhas = [];
  for (let y = 0; y < a; y++) {
    const linha = Buffer.alloc(1 + l * 3);
    for (let x = 0; x < l; x++) linha.set([x * 5, y * 10, 128], 1 + x * 3);
    linhas.push(linha);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), bloco("IHDR", ihdr), bloco("IDAT", deflateSync(Buffer.concat(linhas))), bloco("IEND", Buffer.alloc(0))]);
}

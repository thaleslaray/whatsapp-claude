#!/usr/bin/env node
// Chama ferramentas do servidor RECÉM-CONSTRUÍDO (mcpb/server/index.mjs) contra os dados REAIS deste computador, sem
// reinstalar a extensão. Por quê: o teste com as conversas de verdade só existia dentro do Claude Desktop, e cada
// ajuste pedia uma instalação. O dono autorizou este atalho para teste (14/11/2026).
//
// - O servidor sobe como mais uma cópia: com o Claude Desktop aberto, a trava da conexão é dele e esta cópia vira
//   LEITORA (lê os mesmos arquivos cifrados; a chave vem do cofre do sistema pelo próprio servidor, nunca aparece aqui).
// - Leituras rodam com o código novo (WA_LEITURA_LOCAL=1 impede o repasse ao dono). Escritas (wa_anotar, wa_marcar_resumo...) vão pelo canal para a cópia do Claude
//   Desktop, ou seja, rodam com o código INSTALADO.
// - Recusa rodar se esta cópia virar a dona da conexão (Claude Desktop fechado): aí ela falaria com o WhatsApp.
//
// Uso: node scripts/chamar.mjs '[{"name":"wa_estado","arguments":{}}, {"name":"wa_buscar","arguments":{"texto":"x"}}]'
//      node scripts/chamar.mjs --ferramentas        (lista os nomes e os parâmetros que o servidor novo anuncia)

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const servidor = join(raiz, "mcpb", "server", "index.mjs");
const arg = process.argv[2];
if (!arg) {
  console.error("Passe a lista de chamadas em JSON, ou --ferramentas.");
  process.exit(2);
}

const cliente = new Client({ name: "chamar-real", version: "1.0.0" }, { capabilities: {} });
await cliente.connect(new StdioClientTransport({ command: process.execPath, args: [servidor], env: { ...getDefaultEnvironment(), WA_LEITURA_LOCAL: "1" }, stderr: "ignore" }));
const texto = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
const json = (r) => {
  try {
    return JSON.parse(texto(r));
  } catch {
    return { erro: r.isError === true, texto: texto(r) };
  }
};

try {
  if (arg === "--ferramentas") {
    const { tools } = await cliente.listTools();
    for (const t of tools) console.log(`${t.name}: ${Object.keys(t.inputSchema?.properties ?? {}).join(", ")}`);
  } else {
    const estado = json(await cliente.callTool({ name: "wa_estado", arguments: {} }));
    // Com a leitura local, o wa_estado é o DESTA cópia: tem de dizer "leitor".
    if (estado.papel !== "leitor") {
      console.error("Esta cópia não é leitora (o Claude Desktop não está com a conexão). Parei para não falar com o WhatsApp por aqui.");
      process.exitCode = 3;
    } else {
      for (const c of JSON.parse(arg)) {
        const inicio = Date.now();
        const r = await cliente.callTool({ name: c.name, arguments: c.arguments ?? {} });
        console.log(JSON.stringify({ chamada: c, ms: Date.now() - inicio, erro: r.isError === true, resposta: json(r) }));
      }
    }
  }
} finally {
  await cliente.close();
}

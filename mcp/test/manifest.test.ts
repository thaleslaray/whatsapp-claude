// Fase 3: o manifest do .mcpb (lição do Instagram: nome sem acento), a versão igual em todo lugar,
// o campo do limite diário com a faixa certa e a trava do socket de teste do autoteste.
// 0.5.0: Mac e Windows e a ferramenta wa_qr; sem campo de senha (a chave vai para o cofre do sistema).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ErroConfig, LIMITE_DIARIO_MAXIMO, LIMITE_DIARIO_PADRAO, LIMITE_NOVAS_CONVERSAS_MAXIMO, LIMITE_NOVAS_CONVERSAS_PADRAO, lerConfig, lerLimiteDiario, lerLimiteNovasConversas } from "../src/config.ts";
import { HTML_CONFIRMAR } from "../src/ui-gerada.ts";
import { VERSAO_SERVIDOR } from "../src/versao.ts";
import { conferirWasm } from "../src/wasm.ts";
import { conectarCliente, montar } from "./ajuda.ts";

const ler = (caminho: string) => readFileSync(new URL(caminho, import.meta.url));
const manifesto = JSON.parse(ler("../mcpb/manifest.json").toString("utf8"));
const pacote = JSON.parse(ler("../package.json").toString("utf8"));
const bloqueio = JSON.parse(ler("../package-lock.json").toString("utf8"));

describe("mcpb/manifest.json", () => {
  it("nome e nome de exibição sem acento (o Claude Desktop se perde com acento), descrição honesta e autor", () => {
    assert.equal(manifesto.manifest_version, "0.4");
    assert.equal(manifesto.name, "whatsapp-pessoal");
    assert.equal(manifesto.display_name, "WhatsApp pessoal");
    for (const campo of ["name", "display_name"]) assert.match(manifesto[campo], /^[\x20-\x7e]+$/, `${campo} com caractere fora do ASCII`);
    assert.match(manifesto.description, /não oficial/);
    assert.match(manifesto.description, /pessoal/);
    assert.match(manifesto.long_description, /viola os termos/);
    assert.ok(manifesto.description.length <= 200, "descrição curta");
    assert.equal(manifesto.author.name, "Thales Laray");
    assert.deepEqual(manifesto.compatibility, { platforms: ["darwin", "win32"], runtimes: { node: ">=22.0.0" } });
    const textos = [manifesto.description, manifesto.long_description, ...Object.values(manifesto.user_config).map((c) => JSON.stringify(c)), ...manifesto.tools.map((t: { description: string }) => t.description)];
    for (const t of textos) assert.ok(!/\bMac\b(?! e no Windows)|Keychain|[Ss]enha/.test(t), `texto que só serve ao Mac (ou fala em senha): ${t}`);
    assert.equal(manifesto.server.type, "node");
    assert.equal(manifesto.server.entry_point, "server/index.mjs");
    assert.equal(manifesto.server.mcp_config.command, "node");
    assert.deepEqual(manifesto.server.mcp_config.args, ["${__dirname}/server/index.mjs"]);
  });

  it("a versão é a mesma no manifest, no package.json (e no lock), no versao.ts e no rodapé do cartão", () => {
    assert.equal(manifesto.version, "0.17.1");
    assert.equal(pacote.version, manifesto.version);
    assert.equal(bloqueio.version, manifesto.version);
    assert.equal(bloqueio.packages[""].version, manifesto.version);
    assert.equal(VERSAO_SERVIDOR, manifesto.version);
    assert.ok(HTML_CONFIRMAR.includes(`v${manifesto.version}</p>`), "rodapé do cartão com a versão");
  });

  it("três campos: o limite de respostas por dia (1 a 200, padrão 30), desde a 0.7.0 o de conversas novas por dia (0 a 20, padrão 5) e o idioma da transcrição (padrão pt); nenhum secreto (a chave vai para o cofre do sistema, sem campo)", () => {
    assert.deepEqual(Object.keys(manifesto.user_config), ["WA_LIMITE_DIARIO", "WA_LIMITE_NOVAS_CONVERSAS", "WA_IDIOMA_TRANSCRICAO", "WA_PEDIDOS_DE_HISTORICO_POR_DIA"]);
    const idioma = manifesto.user_config.WA_IDIOMA_TRANSCRICAO;
    assert.equal(idioma.type, "string");
    assert.equal(idioma.default, "pt");
    assert.equal(idioma.required, false);
    assert.notEqual(idioma.sensitive, true);
    assert.match(idioma.title, /^[\x20-\x7e]+$/);
    assert.match(idioma.description, /pt, en, es ou auto/);
    const novas = manifesto.user_config.WA_LIMITE_NOVAS_CONVERSAS;
    assert.equal(novas.type, "number");
    assert.equal(novas.min, 0);
    assert.equal(novas.max, LIMITE_NOVAS_CONVERSAS_MAXIMO);
    assert.equal(novas.max, 20);
    assert.equal(novas.default, LIMITE_NOVAS_CONVERSAS_PADRAO);
    assert.equal(novas.default, 5);
    assert.equal(novas.required, false);
    assert.notEqual(novas.sensitive, true);
    assert.match(novas.title, /^[\x20-\x7e]+$/);
    assert.match(novas.description, /0 desliga/);
    const campo = manifesto.user_config.WA_LIMITE_DIARIO;
    assert.equal(campo.type, "number");
    assert.equal(campo.min, 1);
    assert.equal(campo.max, LIMITE_DIARIO_MAXIMO);
    assert.equal(campo.max, 200);
    assert.equal(campo.default, LIMITE_DIARIO_PADRAO);
    assert.equal(campo.default, 30);
    assert.equal(campo.required, false);
    assert.notEqual(campo.sensitive, true);
    assert.match(campo.title, /^[\x20-\x7e]+$/);
    // O env só leva os campos e a marca da extensão: nada de variável de teste no pacote.
    assert.deepEqual(manifesto.server.mcp_config.env, {
      WA_LIMITE_DIARIO: "${user_config.WA_LIMITE_DIARIO}",
      WA_LIMITE_NOVAS_CONVERSAS: "${user_config.WA_LIMITE_NOVAS_CONVERSAS}",
      WA_IDIOMA_TRANSCRICAO: "${user_config.WA_IDIOMA_TRANSCRICAO}",
      WA_PEDIDOS_DE_HISTORICO_POR_DIA: "${user_config.WA_PEDIDOS_DE_HISTORICO_POR_DIA}",
      WA_INSTALACAO: "extensao",
    });
  });


  it("o servidor lê o campo do limite como o Claude Desktop o manda", () => {
    const avisos: string[] = [];
    assert.equal(lerLimiteDiario("30", avisos), 30);
    assert.equal(lerLimiteDiario("1", avisos), 1);
    assert.equal(lerLimiteDiario("200", avisos), 200);
    assert.equal(lerLimiteDiario("45.0", avisos), 45, "número inteiro escrito com casa decimal");
    assert.equal(lerLimiteDiario("", avisos), 30, "campo em branco");
    assert.deepEqual(avisos, []);
    assert.equal(lerLimiteDiario("0", avisos), 30);
    assert.equal(lerLimiteDiario("12.5", avisos), 30);
    assert.equal(lerLimiteDiario("201", avisos), 200);
    assert.equal(avisos.length, 3, "valores fora da faixa avisam no wa_estado");
    assert.equal(lerConfig({ WA_LIMITE_DIARIO: "${user_config.WA_LIMITE_DIARIO}" }).limiteDiario, 30, "campo não preenchido");
  });

  it("o servidor lê o campo de conversas novas como o Claude Desktop o manda (0 desliga a ferramenta)", () => {
    const avisos: string[] = [];
    assert.equal(lerLimiteNovasConversas("5", avisos), 5);
    assert.equal(lerLimiteNovasConversas("0", avisos), 0);
    assert.equal(lerLimiteNovasConversas("20", avisos), 20);
    assert.equal(lerLimiteNovasConversas("", avisos), 5);
    assert.deepEqual(avisos, []);
    assert.equal(lerLimiteNovasConversas("21", avisos), 20);
    assert.equal(lerLimiteNovasConversas("-1", avisos), 5);
    assert.equal(avisos.length, 2);
    assert.equal(lerConfig({ WA_LIMITE_NOVAS_CONVERSAS: "${user_config.WA_LIMITE_NOVAS_CONVERSAS}" }).limiteNovasConversas, 5, "campo não preenchido");
  });

  it("o ícone é um PNG de 512x512", () => {
    const png = ler("../mcpb/icon.png");
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), 512);
    assert.equal(png.readUInt32BE(20), 512);
    assert.equal(manifesto.icon, "icon.png");
  });

  it("lista só ferramentas que o servidor tem, e todas as que o modelo enxerga", async () => {
    const m = await montar({ pareada: false });
    const { cliente, fechar } = await conectarCliente(m.ctx);
    try {
      const { tools } = await cliente.listTools();
      const doModelo = tools.filter((t) => !JSON.stringify(t._meta ?? {}).includes('"visibility":["app"]')).map((t) => t.name).sort();
      const doManifesto = (manifesto.tools as Array<{ name: string }>).map((t) => t.name).sort();
      assert.deepEqual(doManifesto, doModelo);
    } finally {
      await fechar();
      await m.fechar();
    }
  });
});

describe("WA_TESTE_SOCKET (socket inerte do autoteste)", () => {
  const trava = { WA_TESTE_CHAVE: "a".repeat(64), WA_DADOS_DIR: "/tmp/wa-nao-usada" };

  it("vale só com a trava completa e o valor \"falso\"", () => {
    assert.equal(lerConfig({ ...trava, WA_TESTE_SOCKET: "falso" }).socketDeTeste, true);
    assert.equal(lerConfig(trava).socketDeTeste, false);
    assert.equal(lerConfig({}).socketDeTeste, false);
  });

  it("é recusado fora da trava: o servidor não sobe", () => {
    for (const env of [
      { WA_TESTE_SOCKET: "falso" },
      { WA_TESTE_SOCKET: "falso", WA_TESTE_CHAVE: trava.WA_TESTE_CHAVE },
      { ...trava, WA_TESTE_SOCKET: "real" },
    ]) {
      assert.throws(() => lerConfig(env), (e: unknown) => e instanceof ErroConfig && /WA_TESTE_SOCKET só vale no autoteste/.test(e.message), JSON.stringify(env));
    }
  });
});

describe("WASM da Baileys (whatsapp-rust-bridge)", () => {
  it("md5 e hkdf da ponte em WASM batem com o node:crypto (o autoteste faz o mesmo dentro do pacote)", () => {
    assert.deepEqual(conferirWasm(), { md5: true, hkdf: true });
  });
});

// 0.11.0: responder (e mandar arquivo) num grupo que o dono ESCOLHEU e que ainda não tem mensagem guardada. Antes, a
// recusa "Não há mensagens guardadas dessa conversa" nascia no Banco.resolver; agora o grupo escolhido vazio passa (com o
// cartão de sempre e o número de participantes), e a conversa individual continua exigindo conversa existente.
// Sem rede, socket falso.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { GRUPO_NAO_ESCOLHIDO } from "../src/ferramentas/escrita.ts";
import { assentar, chamarCru, clicar, conectar, conectarCliente, GRUPO, ligarEnvio, montar, OUTRO_GRUPO, pn, textoDe, type Montagem } from "./ajuda.ts";

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const NOVO = "5511955554444";

async function cenario() {
  m = await montar();
  const { banco } = await m.ctx.nucleo();
  banco.permitirGrupo(GRUPO);
  const s = await conectar(m, {
    grupos: {
      [GRUPO]: { id: GRUPO, subject: "🏠 Família", size: 7, participants: [] },
      [OUTRO_GRUPO]: { id: OUTRO_GRUPO, subject: "Condomínio", size: 40, participants: [] },
    },
  });
  await assentar(m);
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  await ligarEnvio(cliente);
  return { s, c: cliente, banco };
}

describe("0.11.0: grupo escolhido sem mensagem guardada", () => {
  it("wa_responder pelo id do grupo: cartão com os participantes; com o clique envia e a conversa passa a existir", async () => {
    const { s, c, banco } = await cenario();
    assert.equal(banco.entrada(GRUPO), undefined, "nenhuma mensagem guardada");
    const id = banco.idPublico(GRUPO);
    const previa = await chamarCru(c, "wa_responder", { conversa: id, texto: "Bom dia, família" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    const p = previa._meta!.previa as { destaque: string; alvo: string; conteudo_de_terceiros?: { nome?: string } };
    assert.match(p.destaque, /7 participantes vão receber/);
    assert.equal(p.alvo, `grupo ${id}`);
    assert.equal(p.conteudo_de_terceiros?.nome, "🏠 Família");
    const r = await clicar(c, previa);
    assert.equal(r.isError, undefined, textoDe(r));
    const envio = s.chamadas.find((x) => x.metodo === "sendMessage")!;
    assert.equal(envio.args[0], GRUPO);
    assert.equal(banco.lerMensagens(GRUPO).length, 1);
    assert.equal(banco.entrada(GRUPO)!.ultima_de_mim, true);
  });

  it("wa_responder pelo nome do grupo (do cache dos grupos) também acha o grupo escolhido vazio", async () => {
    const { c } = await cenario();
    const previa = await chamarCru(c, "wa_responder", { conversa: "família", texto: "oi" });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.equal(typeof previa.structuredContent!.pedido, "string");
  });

  it("wa_enviar_arquivo para o grupo escolhido vazio mostra o cartão", async () => {
    const { c, banco } = await cenario();
    mkdirSync(join(m!.dir, "Documents"), { recursive: true }); // 0.16.0: só das pastas permitidas
    const arquivo = join(m!.dir, "Documents", "lista.txt");
    writeFileSync(arquivo, "pão, leite, café");
    const previa = await chamarCru(c, "wa_enviar_arquivo", { conversa: banco.idPublico(GRUPO), arquivo });
    assert.equal(previa.isError, undefined, textoDe(previa));
    assert.match((previa._meta!.previa as { destaque: string }).destaque, /7 participantes vão receber/);
  });

  it("continua recusando: grupo NÃO escolhido, conversa individual sem mensagem guardada, e as outras ferramentas de escrita", async () => {
    const { c, banco } = await cenario();
    const fora = await chamarCru(c, "wa_responder", { conversa: banco.idPublico(OUTRO_GRUPO), texto: "oi" });
    assert.equal(fora.isError, true);
    assert.equal(textoDe(fora), GRUPO_NAO_ESCOLHIDO);
    const individual = await chamarCru(c, "wa_responder", { conversa: NOVO, texto: "oi" });
    assert.equal(individual.isError, true);
    assert.match(textoDe(individual), /Não há mensagens guardadas dessa conversa/);
    const arquivo = join(m!.dir, "a.txt");
    writeFileSync(arquivo, "x");
    const arquivoIndividual = await chamarCru(c, "wa_enviar_arquivo", { conversa: pn(NOVO), arquivo });
    assert.equal(arquivoIndividual.isError, true);
    // Ler um grupo vazio continua dizendo que não há mensagens (só a escrita mudou).
    const ler = await chamarCru(c, "wa_ler_conversa", { conversa: banco.idPublico(GRUPO) });
    assert.equal(ler.isError, true);
    assert.match(textoDe(ler), /Não há mensagens guardadas/);
  });
});

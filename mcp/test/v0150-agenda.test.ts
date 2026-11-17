// 0.15.0, Parte A: wa_atualizar_contatos pede de novo a agenda ao celular (socket falso, rede bloqueada, relógio fixo
// dos pedidos). A ferramenta chama a ressincronização da coleção de contatos desde o começo (a versão guardada sai);
// os contatos que chegam DEPOIS (a Baileys solta os eventos uns 100 ms depois de terminar) gravam o nome com a prioridade
// certa (agenda do WhatsApp > empresa > público), pelo LID com número, e o contato da lista "nunca ler" não ganha nome;
// as contagens; o freio (10 min e 6 por dia, sem gastar quando não dá para pedir); o tempo esgotado sem resposta; e a
// cópia leitora repassa ao dono.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ANA, assentar, BETO, chamarCru, conectar, conectarCliente, montar, pn, textoDe, type Montagem, type Resultado } from "./ajuda.ts";
import { msg, type SocketFalso } from "./socket-falso.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

const CARLA = "5531987650000";
const DANI = "5541987651111";
const EVA = "5551987652222";
const LID_DA_CARLA = "99999000001@lid";

let montagens: Montagem[] = [];
let fechamentos: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const f of fechamentos.reverse()) await f();
  fechamentos = [];
  for (const m of montagens.reverse()) await m.fechar();
  montagens = [];
});

const sc = (r: Resultado) => (r.structuredContent ?? {}) as Obj;
/** Relógio dos pedidos: fixo, e o teste anda com ele. 14/11/2026, 10:00 local. */
let AGORA = new Date(2026, 10, 14, 10, 0, 0).getTime();

async function cliente(m: Montagem): Promise<Cliente> {
  const { cliente: c, fechar } = await conectarCliente(m.ctx);
  fechamentos.push(fechar);
  return c;
}

/**
 * Dono conectado com: Ana (nome público "Ana"), uma conversa só pelo LID (a Carla, número ainda desconhecido), Eva sem
 * nome e Dani na lista "nunca ler". `contatos`: o que o "celular" manda depois de terminar a ressincronização.
 */
async function cenario(contatos?: unknown[], opcoes: { semRessincronizacao?: boolean; nuncaTermina?: boolean } = {}) {
  AGORA = new Date(2026, 10, 14, 10, 0, 0).getTime();
  const m = await montar({ agora: () => AGORA, esperaDosContatosMs: 400 });
  montagens.push(m);
  const s = await conectar(m);
  s.mensagens([
    msg({ jid: pn(ANA), id: "A1", texto: "oi", nome: "Ana" }),
    msg({ jid: LID_DA_CARLA, id: "C1", texto: "oi pelo lid" }),
    msg({ jid: pn(EVA), id: "E1", texto: "oi da eva" }),
  ]);
  await assentar(m);
  const { banco, sessao } = await m.ctx.nucleo();
  banco.bloquear(pn(DANI));
  if (!opcoes.semRessincronizacao) {
    s.ligarRessincronizacao(
      opcoes.nuncaTermina
        ? () => new Promise<void>(() => {})
        : async () => {
            // Como a Baileys: os eventos guardados saem depois de a função terminar (event-buffer.js, ~100 ms).
            if (contatos) setTimeout(() => s.emitir("contacts.upsert", contatos), 30);
          },
    );
  }
  return { m, s, banco, sessao, c: await cliente(m) };
}

const AGENDA = [
  { id: pn(ANA), name: "Ana Souza" },
  { id: pn(BETO), notify: "Betinho" },
  { id: LID_DA_CARLA, lid: LID_DA_CARLA, phoneNumber: pn(CARLA), name: "Carla Dias" },
  { id: pn(DANI), name: "Dani Bloqueada" },
];

const ressincronizacoes = (s: SocketFalso) => s.chamadas.filter((x) => x.metodo === "resyncAppState");

describe("0.15.0, Parte A: wa_atualizar_contatos", () => {
  it("chama a ressincronização da coleção de contatos desde o começo e grava o que chega depois, com as contagens", async () => {
    const { s, banco, sessao, c, m } = await cenario(AGENDA);
    await sessao.set({ "app-state-sync-version:critical_unblock_low": JSON.stringify({ version: 7, hash: "", indexValueMap: {} }) });
    const r = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.deepEqual(ressincronizacoes(s).map((x) => x.args), [[["critical_unblock_low"], false]]);
    await assentar(m);
    assert.equal(await sessao.get("app-state-sync-version:critical_unblock_low"), undefined, "a versão guardada da coleção sai (pede o retrato inteiro)");
    const d = sc(r);
    assert.equal(d.contatos_recebidos, 4);
    assert.equal(d.nomes_novos, 2, "Beto (sem conversa, guardado antes da 1ª mensagem) e a Carla");
    assert.equal(d.nomes_atualizados, 1, "a Ana: o nome da agenda troca o público");
    assert.equal(d.conversas_que_ganharam_nome, 1, "a conversa da Carla, que mudou do LID para o número");
    assert.equal(d.conversas_individuais_sem_nome, 1, "a Eva continua sem nome");
    assert.equal(d.terminou, true);
    assert.equal(d.pedidos_da_agenda_hoje, 1);
    assert.equal(d.limite_diario_de_pedidos_da_agenda, 6);
    assert.match(String(d.para_o_claude), /continuam sem nome/);
    // Nomes e origens.
    assert.equal(banco.entrada(pn(ANA))!.nome, "Ana Souza");
    assert.equal(banco.entrada(pn(ANA))!.origem_do_nome, "agenda_do_whatsapp");
    assert.equal(banco.nomeConhecido(pn(BETO)), "Betinho");
    assert.equal(banco.entrada(LID_DA_CARLA), undefined, "a conversa do LID foi para o número");
    assert.equal(banco.entrada(pn(CARLA))!.nome, "Carla Dias");
    assert.equal(banco.entrada(pn(CARLA))!.origem_do_nome, "agenda_do_whatsapp");
    // Bloqueado não ganha nome guardado.
    assert.equal(banco.nomeConhecido(pn(DANI)), undefined);
  });

  it("a ordem das prioridades: agenda do WhatsApp > empresa (verifiedName) > público; o público nunca troca a agenda", async () => {
    const { s, banco, m } = await cenario();
    s.emitir("contacts.upsert", [{ id: pn(EVA), notify: "Evinha" }]);
    assert.equal(banco.entrada(pn(EVA))!.origem_do_nome, "publico");
    s.emitir("contacts.update", [{ id: pn(EVA), verifiedName: "Eva Doces Ltda" }]);
    assert.equal(banco.entrada(pn(EVA))!.nome, "Eva Doces Ltda");
    assert.equal(banco.entrada(pn(EVA))!.origem_do_nome, "empresa");
    s.emitir("contacts.update", [{ id: pn(EVA), notify: "Evinha de novo" }]);
    assert.equal(banco.entrada(pn(EVA))!.nome, "Eva Doces Ltda", "o público não troca o de empresa");
    s.emitir("contacts.upsert", [{ id: pn(EVA), name: "Eva Prima" }]);
    assert.equal(banco.entrada(pn(EVA))!.nome, "Eva Prima");
    assert.equal(banco.entrada(pn(EVA))!.origem_do_nome, "agenda_do_whatsapp");
    s.emitir("contacts.update", [{ id: pn(EVA), verifiedName: "Outra Empresa" }]);
    assert.equal(banco.entrada(pn(EVA))!.nome, "Eva Prima");
    // O mesmo nome vindo de uma origem melhor sobe a origem: um público diferente depois não troca.
    s.emitir("contacts.upsert", [{ id: pn(ANA), name: "Ana" }]);
    assert.equal(banco.entrada(pn(ANA))!.origem_do_nome, "agenda_do_whatsapp");
    s.mensagens([msg({ jid: pn(ANA), id: "A2", texto: "oi de novo", nome: "Aninha" })]);
    await assentar(m);
    assert.equal(banco.entrada(pn(ANA))!.nome, "Ana");
  });

  it("tempo esgotado sem resposta do celular: diz, sem contar contato nenhum", async () => {
    const { c } = await cenario(undefined, { nuncaTermina: true });
    const inicio = Date.now();
    const r = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.ok(Date.now() - inicio < 3_000, "respeita o tempo limitado");
    const d = sc(r);
    assert.equal(d.tempo_esgotado, true);
    assert.equal(d.terminou, false);
    assert.equal(d.contatos_recebidos, 0);
    assert.match(String(d.para_o_claude), /não terminou de mandar a agenda/);
  });

  it("freio: um a cada 10 min e 6 por dia; socket sem ressincronização recusa sem gastar a contagem", async () => {
    const { c, banco, s } = await cenario([]);
    assert.equal((await chamarCru(c, "wa_atualizar_contatos")).isError, undefined);
    const logo = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(logo.isError, true);
    assert.match(textoDe(logo), /espere 10 min/);
    for (let i = 2; i <= 6; i++) {
      AGORA += 11 * 60_000;
      const r = await chamarCru(c, "wa_atualizar_contatos");
      assert.equal(r.isError, undefined, `${i}º: ${textoDe(r)}`);
      assert.equal(sc(r).pedidos_da_agenda_hoje, i);
    }
    AGORA += 11 * 60_000;
    const setimo = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(setimo.isError, true);
    assert.match(textoDe(setimo), /limite de 6 pedidos da agenda por dia/);
    assert.equal(ressincronizacoes(s).length, 6, "o sétimo não chegou ao celular");
    // No dia seguinte, volta.
    AGORA = new Date(2026, 10, 15, 9, 0, 0).getTime();
    assert.equal((await chamarCru(c, "wa_atualizar_contatos")).isError, undefined);
    assert.equal(banco.contagemDoDia("contatos", AGORA), 1);
  });

  it("sem a ressincronização no socket (ou desconectado), recusa e não gasta o freio nem a contagem", async () => {
    const { c, banco, m } = await cenario(undefined, { semRessincronizacao: true });
    const r = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(r.isError, true);
    assert.match(textoDe(r), /não permite pedir a agenda/);
    assert.equal(banco.contagemDoDia("contatos", AGORA), 0);
    assert.equal(m.ctx.ultimaAtualizacaoDeContatos, undefined);
    m.socket().fechar();
    const fora = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(fora.isError, true);
    assert.match(textoDe(fora), /não está conectado/);
  });

  it("a cópia leitora repassa ao dono: a ressincronização sai pelo socket do DONO", async () => {
    const { s, m, banco } = await cenario(AGENDA);
    const leitor = await montar({ dir: m.dir, pareada: false });
    montagens.push(leitor);
    await leitor.ctx.partida();
    assert.equal(leitor.ctx.papel, "leitor");
    const c = await cliente(leitor);
    const r = await chamarCru(c, "wa_atualizar_contatos");
    assert.equal(r.isError, undefined, textoDe(r));
    assert.equal(sc(r).contatos_recebidos, 4);
    assert.equal(ressincronizacoes(s).length, 1);
    assert.equal(leitor.fabrica.sockets.length, 0, "o leitor não abre socket");
    assert.equal(banco.entrada(pn(ANA))!.nome, "Ana Souza");
  });
});

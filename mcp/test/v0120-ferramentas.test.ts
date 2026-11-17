// 0.12.0: as ferramentas do modo de aprendizado contra o banco de verdade (pasta temporária, sem rede):
// wa_meu_jeito (geral, por conversa, por tipo, amostra pequena), wa_exemplos_do_meu_jeito (ordem das origens, variedade,
// respondendo_a com e sem índice, filtros, nunca terceiros, grupo, sem os rascunhos da IA), wa_edicoes_dos_rascunhos e
// wa_aprender (propor com uma e com duas edições, duplicada, decidir, regra do dono, teto de 30, precedência, tipo),
// desligar e ligar (persiste entre instâncias) e o wa_estado.aprendizado.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Banco, MensagemGuardada } from "../src/banco.ts";
import { ANA, BETO, chamar, chamarCru, conectarCliente, GRUPO, montar, pn, textoDe, type Montagem } from "./ajuda.ts";

type Cliente = Awaited<ReturnType<typeof conectarCliente>>["cliente"];
type Obj = Record<string, unknown>;

let m: Montagem | undefined;
let fecharCliente: (() => Promise<void>) | undefined;
afterEach(async () => {
  await fecharCliente?.();
  fecharCliente = undefined;
  await m?.fechar();
  m = undefined;
});

const AGORA = new Date(2026, 10, 14, 12, 0).getTime();
const DIA = 86_400_000;
const CARLA = "5531977776666";
const DANI = "5541966665555";
const FABIO = "5551955554444";
const GABI = "5561944443333";
const HUGO = "5571933332222";

let seq = 0;
const eu = (texto: string, ts: number, o: Partial<MensagemGuardada> = {}): MensagemGuardada => ({ id: `E${++seq}`, ts, de_mim: true, tipo: "texto", texto, ...o });
const ela = (texto: string, ts: number): MensagemGuardada => ({ id: `R${++seq}`, ts, de_mim: false, tipo: "texto", texto });
/** Uma conversa: cada texto do dono vira uma rajada, depois de uma recebida (com TERCEIRO, para conferir que nunca sai). */
const conversa = (textos: string[], inicio: number, o: Partial<MensagemGuardada>[] = []): MensagemGuardada[] =>
  textos.flatMap((t, i) => [ela(`TERCEIRO pergunta ${i}`, inicio + i * DIA), eu(t, inicio + i * DIA + 60_000, o[i] ?? {})]);

const FALAS_DA_ANA = [
  "ok", "Bom dia! Te mando hoje", "fechado", "Combinado, falo com o time e te retorno até sexta com tudo certinho para a gente fechar",
  "blz", "vou ver aqui", "Perfeito!", "pode ser amanhã?", "Show", "consigo sim", "Tranquilo, sem pressa nenhuma por aqui, vê com calma e me fala",
  "valeu", "beleza", "tô no trânsito, já respondo", "obrigado!", "sim", "não rola hoje", "manda ver", "top", "certo", "massa", "pode deixar",
];

async function cenario(opcoes: { carregarSqlite?: () => undefined; dir?: string } = {}): Promise<{ c: Cliente; banco: Banco }> {
  m = await montar({ agora: () => AGORA, pareada: false, ...opcoes });
  await m.ctx.partida();
  const { banco } = await m.ctx.nucleo();
  const base = AGORA - 60 * DIA;
  banco.gravarMensagens(pn(ANA), [
    ...conversa(FALAS_DA_ANA, base),
    ela("quanto fica o orçamento do site?", base + 30 * DIA),
    eu("vou ver e te falo amanhã", base + 30 * DIA + 120_000),
  ]);
  banco.gravarMensagens(pn(BETO), conversa(["beto um", "beto dois", "beto tres", "beto quatro", "beto cinco"], base));
  banco.gravarMensagens(pn(CARLA), conversa(["carla um", "carla dois", "carla tres"], base));
  banco.gravarMensagens(pn(DANI), conversa(["dani um", "dani dois"], base));
  banco.gravarMensagens(pn(FABIO), conversa(["fabio um", "fabio dois"], base));
  banco.gravarMensagens(pn(GABI), conversa(["TEXTO-DA-IA", "QUASE-DA-IA", "EDITADO-PELO-DONO", "gabi normal"], base, [{ rascunho_da_ia: "sem_edicao" }, { rascunho_da_ia: "edicao_minima" }, { rascunho_da_ia: "editado" }]));
  banco.gravarMensagens(pn(HUGO), conversa(["me liga 11 98888-7777", "hugo@exemplo.com", "olha www.site.com", "custa R$ 40", "pedido 1234567", "hugo limpo"], base));
  banco.permitirGrupo(GRUPO);
  banco.gravarMensagens(GRUPO, conversa(["grupo eu falei"], base));
  const { cliente, fechar } = await conectarCliente(m.ctx);
  fecharCliente = fechar;
  return { c: cliente, banco };
}

const aprender = (c: Cliente, args: Obj, erro = false) => chamar(c, "wa_aprender", args, erro);
const exemplos = (c: Cliente, args: Obj) => chamar(c, "wa_exemplos_do_meu_jeito", args);
const textosDos = (r: Obj) => (r.exemplos as Obj[]).flatMap((e) => e.mensagens as string[]);

/** Edições guardadas como o cartão guardaria (dias e conversas diferentes). */
function semearEdicoes(banco: Banco): string[] {
  const par = (conversa: string, dia: number, rascunho: string, enviado: string) =>
    banco.guardarEnvioDeRascunho({ conversa, mensagem_id: `X${++seq}`, ferramenta: "wa_responder", rascunho, enviado, em: AGORA - dia * DIA });
  par(pn(ANA), 5, "Prezado, segue o contrato em anexo.", "segue o contrato em anexo");
  par(pn(ANA), 5, "Prezado, chego às 8.", "chego às 8");
  par(pn(BETO), 3, "Prezado Beto, tudo certo para amanhã.", "tudo certo pra amanhã");
  par(pn(ANA), 2, "Oi Ana", "Oi Ana");
  return banco.edicoes().map((e) => e.id);
}

describe("0.12.0: wa_meu_jeito", () => {
  it("geral, tipos, por tipo, contagens; por conversa com prioridade; por tipo; amostra pequena com apoio", async () => {
    const { c } = await cenario();
    await aprender(c, { tipo_da_conversa: [{ conversa: pn(ANA), tipo: "Cliente" }, { conversa: pn(BETO), tipo: "cliente " }, { conversa: pn(DANI), tipo: "fornecedor" }] });
    const geral = await chamar(c, "wa_meu_jeito");
    assert.equal(geral.ligado, true);
    const contagens = geral.contagens as Obj;
    // Ana 23, Beto 5, Carla 3, Dani 2, Fabio 2, Gabi 2 (os dois rascunhos da IA ficam fora), Hugo 4 (o link e o e-mail,
    // que tem domínio, ficam fora). 0.13.0: o geral soma o grupo (1).
    assert.equal(contagens.mensagens_do_dono_medidas, 23 + 5 + 3 + 2 + 2 + 2 + 4 + 1);
    assert.equal(contagens.conversas_individuais, 7);
    assert.deepEqual(geral.tipos, [{ tipo: "cliente", conversas: 2 }, { tipo: "fornecedor", conversas: 1 }]);
    assert.equal(geral.sem_tipo, 4);
    const porTipo = geral.por_tipo as Obj[];
    assert.equal(((porTipo[0]!.perfil as Obj).mensagens_medidas as number), 28);
    assert.match(String(geral.para_o_claude), /TETO, não a meta/);

    const daAna = await chamar(c, "wa_meu_jeito", { conversa: pn(ANA) });
    assert.equal(daAna.tipo, "cliente");
    assert.equal(daAna.amostra_pequena, undefined);
    assert.equal((daAna.perfil as Obj).mensagens_medidas, 23);
    const prioridade = daAna.prioridade as Obj;
    assert.equal(prioridade.blocos_recebidos, 23);
    assert.equal(prioridade.mediana_ate_responder_min, 1);
    assert.equal(prioridade.proporcao_respondida_em_ate_24h, 1);

    const doBeto = await chamar(c, "wa_meu_jeito", { conversa: pn(BETO) });
    assert.equal(doBeto.amostra_pequena, true);
    assert.equal((doBeto.apoio as Obj).de, "tipo", "o tipo cliente tem 28 mensagens: apoio do tipo");
    const daDani = await chamar(c, "wa_meu_jeito", { conversa: pn(DANI) });
    assert.equal((daDani.apoio as Obj).de, "individuais", "o tipo fornecedor tem só 2: apoio das individuais (0.13.0; era o geral, que só tinha individuais)");
    const doGrupo = await chamar(c, "wa_meu_jeito", { conversa: GRUPO });
    assert.equal(doGrupo.prioridade, undefined, "prioridade só em conversa individual");

    const tipo = await chamar(c, "wa_meu_jeito", { tipo: "CLIENTE" });
    assert.equal(tipo.conversas, 2);
    assert.equal((tipo.perfil as Obj).mensagens_medidas, 28);
    const nenhum = await chamar(c, "wa_meu_jeito", { tipo: "aluno" });
    assert.equal(nenhum.conversas, 0);
    assert.match(String(nenhum.para_o_claude), /o dono quem dá/);
  });
});

describe("0.12.0: wa_exemplos_do_meu_jeito", () => {
  it("ordem das origens (mesma conversa, mesmo tipo, geral), nunca terceiros nem grupo de outra conversa", async () => {
    const { c } = await cenario();
    await aprender(c, { tipo_da_conversa: [{ conversa: pn(DANI), tipo: "fornecedor" }, { conversa: pn(FABIO), tipo: "fornecedor" }] });
    const r = await exemplos(c, { conversa: pn(DANI), quantos: 6 });
    const lista = r.exemplos as Obj[];
    assert.equal(lista.length, 6);
    assert.deepEqual(lista.map((e) => e.origem), ["mesma_conversa", "mesma_conversa", "mesmo_tipo", "mesmo_tipo", "geral", "geral"]);
    const textos = textosDos(r);
    assert.deepEqual(textos.slice(0, 4).sort(), ["dani dois", "dani um", "fabio dois", "fabio um"]);
    const visivel = JSON.stringify(r);
    assert.ok(!visivel.includes("TERCEIRO"), "mensagem de outra pessoa nunca sai");
    assert.ok(!visivel.includes("grupo eu falei"), "grupo só sai quando é a conversa pedida");
    assert.ok(!/c_[0-9a-f]{12}/.test(JSON.stringify(lista)), "a origem não diz de qual conversa veio");
    assert.equal(r.criterio, "variedade");
    assert.match(String(r.para_o_claude), /não reaproveite fatos/);
    // O grupo pedido: os exemplos dele, primeiro.
    const doGrupo = await exemplos(c, { conversa: GRUPO, quantos: 3 });
    assert.deepEqual((doGrupo.exemplos as Obj[])[0], { origem: "mesma_conversa", criterio: "variedade", tipo_de_mensagem: "outra", tamanho: "curta", mensagens: ["grupo eu falei"] });
  });

  it("variedade na mesma conversa: metade recentes e tamanhos diferentes", async () => {
    const { c } = await cenario();
    const r = await exemplos(c, { conversa: pn(ANA), quantos: 6 });
    const lista = r.exemplos as Obj[];
    assert.ok(lista.every((e) => e.origem === "mesma_conversa"));
    // As 3 mais recentes da Ana: "vou ver e te falo amanhã" (dia 30), "pode deixar" e "massa".
    assert.deepEqual(lista.slice(0, 3).map((e) => (e.mensagens as string[])[0]), ["vou ver e te falo amanhã", "pode deixar", "massa"]);
    const tamanhos = new Set(lista.map((e) => e.tamanho));
    assert.ok(tamanhos.size >= 2, `tamanhos variados: ${[...tamanhos].join(", ")}`);
  });

  it("respondendo_a pelo índice: a rajada do dono depois da recebida parecida vem primeiro; sem índice, a variedade, dizendo por quê", async () => {
    const { c } = await cenario();
    const r = await exemplos(c, { conversa: pn(ANA), quantos: 4, respondendo_a: "e o orçamento do site, já tem?" });
    assert.equal(r.criterio, "respondendo_a_e_variedade");
    assert.deepEqual((r.exemplos as Obj[])[0], { origem: "mesma_conversa", criterio: "parecida", tipo_de_mensagem: "resposta", tamanho: "curta", mensagens: ["vou ver e te falo amanhã"] });
    const nada = await exemplos(c, { conversa: pn(ANA), quantos: 3, respondendo_a: "xilofone zebra" });
    assert.equal(nada.criterio, "variedade");
    assert.match(String(nada.por_que_variedade), /nenhuma mensagem recebida parecida/);
    await fecharCliente!();
    fecharCliente = undefined;
    await m!.fechar();
    m = undefined;
    const sem = await cenario({ carregarSqlite: () => undefined });
    const v = await exemplos(sem.c, { conversa: pn(ANA), quantos: 3, respondendo_a: "e o orçamento do site?" });
    assert.equal(v.criterio, "variedade");
    assert.match(String(v.por_que_variedade), /varredura/);
    assert.equal((v.exemplos as Obj[]).length, 3);
  });

  it("filtros (telefone, e-mail, link, dinheiro, dígitos) e sem os rascunhos da IA sem edição", async () => {
    const { c } = await cenario();
    const hugo = await exemplos(c, { conversa: pn(HUGO), quantos: 3 });
    const daMesma = (hugo.exemplos as Obj[]).filter((e) => e.origem === "mesma_conversa");
    assert.deepEqual(daMesma.map((e) => e.mensagens), [["hugo limpo"]]);
    const gabi = await exemplos(c, { conversa: pn(GABI), quantos: 10 });
    const textos = textosDos(gabi);
    assert.ok(textos.includes("EDITADO-PELO-DONO"), "editado pelo dono entra");
    assert.ok(textos.includes("gabi normal"));
    assert.ok(!textos.includes("TEXTO-DA-IA") && !textos.includes("QUASE-DA-IA"), "a IA não aprende com ela mesma");
    for (const proibido of ["98888", "hugo@", "www.", "R$", "1234567", "TERCEIRO"]) assert.ok(!JSON.stringify(gabi).includes(proibido), proibido);
  });
});

describe("0.12.0: wa_aprender e wa_edicoes_dos_rascunhos", () => {
  it("propor com uma edição recusa; com duas entra como proposta; igual não duplica; decidir; recusada não volta", async () => {
    const { c, banco } = await cenario();
    const [e1, e2, e3] = semearEdicoes(banco);
    assert.equal(banco.edicoes().length, 3, "a sem edição não guarda texto");
    const lidas = await chamar(c, "wa_edicoes_dos_rascunhos");
    assert.equal(lidas.total, 3);
    const primeira = (lidas.edicoes as Obj[])[0]!;
    assert.equal(primeira.enviado, "tudo certo pra amanhã");
    assert.deepEqual(primeira.anotacao_da_ia, { rascunho: "Prezado Beto, tudo certo para amanhã." });
    assert.equal((primeira.resumo as Obj).saudacao, "tirou");
    const est = lidas.estatisticas as Obj;
    assert.equal(est.rascunhos_enviados, 4);
    assert.equal(est.aceitos_sem_edicao, 1);
    assert.equal(est.editados, 3);

    const uma = await aprender(c, { propor: [{ texto: "não usar 'prezado'", escopo: "geral", edicoes: [e1] }] });
    assert.match(String((uma.recusados as Obj[])[0]!.motivo), /pelo menos DUAS/);
    const mesmoMomento = await aprender(c, { propor: [{ texto: "não usar 'prezado'", escopo: "geral", edicoes: [e1, e2] }] });
    assert.equal(mesmoMomento.propostas, undefined, "duas edições do mesmo dia e da mesma conversa não mostram padrão");
    const duas = await aprender(c, { propor: [{ texto: "Não usar 'prezado'.", escopo: "geral", edicoes: [e1, e3] }] });
    const id = ((duas.propostas as Obj[])[0]!.id as string);
    assert.match(String(duas.para_o_claude), /só chame wa_aprender com `decidir`|Só chame wa_aprender com `decidir`/);
    const igual = await aprender(c, { propor: [{ texto: "nao usar 'prezado'", escopo: "geral", edicoes: [e2, e3] }] });
    assert.equal((igual.propostas as Obj[])[0]!.id, id, "a mesma regra não duplica");
    assert.equal(banco.regras().length, 1);
    assert.equal(banco.regras()[0]!.estado, "proposta");
    let jeito = await chamar(c, "wa_meu_jeito");
    assert.equal((jeito.propostas_pendentes as Obj[]).length, 1);
    assert.equal((jeito.regras_ativas as Obj[]).length, 0, "proposta não é ativa");
    assert.deepEqual(((jeito.propostas_pendentes as Obj[])[0]!.anotacao_da_ia as Obj), { texto: "Não usar 'prezado'." });
    assert.match(String(jeito.para_o_claude), /nunca por conta própria/);

    const aceita = await aprender(c, { decidir: { id, decisao: "aceitar" } });
    assert.deepEqual(aceita.decidida, { id, estado: "ativa" });
    jeito = await chamar(c, "wa_meu_jeito");
    assert.equal((jeito.regras_ativas as Obj[]).length, 1);
    assert.ok(banco.regras()[0]!.entregue >= 1, "a entrega é contada");
    // Recusar uma ativa não vale; a recusada não volta como proposta.
    await aprender(c, { regra_do_dono: { texto: "nunca usar emoji com cliente", escopo: "tipo", tipo: "cliente" } });
    const prop2 = await aprender(c, { propor: [{ texto: "frases curtas", escopo: "geral", edicoes: [e1, e3] }] });
    const id2 = (prop2.propostas as Obj[])[0]!.id as string;
    await aprender(c, { decidir: { id: id2, decisao: "recusar" } });
    const denovo = await aprender(c, { propor: [{ texto: "frases curtas", escopo: "geral", edicoes: [e1, e3] }] });
    assert.match(String((denovo.recusados as Obj[])[0]!.motivo), /já recusou/);
    // Marcar vistas tira da lista padrão; `ids` traz de volta.
    await aprender(c, { marcar_vistas: [e1, e2] });
    assert.equal((await chamar(c, "wa_edicoes_dos_rascunhos")).total, 1);
    assert.equal((await chamar(c, "wa_edicoes_dos_rascunhos", { ids: [e1, e3] })).total, 2);
  });

  it("regra do dono entra ativa; teto de 30 ativas; precedência (conversa, tipo, geral; dono acima da aprendida)", async () => {
    const { c, banco } = await cenario();
    const [e1, , e3] = semearEdicoes(banco);
    await aprender(c, { tipo_da_conversa: [{ conversa: pn(ANA), tipo: "cliente" }] });
    const p = await aprender(c, { propor: [{ texto: "G aprendida", escopo: "geral", edicoes: [e1, e3] }] });
    await aprender(c, { decidir: { id: (p.propostas as Obj[])[0]!.id, decisao: "aceitar" } });
    await aprender(c, { regra_do_dono: { texto: "G dono", escopo: "geral" } });
    await aprender(c, { regra_do_dono: { texto: "T dono", escopo: "tipo", tipo: "Cliente" } });
    await aprender(c, { regra_do_dono: { texto: "C dono", escopo: "conversa", conversa: pn(ANA) } });
    await aprender(c, { regra_do_dono: { texto: "C do Beto", escopo: "conversa", conversa: pn(BETO) } });
    const daAna = await chamar(c, "wa_meu_jeito", { conversa: pn(ANA) });
    const textos = (daAna.regras as Obj[]).map((r) => (r.anotacao_da_ia as Obj).texto);
    assert.deepEqual(textos, ["C dono", "T dono", "G dono", "G aprendida"], "a do Beto não vale para a Ana");
    assert.match(String(daAna.para_o_claude), /a mais específica/);
    const ex = await exemplos(c, { conversa: pn(ANA), quantos: 3 });
    assert.deepEqual((ex.regras as Obj[]).map((r) => (r.anotacao_da_ia as Obj).texto), textos);
    // Teto: 5 ativas; mais 25 chegam a 30; a 31ª é recusada.
    for (let i = 0; i < 25; i++) await aprender(c, { regra_do_dono: { texto: `regra ${i}`, escopo: "geral" } });
    assert.equal(banco.contagemDoAprendizado().regras_ativas, 30);
    const demais = await aprender(c, { regra_do_dono: { texto: "a trigésima primeira", escopo: "geral" } });
    assert.match(String((demais.recusados as Obj[])[0]!.motivo), /30 regras ativas/);
    // Desligar abre espaço; apagar tira.
    const algum = banco.regras().find((r) => r.texto === "regra 0")!.id;
    assert.deepEqual((await aprender(c, { desligar: [algum] })).desligadas, [algum]);
    assert.ok((await aprender(c, { regra_do_dono: { texto: "a trigésima primeira", escopo: "geral" } })).regra_do_dono);
    assert.deepEqual((await aprender(c, { apagar: [algum] })).apagadas, [algum]);
    // Escopo sem o que precisa: recusado com o motivo.
    const semTipo = await aprender(c, { regra_do_dono: { texto: "x", escopo: "tipo" } });
    assert.match(String((semTipo.recusados as Obj[])[0]!.motivo), /precisa do nome do tipo/);
  });

  it("tipo da conversa: só o que o dono der; null tira; conversa que não existe é recusada", async () => {
    const { c, banco } = await cenario();
    const r = await aprender(c, { tipo_da_conversa: [{ conversa: pn(ANA), tipo: "Família" }, { conversa: "c_000000000000", tipo: "x" }] });
    assert.equal(r.tipos_gravados, 1);
    assert.equal((r.recusados as Obj[]).length, 1);
    assert.equal(banco.tipoDaConversa(pn(ANA)), "família");
    await aprender(c, { tipo_da_conversa: [{ conversa: pn(ANA), tipo: null }] });
    assert.equal(banco.tipoDaConversa(pn(ANA)), undefined);
    // Tipo e regra com número de telefone: recusados na entrada (forma, não dado).
    assert.equal((await chamarCru(c, "wa_aprender", { tipo_da_conversa: [{ conversa: pn(ANA), tipo: "cliente 11 91234-5678" }] })).isError, true);
    assert.equal((await chamarCru(c, "wa_aprender", { regra_do_dono: { texto: "ligar no 1191234567", escopo: "geral" } })).isError, true);
    assert.equal(banco.regras().length, 0);
  });
});

describe("0.12.0: desligar e ligar", () => {
  it("desligado: as leituras dizem que está desligado, wa_aprender recusa ensinar, e persiste numa outra instância", async () => {
    const { c, banco } = await cenario();
    const r = await aprender(c, { ligar: false });
    assert.equal(r.ligado, false);
    for (const [nome, args] of [["wa_meu_jeito", {}], ["wa_exemplos_do_meu_jeito", { conversa: pn(ANA) }], ["wa_edicoes_dos_rascunhos", {}]] as const) {
      const lida = await chamar(c, nome, args);
      assert.equal(lida.ligado, false, nome);
      assert.match(String(lida.para_o_claude), /desligado/);
      assert.equal(lida.exemplos, undefined);
    }
    const recusa = await chamarCru(c, "wa_aprender", { regra_do_dono: { texto: "x", escopo: "geral" } });
    assert.equal(recusa.isError, true);
    assert.match(textoDe(recusa), /desligado/);
    assert.equal(banco.regras().length, 0);
    // Desligado não guarda par novo.
    const { aprenderComOEnvio } = await import("../src/ferramentas/jeito.ts");
    aprenderComOEnvio(banco, { conversa: pn(ANA), mensagem_id: "Z", ferramenta: "wa_responder", rascunho: "Olá, tudo bem por aí?", enviado: "oi", em: AGORA });
    assert.equal(banco.edicoes().length, 0);
    assert.equal((await chamar(c, "wa_estado")).aprendizado && ((await chamar(c, "wa_estado")).aprendizado as Obj).ligado, false);

    // Outra instância na mesma pasta vê desligado; liga por lá e esta vê ligado.
    const dir = m!.dir;
    const outra = await montar({ dir, pareada: false, agora: () => AGORA });
    try {
      const b2 = (await outra.ctx.nucleo()).banco;
      assert.equal(b2.aprendizadoLigado(), false);
      const cli = await conectarCliente(outra.ctx);
      try {
        await chamar(cli.cliente, "wa_aprender", { ligar: true });
      } finally {
        await cli.fechar();
      }
    } finally {
      await outra.ctx.encerrar();
    }
    assert.equal(banco.aprendizadoLigado(), true);
    assert.equal((await chamar(c, "wa_meu_jeito", { conversa: pn(ANA) })).ligado, true);
  });
});

describe("0.12.0: wa_estado.aprendizado", () => {
  it("ligado, mensagens medidas (null até medir), regras ativas, propostas e edições", async () => {
    const { c, banco } = await cenario();
    let a = (await chamar(c, "wa_estado")).aprendizado as Obj;
    assert.deepEqual(a, { ligado: true, mensagens_do_dono_medidas: null, regras_ativas: 0, propostas_pendentes: 0, edicoes_guardadas: 0 });
    const [e1, , e3] = semearEdicoes(banco);
    await aprender(c, { propor: [{ texto: "sem prezado", escopo: "geral", edicoes: [e1, e3] }], regra_do_dono: { texto: "frases curtas", escopo: "geral" } });
    await chamar(c, "wa_meu_jeito");
    a = (await chamar(c, "wa_estado")).aprendizado as Obj;
    // 0.13.0: as medidas somam o grupo (41 individuais + 1).
    assert.deepEqual(a, { ligado: true, mensagens_do_dono_medidas: 42, regras_ativas: 1, propostas_pendentes: 1, edicoes_guardadas: 3 });
  });
});

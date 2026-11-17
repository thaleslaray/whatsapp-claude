// 0.12.0: o modo de aprendizado: wa_meu_jeito, wa_exemplos_do_meu_jeito, wa_edicoes_dos_rascunhos e wa_aprender.
// O servidor aprende o jeito do dono escrever sem ele ter de descrever: mede por código (jeito.ts) as mensagens dele e
// o que ele muda nos cartões, guarda cifrado (banco.ts, jeito.enc) e entrega ao modelo, na hora de redigir, os números
// (como teto, não meta), exemplos reais de FORMA e as regras que o dono aceitou. Quem redige é o modelo.
// Regras que a pesquisa deixou:
// - exemplo real funciona melhor que descrição (5 a 8 bastam); regra concreta e medida funciona, "escreva como eu" não;
// - tudo por conversa e por tipo de relação (o tipo é o dono quem dá; o servidor não adivinha);
// - edição nunca vira regra direto: vira PROPOSTA com as edições que a geraram, e só fica ativa com o "sim" do dono;
// - mensagem de outra pessoa nunca é exemplo nem fonte de regra; exemplo é forma, não fato (filtros em jeito.ts);
// - tudo visível, com origem, apagável.
// As três leituras rodam também na cópia leitora (WA_LEITURA_LOCAL); wa_aprender é escrita local direta, como o
// wa_anotar (no leitor, vai pelo canal ao dono). Registro de ações e caixa-preta: só contagens.
// 0.13.0: grupo é cidadão de primeira classe (é nos grupos que o dono responde os clientes): três perfis agregados
// (individuais, grupos e geral), o tipo vale para grupo, os exemplos de grupo vêm primeiro de grupos, e as contagens dos
// pares pergunta -> resposta (pares.ts; a leitura deles é o wa_como_eu_respondi, em como-eu-respondi.ts).

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { dataIso } from "../apresentacao.ts";
import type { Banco, EntradaIndice, MensagemGuardada, PedidoDeAprendizado } from "../banco.ts";
import type { Contexto } from "../contexto.ts";
import {
  AMOSTRA_MINIMA,
  amostraVazia,
  DIAS_DO_RECENTE,
  MINIMO_DO_RECENTE,
  chaveDoTipo,
  escolherPorVariedade,
  exemploDaRajada,
  exemploDoAviso,
  juntarAmostras,
  mediana,
  perfilDe,
  prioridadePublica,
  rajadasDoDono,
  TAMANHO_MAXIMO_DA_REGRA,
  TAMANHO_MAXIMO_DO_TIPO,
  termosParaParecidas,
  UM_DIA_MS,
  type AmostraDoJeito,
  type Exemplo,
  type FerramentaDoRascunho,
  type Regra,
} from "../jeito.ts";
import { candidatosDasEdicoes, type Candidato } from "../cortes.ts";
import type { Par } from "../pares.ts";
import { classificarRajadas, TIPOS_DE_MENSAGEM, type RajadaClassificada, type TipoDeMensagem } from "../tipo-de-mensagem.ts";
import { caberNoTeto, LIMITE_CARACTERES, registrarEscritaDireta, registrarLeitura, respostaJson, respostaJsonCompacta } from "../respostas.ts";

export const FRASE_DO_DESLIGADO =
  "O modo de aprendizado está desligado (o dono desligou): nada é medido, guardado nem entregue. Redija sem ele. Para ligar de novo, só se o dono pedir: wa_aprender com `ligar: true`.";

export const FRASE_DO_JEITO =
  "Estes números são do próprio dono e descrevem a FORMA das mensagens dele, não o conteúdo. Use como limites concretos ao redigir (tamanho, quebra em várias mensagens, caixa, pontuação). " +
  "Não imite além do que os números mostram: a frequência medida de emoji, gíria e risada é o TETO, não a meta (não exagere). O conteúdo vem da conversa atual e do que o dono disser, nunca dos exemplos. " +
  "`palavras_mais_usadas` são as palavras frequentes do dono (muitas de assunto): servem para o vocabulário dele, não são para enfiar na resposta. " +
  "`fora_da_medida` conta as mensagens dele que não entraram (com link, ou texto idêntico repetido 5+ vezes: mensagem de sistema).";

export const FRASE_DAS_REGRAS =
  "As regras ativas valem acima dos números. Em conflito, vale a primeira da lista: a mais específica (da conversa, depois do tipo, depois a geral) e, no mesmo nível, a ditada pelo dono acima da aprendida. O texto delas (em anotacao_da_ia) foi escrito por IA.";

export const FRASE_DOS_EXEMPLOS =
  "Exemplos de FORMA escritos pelo dono em outras situações: veja tamanho, quebra entre mensagens, caixa, pontuação e jeito de abrir e fechar. Não copie frases inteiras e não reaproveite fatos, nomes, datas, valores ou promessas que apareçam neles: o conteúdo da resposta vem só da conversa atual e do que o dono disser.";

export const FRASE_DA_DECISAO =
  "Uma proposta só vira ativa com o \"sim\" do dono: mostre a ele o texto da regra e as edições que a geraram (wa_edicoes_dos_rascunhos com `ids`) e pergunte. Só chame wa_aprender com `decidir` e `aceitar` depois de ele responder sim a ESSA regra, na conversa; nunca por conta própria.";

/** Quantas conversas, no máximo, entram como fonte de exemplos do mesmo tipo e gerais (as mais recentes). */
const CONVERSAS_DE_APOIO = 40;
const cederAoLaco = (): Promise<void> => new Promise((pronto) => setImmediate(pronto));

const PESO_DO_ESCOPO = { conversa: 0, tipo: 1, geral: 2 } as const;
/** A ordem das regras que valem: a mais específica primeiro e, no mesmo nível, a do dono acima da aprendida. */
const precedencia = (a: Regra, b: Regra): number =>
  PESO_DO_ESCOPO[a.escopo] - PESO_DO_ESCOPO[b.escopo] || Number(a.origem !== "dono") - Number(b.origem !== "dono") || (a.ativa_desde ?? a.criada_em) - (b.ativa_desde ?? b.criada_em);

/** A regra como o modelo vê: o texto em `anotacao_da_ia`, a conversa pelo id público. */
export function regraPublica(banco: Banco, r: Regra): Record<string, unknown> {
  return {
    id: r.id,
    escopo: r.escopo,
    ...(r.tipo !== undefined ? { tipo: r.tipo } : {}),
    ...(r.conversa !== undefined ? { conversa: banco.idPublico(r.conversa) } : {}),
    origem: r.origem,
    estado: r.estado,
    criada_em: dataIso(r.criada_em),
    ...(r.ativa_desde !== undefined ? { ativa_desde: dataIso(r.ativa_desde) } : {}),
    entregue: r.entregue,
    ...(r.edicoes ? { edicoes: r.edicoes } : {}),
    anotacao_da_ia: { texto: r.texto },
  };
}

/** As regras ativas que valem para uma conversa (gerais, do tipo dela e as dela), na ordem de precedência. */
export function regrasQueValem(banco: Banco, jid?: string): Regra[] {
  const tipo = jid ? banco.tipoDaConversa(jid) : undefined;
  return banco
    .regras()
    .filter((r) => r.estado === "ativa" && (r.escopo === "geral" || (r.escopo === "tipo" && tipo !== undefined && chaveDoTipo(r.tipo ?? "") === chaveDoTipo(tipo)) || (r.escopo === "conversa" && r.conversa === jid)))
    .sort(precedencia);
}

/** Conta a entrega das regras (só o dono da conexão grava; a cópia leitora que lê localmente não). */
function contarEntrega(ctx: Contexto, banco: Banco, regras: readonly Regra[]): void {
  if (!ctx.lock.ehDono || regras.length === 0) return;
  try {
    banco.contarEntregas(regras.map((r) => r.id));
  } catch {
    // a contagem nunca impede a leitura
  }
}

type DaConversa = ReturnType<Contexto["jeito"]["daConversa"]>;

/** As medidas de várias conversas (pelo cache: amostra, prioridade e pares), cedendo ao laço de tanto em tanto. */
async function dadosDe(ctx: Contexto, banco: Banco, jids: readonly string[]): Promise<DaConversa[]> {
  const saida: DaConversa[] = [];
  for (const [i, jid] of jids.entries()) {
    saida.push(ctx.jeito.daConversa(banco, jid));
    if ((i + 1) % 20 === 0) await cederAoLaco();
  }
  return saida;
}

/** As amostras de várias conversas (pelo cache). */
async function amostras(ctx: Contexto, banco: Banco, jids: readonly string[]): Promise<AmostraDoJeito[]> {
  return (await dadosDe(ctx, banco, jids)).map((d) => d.amostra);
}

/** 0.14.0: o candidato como o modelo vê (a conversa pelo id público; o texto sugerido é do servidor, por código). */
function candidatoPublico(banco: Banco, c: Candidato): Record<string, unknown> {
  return {
    id: c.id,
    tipo: c.tipo,
    ...(c.trecho !== undefined ? { trecho: c.trecho } : {}),
    ...(c.habito !== undefined ? { habito: c.habito } : {}),
    edicoes_que_sustentam: c.edicoes_que_sustentam,
    proporcao: c.proporcao,
    edicoes: c.edicoes,
    escopo_sugerido: c.escopo,
    ...(c.tipo_da_conversa !== undefined ? { tipo_da_conversa: c.tipo_da_conversa } : {}),
    ...(c.conversa !== undefined ? { conversa: banco.idPublico(c.conversa) } : {}),
    texto_sugerido: c.texto_sugerido,
  };
}

/**
 * 0.14.0: o perfil dentro de outro perfil (resposta, aviso, últimos 90 dias): só a forma, sem `palavras_mais_usadas`
 * (assunto), `audio` e `fora_da_medida` (não se separam por tipo). O perfil inteiro de um tipo: `tipo_de_mensagem`.
 */
function perfilEnxuto(a: AmostraDoJeito, listas = 8): Record<string, unknown> {
  const { palavras_mais_usadas: _p, audio: _a, fora_da_medida: _f, ...forma } = perfilDe(a);
  return {
    ...forma,
    emoji: { ...forma.emoji, mais_usados: forma.emoji.mais_usados.slice(0, listas) },
    risada: forma.risada.slice(0, listas),
    aberturas: forma.aberturas.slice(0, listas),
    fechos: forma.fechos.slice(0, listas),
  };
}

/** Até 3 itens em cada lista dos perfis de resposta e de aviso dentro de outro perfil (o teto da visão geral). */
const LISTAS_DO_SUBPERFIL = 3;

/** O perfil de resposta ou de aviso dentro de outro perfil: o enxuto, sem `periodo` (o mesmo do perfil de fora). */
function subperfil(a: AmostraDoJeito): Record<string, unknown> {
  const { periodo: _periodo, ...resto } = perfilEnxuto(a, LISTAS_DO_SUBPERFIL);
  return resto;
}

/** 0.14.0: `ultimos_90_dias` só com os números (para ver se o jeito mudou), sem as listas. */
function perfilDoRecente(a: AmostraDoJeito): Record<string, unknown> {
  const p = perfilDe(a);
  return { mensagens_medidas: p.mensagens_medidas, periodo: p.periodo, tamanho: p.tamanho, rajada: p.rajada, caixa: p.caixa, pontuacao_final: p.pontuacao_final, emoji: { proporcao_de_mensagens: p.emoji.proporcao_de_mensagens } };
}

/**
 * 0.14.0: as contagens de cada tipo de mensagem e o perfil completo de resposta e de aviso. `perfis: false` (o `geral`
 * da visão geral): só as contagens. O perfil de aviso só sai quando há rajada de aviso (em individuais, nunca há).
 */
function porTipoDeMensagem(dados: readonly DaConversa[], perfis = true): Record<string, unknown> {
  const rajadas = Object.fromEntries(TIPOS_DE_MENSAGEM.map((t) => [t, dados.reduce((n, d) => n + d.contagemPorTipo[t].rajadas, 0)]));
  const mensagens = Object.fromEntries(TIPOS_DE_MENSAGEM.map((t) => [t, dados.reduce((n, d) => n + d.contagemPorTipo[t].mensagens, 0)]));
  if (!perfis) return { rajadas, mensagens };
  return {
    rajadas,
    mensagens,
    resposta: subperfil(juntarAmostras(dados.map((d) => d.porTipo.resposta))),
    ...(rajadas.aviso! > 0 ? { aviso: subperfil(juntarAmostras(dados.map((d) => d.porTipo.aviso))) } : {}),
  };
}

/** 0.13.0: quantos pares pergunta -> resposta, por ligação (os de rascunho da IA sem edição contados à parte). */
function contarPares(listas: ReadonlyArray<readonly Par[]>): { citada: number; sequencia: number; de_rascunho_da_ia: number } {
  const c = { citada: 0, sequencia: 0, de_rascunho_da_ia: 0 };
  for (const lista of listas) for (const p of lista) {
    if (p.rascunho_da_ia) c.de_rascunho_da_ia++;
    else c[p.ligacao]++;
  }
  return c;
}

const Conversa = z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa");
/** Tipo e texto de regra são forma, não dado: número de telefone (6+ dígitos, com ou sem separador) é recusado na entrada. */
const SEM_NUMERO = (t: string) => !/(?:\d[\s.()-]*){6,}/u.test(t);
const MENSAGEM_DO_NUMERO = "Sem número (6 ou mais dígitos) aqui: tipo e regra descrevem forma, não dado.";
const Tipo = z.string().trim().min(1).max(TAMANHO_MAXIMO_DO_TIPO).refine(SEM_NUMERO, { message: MENSAGEM_DO_NUMERO });
const TextoDeRegra = z.string().trim().min(1).max(TAMANHO_MAXIMO_DA_REGRA).refine(SEM_NUMERO, { message: MENSAGEM_DO_NUMERO });
const IdDeRegra = z.string().regex(/^r_[0-9a-f]{8}$/);
const IdDeEdicao = z.string().regex(/^e_[0-9a-f]{8}$/);
const Escopo = z.enum(["geral", "tipo", "conversa"]).describe("geral, tipo (com `tipo`) ou conversa (com `conversa`)");

/**
 * Uma fonte de exemplos: a conversa pedida, as individuais do mesmo tipo, os grupos do mesmo tipo, outro grupo
 * escolhido ou as individuais em geral (0.13.0: grupo entra como fonte).
 */
type Origem = "mesma_conversa" | "mesmo_tipo" | "mesmo_tipo_em_grupo" | "outro_grupo" | "geral";

/** As rajadas de uma conversa prontas para virar exemplo (lidas uma vez por chamada). */
interface FonteDeExemplos {
  mensagens: MensagemGuardada[];
  rajadas: ReturnType<typeof rajadasDoDono>;
  /** 0.14.0: as rajadas inteiras com o tipo de mensagem (a chave é a posição da primeira mensagem do dono). */
  classificadas: RajadaClassificada[];
  tipoDe: Map<number, TipoDeMensagem>;
}

/** 0.14.0: um candidato a exemplo de uma conversa, com o tipo da rajada. */
interface CandidatoAExemplo extends Exemplo {
  chave: string;
  tipo_de_mensagem: TipoDeMensagem;
}

/** Os candidatos a exemplo de uma fonte: aviso pela rajada inteira (o link do dono pode ficar), o resto pelas medidas. */
function candidatosDa(jid: string, f: FonteDeExemplos, quer: "resposta" | "aviso" | "qualquer"): CandidatoAExemplo[] {
  const saida: CandidatoAExemplo[] = [];
  if (quer !== "resposta") {
    for (const r of f.classificadas) {
      if (r.tipo !== "aviso") continue;
      const ex = exemploDoAviso(f.mensagens, r.posicoes);
      if (ex) saida.push({ ...ex, chave: `${jid}|${r.posicoes[0]}`, tipo_de_mensagem: "aviso" });
    }
    if (quer === "aviso") return saida;
  }
  for (const r of f.rajadas) {
    const tipo = f.tipoDe.get(r.comeco) ?? "outra";
    if (tipo === "aviso" && quer === "qualquer") continue; // já veio acima, pela rajada inteira
    if (quer === "resposta" && tipo !== "resposta" && tipo !== "outra") continue;
    const ex = exemploDaRajada(f.mensagens, r);
    if (ex) saida.push({ ...ex, chave: `${jid}|${r.comeco}`, tipo_de_mensagem: tipo });
  }
  return saida;
}

export function registrarJeito(server: McpServer, ctx: Contexto): void {
  registrarLeitura(
    server,
    "wa_meu_jeito",
    {
      title: "O jeito do dono escrever (medido)",
      description:
        "Mostra o jeito do dono escrever, MEDIDO por código nas mensagens que ele mesmo mandou (nunca nas de outras pessoas, nem nos rascunhos da IA aceitos sem edição): tamanho (mediana e p90), rajadas (várias mensagens seguidas), caixa, pontuação final, emoji, risada, aberturas e fechos, palavras mais usadas (vocabulário, fora da lista comum) e áudio; mensagem com link e texto idêntico repetido 5+ vezes (de máquina) ficam fora (`fora_da_medida`). " +
        "Sem argumento: três perfis agregados, `individuais` (só as conversas individuais), `grupos` (todas as mensagens do dono nos grupos escolhidos) e `geral` (os dois juntos), com as contagens de cada um e dos pares pergunta -> resposta (`citada` e `sequencia`, em grupos e em individuais); os perfis por tipo (somando individuais e grupos daquele tipo), a lista dos tipos, as regras ativas e as propostas pendentes. " +
        "Com `conversa` (individual ou grupo): o perfil dela, o tipo, os pares dela, a prioridade por comportamento (só individual: tempo até responder, blocos respondidos em 24 h, quantas vezes o dono iniciou) e as regras que valem para ela; com menos de 20 mensagens do dono, `amostra_pequena: true` e um perfil de `apoio`: o do tipo dela (se tiver 20+), senão `grupos` para grupo ou `individuais` para conversa individual (se tiver 20+), senão o `geral`. " +
        "Com `tipo`: o perfil daquele tipo (individuais e grupos). O jeito de grupo e o de conversa direta são medidos separados. Chame na primeira vez que for redigir numa conversa. " +
        "Cada rajada do dono tem um tipo de mensagem, por regra: resposta (a uma pergunta, citando, ou logo depois de mensagem recebida em conversa individual), aviso (só em grupo: link, chamada a todos, data com texto longo, ou texto longo depois de 6 h calado), pergunta, confirmacao ou outra; cada perfil traz `por_tipo_de_mensagem` (contagens, e os perfis de resposta e de aviso, resumidos: só a forma, 3 itens por lista; no aviso, o link conta como uma palavra; aviso só onde há) e, com 50+ mensagens nos últimos 90 dias, `ultimos_90_dias` (só os números). Na visão geral, `geral` traz só a forma e as contagens. `tipo_de_mensagem` devolve os perfis inteiros só daquele tipo. " +
        'Exemplos: "como eu escrevo?", "o que você aprendeu do meu jeito?".',
      inputSchema: z
        .strictObject({
          conversa: Conversa.optional(),
          tipo: Tipo.optional().describe("Um tipo de relação dado pelo dono (cliente, aluno, família, equipe...); vale para conversa individual e para grupo"),
          tipo_de_mensagem: z.enum(TIPOS_DE_MENSAGEM).optional().describe("Só as rajadas deste tipo: resposta, aviso, pergunta, confirmacao ou outra"),
        })
        .refine((v) => v.conversa === undefined || v.tipo === undefined, { message: "Passe `conversa` ou `tipo`, não os dois." }),
    },
    async ({ conversa, tipo, tipo_de_mensagem: tm }) => {
      const { banco } = await ctx.nucleo();
      if (!banco.aprendizadoLigado()) return respostaJson({ ligado: false, para_o_claude: FRASE_DO_DESLIGADO });
      const agora = ctx.agora();
      const tipos = banco.tiposDasConversas();
      const todas = banco.listarConversas();
      const ind = todas.filter((e) => !e.grupo);
      const grp = todas.filter((e) => e.grupo);
      const doTipo = (t: string) => todas.filter((e) => tipos[e.jid] !== undefined && chaveDoTipo(tipos[e.jid]!) === chaveDoTipo(t)).map((e) => e.jid);
      // 0.14.0: com `tipo_de_mensagem`, todo perfil é só daquele tipo; sem ele, o de tudo, com `por_tipo_de_mensagem`
      // e `ultimos_90_dias` (se o período tiver 50+ mensagens).
      const desde = Math.floor((agora - DIAS_DO_RECENTE * UM_DIA_MS) / UM_DIA_MS) * UM_DIA_MS;
      const doTipoDeMensagem = (d: DaConversa) => (tm ? d.porTipo[tm] : d.amostra);
      // `resumido` (o `geral` da visão geral): os números de forma (perfilEnxuto), só as contagens dos tipos de mensagem e sem `ultimos_90_dias` (os perfis
      // completos ficam em `grupos` e `individuais`, onde servem; com eles, a visão geral passava do teto).
      const perfilDeConversas = async (jids: readonly string[], resumido = false): Promise<{ amostra: AmostraDoJeito; perfil: Record<string, unknown> }> => {
        const dados = await dadosDe(ctx, banco, jids);
        const amostra = juntarAmostras(dados.map(doTipoDeMensagem));
        const perfil: Record<string, unknown> = resumido ? perfilEnxuto(amostra) : { ...perfilDe(amostra) };
        if (!tm) {
          perfil.por_tipo_de_mensagem = porTipoDeMensagem(dados, !resumido);
          if (resumido) return { amostra, perfil };
          const recente = juntarAmostras(jids.map((j) => ctx.jeito.recente(banco, j, desde)));
          if (recente.mensagens >= MINIMO_DO_RECENTE) perfil.ultimos_90_dias = perfilDoRecente(recente);
        }
        return { amostra, perfil };
      };
      const sobreOTipo = tm ? ` Os perfis são só das rajadas do tipo \`${tm}\`.` : " `por_tipo_de_mensagem` separa resposta, aviso, pergunta, confirmação e outra: para redigir RESPOSTA, valem os números de `por_tipo_de_mensagem.resposta`.";

      if (conversa !== undefined) {
        const e = banco.resolver(conversa);
        const dados = ctx.jeito.daConversa(banco, e.jid);
        const t = tipos[e.jid];
        const daConversa = await perfilDeConversas([e.jid]);
        const pequena = daConversa.amostra.mensagens < AMOSTRA_MINIMA;
        let apoio: Record<string, unknown> | undefined;
        if (pequena) {
          // O apoio: o tipo dela; senão o perfil do mesmo lado (grupos para grupo, individuais para individual); senão o geral.
          const doMesmoTipo = t !== undefined ? juntarAmostras((await dadosDe(ctx, banco, doTipo(t))).map(doTipoDeMensagem)) : amostraVazia();
          const lado = juntarAmostras((await dadosDe(ctx, banco, (e.grupo ? grp : ind).map((x) => x.jid))).map(doTipoDeMensagem));
          apoio =
            t !== undefined && doMesmoTipo.mensagens >= AMOSTRA_MINIMA
              ? { de: "tipo", tipo: t, perfil: perfilDe(doMesmoTipo) }
              : lado.mensagens >= AMOSTRA_MINIMA
                ? { de: e.grupo ? "grupos" : "individuais", perfil: perfilDe(lado) }
                : { de: "geral", perfil: perfilDe(juntarAmostras((await dadosDe(ctx, banco, todas.map((x) => x.jid))).map(doTipoDeMensagem))) };
        }
        const regras = regrasQueValem(banco, e.jid);
        contarEntrega(ctx, banco, regras);
        const nomeDoApoio: Record<string, string> = { tipo: "do tipo dela", grupos: "dos grupos (todas as mensagens do dono nos grupos escolhidos)", individuais: "das conversas individuais", geral: "geral (individuais e grupos)" };
        return respostaJson({
          ligado: true,
          conversa: { id: banco.idPublico(e.jid), grupo: e.grupo },
          tipo: t ?? null,
          ...(tm ? { tipo_de_mensagem: tm } : {}),
          perfil: daConversa.perfil,
          ...(pequena ? { amostra_pequena: true, apoio } : {}),
          pares: contarPares([dados.pares]),
          ...(e.grupo ? {} : { prioridade: prioridadePublica(dados.prioridade, agora) }),
          regras: regras.map((r) => regraPublica(banco, r)),
          para_o_claude:
            `${FRASE_DO_JEITO} ${regras.length > 0 ? FRASE_DAS_REGRAS : ""}`.trim() +
            sobreOTipo +
            (pequena ? ` Há poucas mensagens do dono nesta conversa (menos de ${AMOSTRA_MINIMA}): o \`apoio\` é o perfil ${nomeDoApoio[String(apoio?.de)] ?? "geral"}.` : "") +
            " Para redigir, chame também wa_exemplos_do_meu_jeito com esta conversa e, se for responder a uma dúvida, wa_como_eu_respondi; antes do cartão, wa_conferir_rascunho.",
        });
      }

      if (tipo !== undefined) {
        const jids = doTipo(tipo);
        const { amostra: a, perfil } = await perfilDeConversas(jids);
        const regras = banco.regras().filter((r) => r.estado === "ativa" && r.escopo === "tipo" && chaveDoTipo(r.tipo ?? "") === chaveDoTipo(tipo)).sort(precedencia);
        const grupos = jids.filter((j) => banco.entrada(j)?.grupo).length;
        return respostaJson({
          ligado: true,
          tipo,
          ...(tm ? { tipo_de_mensagem: tm } : {}),
          conversas: jids.length,
          conversas_individuais: jids.length - grupos,
          grupos,
          perfil,
          ...(a.mensagens < AMOSTRA_MINIMA ? { amostra_pequena: true } : {}),
          regras_do_tipo: regras.map((r) => regraPublica(banco, r)),
          para_o_claude: jids.length === 0 ? "Nenhuma conversa (individual ou grupo) tem esse tipo. O tipo é o dono quem dá (wa_aprender com `tipo_da_conversa`, só com as palavras dele)." : FRASE_DO_JEITO + sobreOTipo,
        });
      }

      // Visão geral: os três perfis (individuais, grupos, geral), por tipo, a lista dos tipos, as regras e as propostas.
      const porConversa = await dadosDe(ctx, banco, todas.map((e) => e.jid));
      const doJid = new Map(todas.map((e, i) => [e.jid, porConversa[i]!]));
      const lado = (lista: readonly EntradaIndice[]) => lista.map((e) => doJid.get(e.jid)!);
      const individuais = await perfilDeConversas(ind.map((e) => e.jid));
      const grupos = await perfilDeConversas(grp.map((e) => e.jid));
      const geral = await perfilDeConversas(todas.map((e) => e.jid), true);
      if (!tm) ctx.jeito.mensagensMedidas = geral.amostra.mensagens;
      const porTipo = new Map<string, { tipo: string; conversas: number; amostras: AmostraDoJeito[] }>();
      for (const e of todas) {
        const t = tipos[e.jid];
        if (t === undefined) continue;
        const g = porTipo.get(chaveDoTipo(t)) ?? { tipo: t, conversas: 0, amostras: [] };
        g.conversas++;
        g.amostras.push(doTipoDeMensagem(doJid.get(e.jid)!));
        porTipo.set(chaveDoTipo(t), g);
      }
      const listaDeTipos = [...porTipo.values()].sort((a, b) => b.conversas - a.conversas || (a.tipo < b.tipo ? -1 : 1));
      const regras = banco.regras();
      const ativas = regras.filter((r) => r.estado === "ativa").sort(precedencia);
      const propostas = regras.filter((r) => r.estado === "proposta");
      contarEntrega(ctx, banco, ativas);
      // 0.14.0: na visão geral, o perfil de cada tipo vem só com a forma (perfilEnxuto); o inteiro, com `tipo`.
      const perfis = listaDeTipos.map((g) => ({ tipo: g.tipo, conversas: g.conversas, perfil: perfilEnxuto(juntarAmostras(g.amostras)) }));
      const comMedida = (lista: readonly DaConversa[]) => lista.filter((d) => doTipoDeMensagem(d).mensagens > 0).length;
      // O teto de verdade: primeiro os perfis por tipo (caberNoTeto); se ainda passar, sai `ultimos_90_dias`, depois o
      // perfil de `aviso`, e o campo `aviso` diz o que saiu e como pedir.
      const sem = (perfil: Record<string, unknown>, recente: boolean, aviso: boolean): Record<string, unknown> => {
        const p: Record<string, unknown> = { ...perfil };
        if (recente) delete p.ultimos_90_dias;
        if (aviso && p.por_tipo_de_mensagem) {
          const { aviso: _fora, ...resto } = p.por_tipo_de_mensagem as Record<string, unknown>;
          p.por_tipo_de_mensagem = resto;
        }
        return p;
      };
      const montarVisao = (cortes: { recente: boolean; aviso: boolean }) => (fatia: readonly (typeof perfis)[number][], reduzida: boolean): Record<string, unknown> => {
        const avisos = [
          ...(reduzida ? ["Nem todos os perfis por tipo couberam: peça um tipo com `tipo`."] : []),
          ...(cortes.recente ? ["Para caber, saiu `ultimos_90_dias`: peça com `conversa` ou `tipo`."] : []),
          ...(cortes.aviso ? ["Para caber, saiu o perfil de `aviso` de `por_tipo_de_mensagem`: peça com `tipo_de_mensagem: \"aviso\"` (ou com `conversa` ou `tipo`)."] : []),
        ];
        return {
          ligado: true,
          ...(tm ? { tipo_de_mensagem: tm } : {}),
          contagens: {
            mensagens_do_dono_medidas: geral.amostra.mensagens,
            conversas_individuais: ind.length,
            grupos: grp.length,
            conversas_com_mensagem_medida: comMedida(porConversa),
            por_perfil: {
              individuais: { mensagens_medidas: individuais.amostra.mensagens, conversas: ind.length, com_mensagem_medida: comMedida(lado(ind)) },
              grupos: { mensagens_medidas: grupos.amostra.mensagens, conversas: grp.length, com_mensagem_medida: comMedida(lado(grp)) },
              geral: { mensagens_medidas: geral.amostra.mensagens, conversas: todas.length, com_mensagem_medida: comMedida(porConversa) },
            },
            pares: { individuais: contarPares(lado(ind).map((d) => d.pares)), grupos: contarPares(lado(grp).map((d) => d.pares)) },
          },
          individuais: sem(individuais.perfil, cortes.recente, cortes.aviso),
          grupos: sem(grupos.perfil, cortes.recente, cortes.aviso),
          geral: geral.perfil,
          ...(geral.amostra.mensagens < AMOSTRA_MINIMA ? { amostra_pequena: true } : {}),
          tipos: listaDeTipos.map((g) => ({ tipo: g.tipo, conversas: g.conversas })),
          sem_tipo: ind.filter((e) => tipos[e.jid] === undefined).length,
          grupos_sem_tipo: grp.filter((e) => tipos[e.jid] === undefined).length,
          por_tipo: fatia,
          regras_ativas: ativas.map((r) => regraPublica(banco, r)),
          propostas_pendentes: propostas.map((r) => regraPublica(banco, r)),
          ...(avisos.length > 0 ? { aviso: avisos.join(" ") } : {}),
          para_o_claude:
            `${FRASE_DO_JEITO} ${ativas.length > 0 ? FRASE_DAS_REGRAS : ""}`.trim() +
            " `individuais` é o jeito nas conversas diretas, `grupos` o jeito nos grupos escolhidos e `geral` os dois juntos: são medidos separados; para redigir num grupo, valem os números de `grupos` (ou os do grupo, com `conversa`)." +
            sobreOTipo +
            (propostas.length > 0 ? ` Há ${propostas.length} proposta(s) de regra esperando o dono. ${FRASE_DA_DECISAO}` : "") +
            " O tipo de cada conversa é o dono quem dá; não sugira nem adivinhe.",
        };
      };
      // Medido e enviado em JSON compacto (com recuo, os 10 perfis passavam do teto sozinhos). Ordem dos cortes:
      // `ultimos_90_dias`, o perfil de aviso, e só então os perfis por tipo (metade de cada vez).
      const cabe = (d: Record<string, unknown>) => JSON.stringify(d).length <= LIMITE_CARACTERES;
      let visao: Record<string, unknown> = {};
      fora: for (const cortes of [{ recente: false, aviso: false }, { recente: true, aviso: false }, { recente: true, aviso: true }]) {
        for (let n = perfis.length; ; n = Math.floor(n / 2)) {
          visao = montarVisao(cortes)(perfis.slice(0, n), n < perfis.length);
          if (cabe(visao)) break fora;
          if (n === 0 || (cortes.aviso === false && n === perfis.length)) break;
        }
      }
      return respostaJsonCompacta(visao);
    },
  );

  registrarLeitura(
    server,
    "wa_exemplos_do_meu_jeito",
    {
      title: "Exemplos reais do jeito do dono",
      description:
        "Para redigir uma resposta numa conversa: devolve de 3 a 10 (padrão 6) EXEMPLOS reais de mensagens do dono, cada um uma rajada (as mensagens dele seguidas em até 2 minutos, sem mensagem de outra pessoa no meio, com a quebra entre mensagens preservada). " +
        "Para um GRUPO: primeiro do próprio grupo; se faltar, de grupos do mesmo tipo, depois de qualquer grupo escolhido, depois de conversas individuais do mesmo tipo e por fim de qualquer conversa individual. " +
        "Para uma conversa INDIVIDUAL: primeiro dela; depois de individuais do mesmo tipo, de grupos do mesmo tipo (resposta a cliente em grupo serve para cliente no privado) e de qualquer conversa individual. " +
        "`origem` diz de onde veio (mesma_conversa, mesmo_tipo, mesmo_tipo_em_grupo, outro_grupo ou geral), sem dizer de que conversa. Variados: metade recentes, metade espalhada no tempo, com tamanhos diferentes. " +
        "Com `respondendo_a` (o texto da mensagem a responder), prefere o que o dono escreveu logo depois de uma mensagem recebida parecida (`criterio` diz o que valeu). " +
        "Nunca devolve mensagem de outra pessoa, rascunho da IA aceito sem edição, nem rajada com telefone, e-mail, link, dinheiro, código ou sequência de 6+ dígitos. Traz também as regras ativas que valem para a conversa. " +
        "Para O QUE o dono já respondeu a uma dúvida (não só a forma), use wa_como_eu_respondi.",
      inputSchema: z.strictObject({
        conversa: Conversa,
        quantos: z.number().int().min(3).max(10).default(6).describe("Quantos exemplos (3 a 10, padrão 6)"),
        respondendo_a: z.string().trim().min(1).max(2_000).optional().describe("O texto da mensagem a responder: prefere exemplos que vieram depois de mensagens parecidas"),
        tipo_de_mensagem: z
          .enum(["resposta", "aviso", "qualquer"])
          .default("resposta")
          .describe("resposta (padrão: para redigir resposta), aviso (para redigir um aviso; pode ter link do dono) ou qualquer"),
      }),
    },
    async ({ conversa, quantos, respondendo_a, tipo_de_mensagem: quer }) => {
      const { banco } = await ctx.nucleo();
      if (!banco.aprendizadoLigado()) return respostaJson({ ligado: false, para_o_claude: FRASE_DO_DESLIGADO });
      const e = banco.resolver(conversa);
      const tipo = banco.tipoDaConversa(e.jid);
      const tipos = banco.tiposDasConversas();
      const outras = banco.listarConversas().filter((x) => x.jid !== e.jid);
      const mesmoTipo = (x: EntradaIndice) => tipo !== undefined && tipos[x.jid] !== undefined && chaveDoTipo(tipos[x.jid]!) === chaveDoTipo(tipo);
      const indOutras = outras.filter((x) => !x.grupo);
      const grpOutros = outras.filter((x) => x.grupo);
      const indDoTipo = indOutras.filter(mesmoTipo).slice(0, CONVERSAS_DE_APOIO);
      const grpDoTipo = grpOutros.filter(mesmoTipo).slice(0, CONVERSAS_DE_APOIO);
      const menos = (lista: readonly EntradaIndice[], tirar: readonly EntradaIndice[]) => {
        const fora = new Set(tirar.map((x) => x.jid));
        return lista.filter((x) => !fora.has(x.jid)).slice(0, CONVERSAS_DE_APOIO).map((x) => x.jid);
      };
      const jidsDe = (lista: readonly EntradaIndice[]) => lista.map((x) => x.jid);
      // 0.13.0: grupo é cidadão de primeira classe. Para grupo: ele, grupos do mesmo tipo, qualquer grupo, individuais do
      // mesmo tipo, individuais em geral. Para individual: ela, individuais do mesmo tipo, grupos do mesmo tipo, geral.
      const origens: Array<{ origem: Origem; jids: string[] }> = e.grupo
        ? [
            { origem: "mesma_conversa", jids: [e.jid] },
            { origem: "mesmo_tipo_em_grupo", jids: jidsDe(grpDoTipo) },
            { origem: "outro_grupo", jids: menos(grpOutros, grpDoTipo) },
            { origem: "mesmo_tipo", jids: jidsDe(indDoTipo) },
            { origem: "geral", jids: menos(indOutras, indDoTipo) },
          ]
        : [
            { origem: "mesma_conversa", jids: [e.jid] },
            { origem: "mesmo_tipo", jids: jidsDe(indDoTipo) },
            { origem: "mesmo_tipo_em_grupo", jids: jidsDe(grpDoTipo) },
            { origem: "geral", jids: menos(indOutras, indDoTipo) },
          ];
      const fontes = new Map<string, FonteDeExemplos>();
      const fonte = (jid: string): FonteDeExemplos => {
        let f = fontes.get(jid);
        if (!f) {
          const mensagens = banco.lerMensagens(jid);
          const classificadas = classificarRajadas(mensagens, { grupo: jid.endsWith("@g.us") });
          f = { mensagens, rajadas: rajadasDoDono(mensagens), classificadas, tipoDe: new Map(classificadas.map((r) => [r.posicoes[0]!, r.tipo])) };
          fontes.set(jid, f);
        }
        return f;
      };
      const escolhidos: Array<{ origem: Origem; criterio: "parecida" | "variedade"; exemplo: Exemplo; tipo_de_mensagem: TipoDeMensagem }> = [];
      const aceita = (t: TipoDeMensagem) => quer === "qualquer" || t === quer;
      let completouComOutra = false;
      const usados = new Set<string>();

      // 1. Parecidas: o que o dono escreveu logo depois de uma mensagem recebida parecida (pelo índice de busca).
      let motivo: string | undefined;
      if (respondendo_a !== undefined) {
        const termos = termosParaParecidas(respondendo_a);
        if (termos.length === 0) motivo = "a mensagem a responder não tem palavras para comparar";
        else {
          for (const o of origens) {
            if (escolhidos.length >= quantos || o.jids.length === 0) continue;
            const achadas = await ctx.busca.parecidas(banco, termos, new Set(o.jids), 60);
            if (achadas === null) {
              motivo = ctx.busca.motor === "fts5" ? "o índice de busca falhou" : "o motor de busca é a varredura (sem índice)";
              break;
            }
            for (const a of achadas) {
              if (escolhidos.length >= quantos) break;
              const f = fonte(a.jid);
              const i = f.mensagens.findIndex((m) => m.id === a.id);
              if (i < 0) continue;
              const r = f.rajadas.find((x) => x.comeco > i);
              if (!r || r.inicio - a.ts > UM_DIA_MS) continue;
              const tipoDaRajada = f.tipoDe.get(r.comeco) ?? "outra";
              if (!aceita(tipoDaRajada) || tipoDaRajada === "aviso") continue;
              const chave = `${a.jid}|${r.comeco}`;
              if (usados.has(chave)) continue;
              const ex = exemploDaRajada(f.mensagens, r);
              if (!ex) continue;
              usados.add(chave);
              escolhidos.push({ origem: o.origem, criterio: "parecida", exemplo: ex, tipo_de_mensagem: tipoDaRajada });
            }
          }
          if (motivo === undefined && escolhidos.length === 0) motivo = "nenhuma mensagem recebida parecida com resposta do dono logo depois";
        }
      }

      // 2. Variedade: completa por origem, na ordem.
      for (const o of origens) {
        const faltam = quantos - escolhidos.length;
        if (faltam <= 0) break;
        let candidatos: CandidatoAExemplo[] = [];
        for (const [n, jid] of o.jids.entries()) {
          candidatos.push(...candidatosDa(jid, fonte(jid), quer).filter((c) => !usados.has(c.chave)));
          if ((n + 1) % 10 === 0) await cederAoLaco();
        }
        // 0.14.0: resposta por padrão; com menos de 3 respostas nesta origem, completa com `outra` (e diz).
        if (quer === "resposta") {
          const respostas = candidatos.filter((c) => c.tipo_de_mensagem === "resposta");
          if (respostas.length >= 3 || respostas.length >= faltam) candidatos = respostas;
          else if (candidatos.length > respostas.length) completouComOutra = true;
        }
        const preferidas = quer === "resposta" ? escolherPorVariedade(candidatos.filter((c) => c.tipo_de_mensagem === "resposta"), faltam, true) : [];
        const resto = escolherPorVariedade(candidatos.filter((c) => !preferidas.includes(c)), faltam - preferidas.length, true);
        for (const c of [...preferidas, ...(faltam - preferidas.length > 0 ? resto : [])]) {
          usados.add(c.chave);
          escolhidos.push({ origem: o.origem, criterio: "variedade", exemplo: { textos: c.textos, ts: c.ts, tamanho: c.tamanho }, tipo_de_mensagem: c.tipo_de_mensagem });
        }
      }

      const parecidas = escolhidos.filter((x) => x.criterio === "parecida").length;
      const criterio = respondendo_a === undefined || parecidas === 0 ? "variedade" : parecidas === escolhidos.length ? "respondendo_a" : "respondendo_a_e_variedade";
      const regras = regrasQueValem(banco, e.jid);
      contarEntrega(ctx, banco, regras);
      const ordem = (o: Origem) => origens.findIndex((x) => x.origem === o);
      const exemplos = escolhidos
        .sort((a, b) => ordem(a.origem) - ordem(b.origem))
        .map((x) => ({ origem: x.origem, criterio: x.criterio, tipo_de_mensagem: x.tipo_de_mensagem, tamanho: x.exemplo.tamanho, mensagens: x.exemplo.textos }));
      const completadas = completouComOutra && exemplos.some((x) => x.tipo_de_mensagem === "outra");
      return respostaJson(
        caberNoTeto(exemplos, (fatia, reduzida) => ({
          ligado: true,
          conversa: { id: banco.idPublico(e.jid), grupo: e.grupo },
          tipo: tipo ?? null,
          criterio,
          tipo_de_mensagem: quer,
          ...(completadas ? { completado_com_outra: true } : {}),
          ...(respondendo_a !== undefined && motivo !== undefined ? { por_que_variedade: motivo } : {}),
          exemplos: fatia,
          quantos: fatia.length,
          regras: regras.map((r) => regraPublica(banco, r)),
          ...(reduzida ? { aviso: "Menos exemplos para caber no limite de tamanho." } : {}),
          para_o_claude:
            (fatia.length > 0 ? FRASE_DOS_EXEMPLOS : "Não há mensagens do dono que sirvam de exemplo (poucas, ou todas com dado que não pode ser exemplo). Redija curto e simples, e mostre ao dono no cartão.") +
            (regras.length > 0 ? ` ${FRASE_DAS_REGRAS}` : "") +
            " Os números do jeito (wa_meu_jeito) são teto, não meta." +
            (completadas ? " Havia poucas respostas do dono para servir de exemplo: alguns exemplos são de outro tipo (`tipo_de_mensagem: outra`); pese menos a forma deles." : "") +
            (quer === "aviso" ? " São AVISOS do dono (podem ter link dele): para redigir um aviso, não uma resposta." : "") +
            (respondendo_a !== undefined ? " Para o conteúdo de uma dúvida, veja wa_como_eu_respondi (o que o dono já respondeu)." : ""),
        })),
      );
    },
  );

  registrarLeitura(
    server,
    "wa_edicoes_dos_rascunhos",
    {
      title: "O que o dono mudou nos rascunhos",
      description:
        "Lista as edições que o dono fez nos cartões antes de enviar (rascunho da IA contra o texto enviado), só as não mínimas e, por padrão, as ainda não vistas pelo aprendizado: o rascunho (em anotacao_da_ia), o enviado (do dono), o resumo estrutural medido por código (tamanho, emoji, saudação, fecho, caixa inicial, linhas, palavras tiradas e postas), a data e o tipo da conversa. " +
        "Filtro por `conversa`; `ids` traz edições específicas (inclusive vistas: as de uma proposta); `incluir_vistas`; paginação com `cursor`. " +
        "Traz também as estatísticas: quantos rascunhos saíram, quantos sem edição, e a edição mediana dos últimos 20 contra os 20 anteriores (se o aprendizado está funcionando, ela cai).",
      inputSchema: z.strictObject({
        conversa: Conversa.optional(),
        ids: z.array(IdDeEdicao).min(1).max(20).optional().describe("Edições específicas (e_...), por exemplo as de uma proposta"),
        incluir_vistas: z.boolean().default(false).describe("Traz também as já vistas pelo aprendizado"),
        limite: z.number().int().min(1).max(50).default(20).describe("Quantas por página (padrão 20)"),
        cursor: z.string().regex(/^\d{1,6}$/).optional().describe("O `proximo` da página anterior"),
      }),
    },
    async ({ conversa, ids, incluir_vistas, limite, cursor }) => {
      const { banco } = await ctx.nucleo();
      if (!banco.aprendizadoLigado()) return respostaJson({ ligado: false, para_o_claude: FRASE_DO_DESLIGADO });
      const jid = conversa !== undefined ? banco.resolver(conversa).jid : undefined;
      const tipos = banco.tiposDasConversas();
      const pedidos = ids ? new Set(ids) : undefined;
      const lista = banco
        .edicoes()
        .filter((x) => (jid === undefined || x.conversa === jid) && (pedidos ? pedidos.has(x.id) : incluir_vistas || !x.vista))
        .sort((a, b) => b.em - a.em);
      const { envios, desistencias } = banco.enviosDeRascunho();
      const distancias = envios.map((x) => x.distancia);
      const ultimos = distancias.slice(-20);
      const anteriores = distancias.slice(-40, -20);
      const estatisticas = {
        rascunhos_enviados: envios.length,
        aceitos_sem_edicao: envios.filter((x) => x.marca === "sem_edicao").length,
        com_edicao_minima: envios.filter((x) => x.marca === "edicao_minima").length,
        editados: envios.filter((x) => x.marca === "editado").length,
        cancelados: desistencias.cancelados,
        vencidos: desistencias.expirados,
        edicao_mediana_ultimos_20: ultimos.length > 0 ? mediana(ultimos) : null,
        edicao_mediana_20_anteriores: anteriores.length > 0 ? mediana(anteriores) : null,
      };
      const inicio = cursor ? Number(cursor) : 0;
      const pagina = lista.slice(inicio, inicio + limite);
      // 0.14.0: o que o dono sempre corta ou põe, achado por código (cortes.ts), sobre todas as edições guardadas.
      const cortes = candidatosDasEdicoes(banco.edicoes(), tipos, banco.regras());
      return respostaJson(
        caberNoTeto(pagina, (fatia, reduzida) => ({
          ligado: true,
          edicoes: fatia.map((x) => ({
            id: x.id,
            conversa: { id: banco.idPublico(x.conversa) },
            tipo_da_conversa: tipos[x.conversa] ?? null,
            data: dataIso(x.em),
            ferramenta: x.ferramenta satisfies FerramentaDoRascunho,
            vista: x.vista,
            distancia: x.distancia,
            resumo: x.resumo,
            enviado: x.enviado,
            anotacao_da_ia: { rascunho: x.rascunho },
          })),
          total: lista.length,
          proximo: inicio + fatia.length < lista.length ? String(inicio + fatia.length) : null,
          estatisticas,
          candidatos: cortes.candidatos.map((c) => candidatoPublico(banco, c)),
          ...(cortes.faltam > 0 ? { candidatos_faltam_edicoes: cortes.faltam } : {}),
          ...(reduzida ? { aviso: "Página reduzida para caber no limite de tamanho; continue com `proximo`." } : {}),
          para_o_claude:
            "O `enviado` é do dono; o rascunho (anotacao_da_ia) foi seu. Procure padrões que se repetem em pelo menos DUAS edições de dias ou conversas diferentes e proponha com wa_aprender (`propor`, com os ids); uma edição só nunca vira regra. " +
            (cortes.candidatos.length > 0
              ? "`candidatos` são padrões que o servidor achou por conta (o que o dono corta ou põe em 3+ edições, 60%+ das vezes): para propor um, wa_aprender com `propor: [{ candidato: <id> }]`; mostre ao dono o texto sugerido e as edições, e só aceite com o sim dele. "
              : cortes.faltam > 0
                ? `Faltam ${cortes.faltam} edição(ões) não mínima(s) para o servidor começar a sugerir candidatos. `
                : "") +
            "Depois de olhar, marque as vistas (wa_aprender com `marcar_vistas`). " +
            FRASE_DA_DECISAO,
        })),
      );
    },
  );

  registrarEscritaDireta(
    server,
    "wa_aprender",
    { destrutiva: false, idempotente: false },
    {
      title: "Ensinar o jeito do dono (regras e tipos)",
      description:
        "Muda o aprendizado do jeito do dono, só neste computador e cifrado: " +
        "`propor` (até 5 regras de forma, cada uma com `texto` de até 200 caracteres, uma instrução concreta como \"não usar 'prezado'\", `escopo` geral, tipo ou conversa e os ids de pelo menos DUAS `edicoes` de dias ou conversas diferentes, de wa_edicoes_dos_rascunhos; ou só `candidato`, o id de um candidato de wa_edicoes_dos_rascunhos, e o servidor preenche; entra como proposta, não ativa); " +
        "`decidir` (`id` e `decisao` aceitar ou recusar): SÓ depois de o dono responder sim (ou não) a essa regra, na conversa, vendo o texto e as edições que a geraram; nunca por conta própria; " +
        "`regra_do_dono` (o dono dita uma regra com as palavras dele: entra ativa); `desligar` e `apagar` (ids de regra); " +
        "`tipo_da_conversa` (até 30: `conversa` e `tipo`, um texto curto como cliente, aluno, família, equipe, fornecedor, só com as palavras do dono; null tira); `marcar_vistas` (ids de edição); " +
        "`ligar` (false desliga o modo de aprendizado: para de guardar e de entregar; true liga). No máximo 30 regras ativas. Não muda nada no WhatsApp.",
      inputSchema: z
        .strictObject({
          ligar: z.boolean().optional().describe("false desliga o modo de aprendizado; true liga (começa ligado)"),
          propor: z
            .array(
              z
                .strictObject({
                  candidato: z.string().regex(/^cand_[0-9a-f]{8}$/).optional().describe("0.14.0: o id de um candidato de wa_edicoes_dos_rascunhos, no lugar de `texto` e `edicoes` (o servidor preenche)"),
                  texto: TextoDeRegra.optional().describe("Uma instrução concreta de forma"),
                  escopo: Escopo.optional(),
                  tipo: Tipo.optional(),
                  conversa: Conversa.optional(),
                  edicoes: z.array(IdDeEdicao).min(1).max(20).optional().describe("Os ids (e_...) de pelo menos duas edições que mostram o padrão"),
                })
                .refine((v) => v.candidato !== undefined || (v.texto !== undefined && v.edicoes !== undefined && v.escopo !== undefined), { message: "Passe `candidato`, ou `texto`, `escopo` e `edicoes`." }),
            )
            .max(5)
            .optional(),
          decidir: z
            .strictObject({ id: IdDeRegra, decisao: z.enum(["aceitar", "recusar"]) })
            .optional()
            .describe("Só depois do sim (ou não) do dono a essa regra"),
          regra_do_dono: z
            .strictObject({ texto: TextoDeRegra, escopo: Escopo, tipo: Tipo.optional(), conversa: Conversa.optional() })
            .optional()
            .describe("Uma regra que o dono ditou: entra ativa"),
          desligar: z.array(IdDeRegra).min(1).max(30).optional(),
          apagar: z.array(IdDeRegra).min(1).max(30).optional(),
          tipo_da_conversa: z
            .array(z.strictObject({ conversa: Conversa, tipo: z.string().trim().max(TAMANHO_MAXIMO_DO_TIPO).refine(SEM_NUMERO, { message: MENSAGEM_DO_NUMERO }).nullable().describe("O tipo nas palavras do dono; null tira") }))
            .min(1)
            .max(30)
            .optional(),
          marcar_vistas: z.array(IdDeEdicao).min(1).max(100).optional(),
        })
        .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "Passe pelo menos uma ação." }),
    },
    async ({ ligar, propor, decidir, regra_do_dono, desligar, apagar, tipo_da_conversa, marcar_vistas }) => {
      const { banco } = await ctx.nucleo();
      const ligadoDepois = ligar ?? banco.aprendizadoLigado();
      const ensina = propor !== undefined || decidir !== undefined || regra_do_dono !== undefined || tipo_da_conversa !== undefined || marcar_vistas !== undefined;
      if (!ligadoDepois && ensina) throw new Error(`${FRASE_DO_DESLIGADO} Nada foi gravado.`);
      const mudouLigado = ligar !== undefined ? banco.definirAprendizado(ligar) : false;
      // As conversas pedidas viram jid aqui; a que não existe é recusada com o motivo, sem parar o resto.
      const recusadosAntes: Array<{ lista: string; posicao: number; motivo: string }> = [];
      const jidDe = (lista: string, posicao: number, ref: string | undefined): string | undefined | null => {
        if (ref === undefined) return undefined;
        try {
          return banco.resolver(ref).jid;
        } catch (erro) {
          recusadosAntes.push({ lista, posicao, motivo: erro instanceof Error ? erro.message : String(erro) });
          return null;
        }
      };
      const pedido: PedidoDeAprendizado = {};
      if (propor) {
        const lista: NonNullable<PedidoDeAprendizado["propor"]>[number][] = [];
        const candidatos = propor.some((p) => p.candidato !== undefined) ? candidatosDasEdicoes(banco.edicoes(), banco.tiposDasConversas(), banco.regras()).candidatos : [];
        for (const [i, p] of propor.entries()) {
          if (p.candidato !== undefined) {
            // 0.14.0: o servidor preenche o texto, as edições e (se não veio) o escopo; continua entrando como PROPOSTA.
            const k = candidatos.find((x) => x.id === p.candidato);
            if (!k) {
              recusadosAntes.push({ lista: "propor", posicao: i + 1, motivo: "Esse candidato não existe mais (as edições mudaram, ou a regra já existe). Veja wa_edicoes_dos_rascunhos." });
              continue;
            }
            const escopo = p.escopo ?? k.escopo;
            const c = p.conversa !== undefined ? jidDe("propor", i + 1, p.conversa) : escopo === "conversa" ? k.conversa : undefined;
            if (c === null) continue;
            const tipoDaRegra = p.tipo ?? (escopo === "tipo" ? k.tipo_da_conversa : undefined);
            lista.push({ texto: p.texto ?? k.texto_sugerido, escopo, edicoes: p.edicoes ?? k.edicoes, ...(tipoDaRegra !== undefined ? { tipo: tipoDaRegra } : {}), ...(c !== undefined ? { conversa: c } : {}) });
            continue;
          }
          const c = jidDe("propor", i + 1, p.conversa);
          if (c === null) continue;
          lista.push({ texto: p.texto!, escopo: p.escopo!, edicoes: p.edicoes!, ...(p.tipo !== undefined ? { tipo: p.tipo } : {}), ...(c !== undefined ? { conversa: c } : {}) });
        }
        pedido.propor = lista;
      }
      if (decidir) pedido.decidir = decidir;
      if (regra_do_dono) {
        const c = jidDe("regra_do_dono", 1, regra_do_dono.conversa);
        if (c !== null) pedido.regra_do_dono = { texto: regra_do_dono.texto, escopo: regra_do_dono.escopo, ...(regra_do_dono.tipo !== undefined ? { tipo: regra_do_dono.tipo } : {}), ...(c !== undefined ? { conversa: c } : {}) };
      }
      if (desligar) pedido.desligar = desligar;
      if (apagar) pedido.apagar = apagar;
      if (tipo_da_conversa) {
        const tipos: Array<{ conversa: string; tipo: string | null }> = [];
        for (const [i, t] of tipo_da_conversa.entries()) {
          const c = jidDe("tipo_da_conversa", i + 1, t.conversa);
          if (c) tipos.push({ conversa: c, tipo: t.tipo === null || t.tipo === "" ? null : t.tipo });
        }
        pedido.tipos = tipos;
      }
      if (marcar_vistas) pedido.marcar_vistas = marcar_vistas;
      const r = Object.keys(pedido).length > 0 ? banco.aprender(pedido, ctx.agora()) : { propostas: [], desligadas: [], apagadas: [], tipos: 0, vistas: 0, recusados: [] };
      const recusados = [...recusadosAntes, ...r.recusados];
      // Registro de ações: só contagens (nem id de conversa, nem texto de regra, nem tipo).
      ctx.registro.gravar({
        acao: "wa_aprender",
        ...(ligar !== undefined ? { ligar, mudou: mudouLigado } : {}),
        propostas: r.propostas.length,
        decidida: r.decidida !== undefined,
        regra_do_dono: r.regra_do_dono !== undefined,
        desligadas: r.desligadas.length,
        apagadas: r.apagadas.length,
        tipos: r.tipos,
        vistas: r.vistas,
        recusados: recusados.length,
      });
      return respostaJson({
        ligado: banco.aprendizadoLigado(),
        ...(r.propostas.length > 0 ? { propostas: r.propostas } : {}),
        ...(r.decidida ? { decidida: r.decidida } : {}),
        ...(r.regra_do_dono ? { regra_do_dono: r.regra_do_dono } : {}),
        ...(r.desligadas.length > 0 ? { desligadas: r.desligadas } : {}),
        ...(r.apagadas.length > 0 ? { apagadas: r.apagadas } : {}),
        ...(r.tipos > 0 ? { tipos_gravados: r.tipos } : {}),
        ...(r.vistas > 0 ? { edicoes_vistas: r.vistas } : {}),
        ...(recusados.length > 0 ? { recusados } : {}),
        para_o_claude:
          (recusados.length > 0 ? "Alguns itens foram recusados (veja `recusados`, com o motivo); os outros foram gravados. " : "Gravado. ") +
          (r.propostas.length > 0 ? `Proposta não é regra: ${FRASE_DA_DECISAO} ` : "") +
          (ligar === false ? "O modo de aprendizado foi desligado: nada novo é guardado e nada é entregue até ligar de novo. " : "") +
          "Tudo fica só neste computador, cifrado; nada mudou no WhatsApp. O dono pode ver tudo (wa_meu_jeito), desligar e esquecer (wa_esquecer com `aprendizado: true`).",
      });
    },
  );
}

/** O envio de um rascunho: o par vai para o aprendizado (se ligado). Nunca derruba o envio. */
export function aprenderComOEnvio(banco: Banco, par: { conversa: string; mensagem_id: string; ferramenta: FerramentaDoRascunho; rascunho: string; enviado: string; em: number }): void {
  try {
    if (banco.aprendizadoLigado()) banco.guardarEnvioDeRascunho(par);
  } catch {
    // aprender nunca muda o resultado do envio
  }
}

/** O cartão de rascunho terminou sem envio: só a contagem (se ligado). */
export const contarDesistencia =
  (banco: Banco) =>
  (motivo: "cancelado" | "expirado"): void => {
    try {
      if (banco.aprendizadoLigado()) banco.contarRascunhoSemEnvio(motivo);
    } catch {
      // idem
    }
  };

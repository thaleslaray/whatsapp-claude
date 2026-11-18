// 0.13.0: wa_como_eu_respondi. O jeito (wa_meu_jeito, wa_exemplos_do_meu_jeito) entrega a FORMA; aqui vai o CONTEÚDO:
// o que o dono já respondeu a dúvidas parecidas. Cada resposta dele a uma pergunta de cliente é a resposta oficial dele
// para aquela dúvida (no dado real, sobretudo nos grupos).
// - Acha mensagens RECEBIDAS parecidas com a pergunta pelo índice de busca que já existe (busca.ts, `parecidas`; com o
//   motor na varredura, a varredura) e devolve só as que formam um PAR com uma rajada do dono (pares.ts): `citada`
//   (ligação forte) ou `sequencia` (fraca).
// - Ao contrário dos exemplos de forma, a resposta do dono PODE ter número, link e valor: é para isso que serve. A
//   pergunta é de terceiros (em `conteudo_de_terceiros`, como chegou, com telefone e tudo). O LID nunca sai.
// - Rascunho da IA aceito sem edição (ou com edição mínima) não é o dono: fica fora, a não ser com
//   `incluir_rascunhos_da_ia`, e aí vem marcado.
// - Os pares não vão para arquivo: vêm do cache em memória do jeito (ids e datas), e o texto é lido na hora.
// Leitura: roda também na cópia leitora (WA_LEITURA_LOCAL). Nada vai para registro nem caixa-preta.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { conversaPublica, dataIso, remetentePublico } from "../apresentacao.ts";
import type { EntradaIndice, MensagemGuardada } from "../banco.ts";
import type { Contexto } from "../contexto.ts";
import { chaveDoTipo, TAMANHO_MAXIMO_DO_TIPO, termosParaParecidas, UM_DIA_MS } from "../jeito.ts";
import { textosDaResposta, type Par } from "../pares.ts";
import { caberNoTeto, registrarLeitura, respostaJson } from "../respostas.ts";
import { FRASE_DO_DESLIGADO } from "./jeito.ts";
import { AVISO_TERCEIROS } from "./leitura.ts";

/** A pergunta sai com até isto de caracteres. */
export const CARACTERES_DA_PERGUNTA = 300;
/** Resposta mais velha que isto: pergunte ao dono se ainda vale. */
export const DIAS_PARA_CONFERIR = 60;
/** Quantas recebidas parecidas a busca traz para procurar pares (a maioria não terá resposta do dono). */
const CANDIDATAS = 300;

/** O trecho da pergunta: o texto como chegou, até 300 caracteres. */
function trechoDaPergunta(texto: string): string {
  const t = [...texto.trim()];
  return t.length > CARACTERES_DA_PERGUNTA ? `${t.slice(0, CARACTERES_DA_PERGUNTA).join("")}…` : t.join("");
}

const PARA_O_CLAUDE =
  "São respostas que o dono DEU no passado a dúvidas parecidas: servem de base para o rascunho (o conteúdo, não só a forma), mas podem estar velhas (preço, prazo e regra mudam). " +
  `Quando usar uma, diga ao dono a data dela. Se a resposta tem mais de ${DIAS_PARA_CONFERIR} dias, ou se há duas respostas diferentes para a mesma dúvida, pergunte ao dono qual vale em vez de escolher. ` +
  "`ligacao: citada` é a resposta que citou a pergunta (forte); `sequencia` veio logo depois de uma pergunta (fraca: confira se responde mesmo). " +
  "A forma continua vindo de wa_meu_jeito e wa_exemplos_do_meu_jeito.";

export function registrarComoEuRespondi(server: McpServer, ctx: Contexto): void {
  registrarLeitura(
    server,
    "wa_como_eu_respondi",
    {
      title: "Como o dono já respondeu a uma dúvida",
      description:
        "Antes de redigir a resposta a uma dúvida: acha, pelo índice de busca, mensagens RECEBIDAS parecidas com `pergunta` e devolve as respostas que o dono DEU a elas (o que ele respondeu, não só como), em grupos escolhidos e em conversas individuais. " +
        "Cada item traz a pergunta (em conteudo_de_terceiros, trecho de até 300 caracteres), a resposta do dono (a rajada: até 6 mensagens e 800 caracteres; pode ter número, link e valor), a data, há quantos dias, a conversa e a `ligacao`: `citada` (a resposta citou a pergunta, forte) ou `sequencia` (veio logo depois de uma pergunta, fraca). " +
        "Ordem: citada antes de sequencia, depois a mais parecida, depois a mais recente. Filtros: `conversa` ou `tipo`, `so_grupos`; `limite` (padrão 5, até 10). " +
        "Respostas enviadas de rascunho da IA sem edição ficam fora, a não ser com `incluir_rascunhos_da_ia` (aí vêm marcadas). " +
        'Exemplos: "um cliente perguntou o prazo de entrega, como eu costumo responder?", "o que eu já respondi sobre reembolso?".',
      inputSchema: z
        .strictObject({
          pergunta: z.string().trim().min(1).max(2_000).describe("A dúvida a responder (o texto da mensagem recebida, ou a dúvida em poucas palavras)"),
          conversa: z.string().trim().min(1).max(200).optional().describe("Só nesta conversa: id (c_... ou g_...), nome único ou número"),
          tipo: z.string().trim().min(1).max(TAMANHO_MAXIMO_DO_TIPO).optional().describe("Só nas conversas (individuais e grupos) deste tipo dado pelo dono"),
          so_grupos: z.boolean().default(false).describe("Só nos grupos escolhidos"),
          limite: z.number().int().min(1).max(10).default(5).describe("Quantas respostas (1 a 10, padrão 5)"),
          incluir_rascunhos_da_ia: z.boolean().default(false).describe("Inclui as respostas enviadas de rascunho da IA sem edição (marcadas)"),
        })
        .refine((v) => v.conversa === undefined || v.tipo === undefined, { message: "Passe `conversa` ou `tipo`, não os dois." }),
    },
    async ({ pergunta, conversa, tipo, so_grupos, limite, incluir_rascunhos_da_ia }) => {
      const { banco } = await ctx.nucleo();
      if (!banco.aprendizadoLigado()) return respostaJson({ ligado: false, para_o_claude: FRASE_DO_DESLIGADO });
      const agora = ctx.agora();
      const tipos = banco.tiposDasConversas();
      let alvo: EntradaIndice[];
      if (conversa !== undefined) alvo = [banco.resolver(conversa)];
      else {
        alvo = banco.listarConversas();
        if (tipo !== undefined) alvo = alvo.filter((e) => tipos[e.jid] !== undefined && chaveDoTipo(tipos[e.jid]!) === chaveDoTipo(tipo));
      }
      if (so_grupos) alvo = alvo.filter((e) => e.grupo);
      const termos = termosParaParecidas(pergunta);
      const vazio = (motivo: string, caminho?: string) =>
        respostaJson({ ligado: true, respostas: [], quantas: 0, ...(caminho ? { caminho } : {}), motivo, para_o_claude: `${motivo} Redija com o que o dono disser, e pergunte a ele o que responder se a dúvida pedir um fato (preço, prazo, regra).` });
      if (termos.length === 0) return vazio("A pergunta não tem palavras para comparar (só palavras comuns ou curtas).");
      if (alvo.length === 0) return vazio("Nenhuma conversa guardada cabe nos filtros.");

      const { achadas, caminho } = await ctx.busca.parecidasEmQualquerMotor(banco, termos, new Set(alvo.map((e) => e.jid)), CANDIDATAS);
      // Os pares de cada conversa achada (do cache do jeito, sem texto) e a relevância da pergunta (posição na busca).
      const paresDe = new Map<string, Map<string, Par[]>>();
      const candidatos: Array<{ jid: string; par: Par; posicao: number }> = [];
      let foraPorRascunho = 0;
      achadas.forEach((a, posicao) => {
        let porPergunta = paresDe.get(a.jid);
        if (!porPergunta) {
          porPergunta = new Map();
          for (const p of ctx.jeito.daConversa(banco, a.jid).pares) porPergunta.set(p.pergunta_id, [...(porPergunta.get(p.pergunta_id) ?? []), p]);
          paresDe.set(a.jid, porPergunta);
        }
        for (const par of porPergunta.get(a.id) ?? []) {
          if (par.rascunho_da_ia && !incluir_rascunhos_da_ia) {
            foraPorRascunho++;
            continue;
          }
          candidatos.push({ jid: a.jid, par, posicao });
        }
      });
      if (candidatos.length === 0) {
        return vazio(
          achadas.length === 0
            ? "Nenhuma mensagem recebida parecida com essa pergunta nas conversas guardadas."
            : `Há mensagens recebidas parecidas, mas nenhuma com resposta do dono ligada a ela${foraPorRascunho > 0 ? ` (${foraPorRascunho} respondida(s) só por rascunho da IA sem edição, fora a não ser com \`incluir_rascunhos_da_ia\`)` : ""}.`,
          caminho,
        );
      }
      const forca = (p: Par) => (p.ligacao === "citada" ? 0 : 1);
      candidatos.sort((a, b) => forca(a.par) - forca(b.par) || a.posicao - b.posicao || b.par.resposta_ts - a.par.resposta_ts);
      const escolhidos = candidatos.slice(0, limite);

      const lidas = new Map<string, Map<string, MensagemGuardada>>();
      const mensagensDe = (jid: string) => {
        let m = lidas.get(jid);
        if (!m) {
          m = new Map(banco.lerMensagens(jid).map((x) => [x.id, x]));
          lidas.set(jid, m);
        }
        return m;
      };
      const respostas = escolhidos.flatMap(({ jid, par }) => {
        const e = banco.entrada(jid);
        const mensagens = mensagensDe(jid);
        const p = mensagens.get(par.pergunta_id);
        if (!e || !p) return []; // a conversa (ou a mensagem) sumiu entre o cache e agora
        const textos = par.resposta_ids.flatMap((id) => {
          const t = mensagens.get(id)?.texto?.trim();
          return t ? [t] : [];
        });
        if (textos.length === 0) return [];
        const { mensagens: resposta, cortada } = textosDaResposta(textos);
        const quem = banco.quemEscreveu(jid, p);
        return [
          {
            ligacao: par.ligacao,
            conversa: conversaPublica(banco, e),
            tipo_da_conversa: tipos[jid] ?? null,
            data: dataIso(par.resposta_ts),
            ha_dias: Math.max(0, Math.floor((agora - par.resposta_ts) / UM_DIA_MS)),
            pergunta: {
              mensagem_id: p.id,
              data: dataIso(p.ts),
              conteudo_de_terceiros: { trecho: trechoDaPergunta(p.texto ?? ""), ...(quem ? { remetente: remetentePublico(quem) } : {}) },
            },
            resposta: {
              mensagens: resposta,
              ...(cortada ? { cortada: true } : {}),
              ...(par.rascunho_da_ia ? { rascunho_da_ia: par.rascunho_da_ia } : {}),
            },
          },
        ];
      });
      const velhas = respostas.filter((r) => r.ha_dias > DIAS_PARA_CONFERIR).length;
      const fracas = respostas.filter((r) => r.ligacao === "sequencia").length;
      return respostaJson(
        caberNoTeto(respostas, (fatia, reduzida) => ({
          ligado: true,
          respostas: fatia,
          quantas: fatia.length,
          caminho,
          ...(foraPorRascunho > 0 && !incluir_rascunhos_da_ia ? { fora_por_ser_rascunho_da_ia: foraPorRascunho } : {}),
          ...(velhas > 0 ? { aviso: `${velhas} resposta(s) com mais de ${DIAS_PARA_CONFERIR} dias: pergunte ao dono se ainda vale.` } : {}),
          ...(reduzida ? { aviso_de_tamanho: "Menos respostas para caber no limite de tamanho." } : {}),
          para_o_claude:
            `${PARA_O_CLAUDE} ${AVISO_TERCEIROS}` +
            (fracas > 0 ? ` ${fracas} delas é(são) ligação fraca (sequencia).` : "") +
            (fatia.some((r) => r.resposta.rascunho_da_ia) ? " As marcadas com `rascunho_da_ia` foram escritas pela IA e aceitas pelo dono sem editar: não são a voz dele." : ""),
        })),
      );
    },
  );
}

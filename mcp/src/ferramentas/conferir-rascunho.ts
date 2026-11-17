// 0.14.0: wa_conferir_rascunho. Antes de abrir o cartão de resposta, o modelo confere o rascunho contra o jeito medido
// do dono (conferencia.ts, só contas) e contra as regras ativas que dá para conferir por código ("não usar 'X'").
// O perfil que vale: o das RESPOSTAS da conversa (20+ mensagens), senão o das respostas do tipo dela, senão o das
// respostas do mesmo lado (grupos ou individuais), senão o do lado inteiro.
// Leitura: roda também na cópia leitora (WA_LEITURA_LOCAL). O texto do rascunho não é guardado nem vai para log,
// registro ou caixa-preta.

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Contexto } from "../contexto.ts";
import { conferirContraOJeito, formalidadesNo, proibidoDaRegra, violaProibido } from "../conferencia.ts";
import { AMOSTRA_MINIMA, chaveDoTipo, juntarAmostras, type AmostraDoJeito } from "../jeito.ts";
import { registrarLeitura, respostaJson } from "../respostas.ts";
import { FRASE_DO_DESLIGADO, regraPublica, regrasQueValem } from "./jeito.ts";
import { LIMITE_DO_TEXTO } from "./escrita.ts";

const PARA_O_CLAUDE =
  "Ajuste o rascunho ANTES de abrir o cartão. Desvio é aviso, não proibição: se o conteúdo pede uma resposta longa (ou formal), ela pode ser, e diga isso ao dono no cartão. " +
  "Não invente tique que os números não mostram (não enfie emoji, gíria ou risada só para parecer o dono). As regras violadas valem acima dos números; as `regras_a_conferir` não dá para conferir por código: confira você.";

export function registrarConferirRascunho(server: McpServer, ctx: Contexto): void {
  registrarLeitura(
    server,
    "wa_conferir_rascunho",
    {
      title: "Conferir um rascunho contra o jeito do dono",
      description:
        "Antes de abrir o cartão de uma resposta: confere o rascunho (`texto`, ou `mensagens` quando a resposta vai em várias) contra o jeito MEDIDO do dono naquela conversa (o perfil das respostas dela com 20+ mensagens, senão o do tipo, senão o de grupos ou de individuais), só com contas. " +
        "Devolve `desvios` (palavras acima do p90 dele, caixa da primeira letra, ponto final, emoji, \"!\", saudação ou fecho que ele não usa, uma mensagem só quando ele quebra as longas, formalidade que ele nunca escreveu), cada um com o valor do rascunho, o normal do dono e uma frase; " +
        "`regras_violadas` (regras ativas do tipo \"não usar 'X'\" que o texto viola), `regras_a_conferir` (as outras regras ativas que valem) e `resumo`. Não guarda o rascunho. " +
        'Exemplos: "confere se isso está no meu jeito antes de mandar".',
      inputSchema: z
        .strictObject({
          conversa: z.string().trim().min(1).max(200).describe("id (c_... ou g_...), nome único ou número da conversa"),
          texto: z.string().min(1).max(20_000).optional().describe(`O rascunho (até ${LIMITE_DO_TEXTO} caracteres)`),
          mensagens: z.array(z.string().min(1).max(20_000)).min(1).max(10).optional().describe("O rascunho em várias mensagens, na ordem"),
        })
        .refine((v) => (v.texto === undefined) !== (v.mensagens === undefined), { message: "Passe `texto` ou `mensagens` (um dos dois)." }),
    },
    async ({ conversa, texto, mensagens }) => {
      const { banco } = await ctx.nucleo();
      if (!banco.aprendizadoLigado()) return respostaJson({ ligado: false, para_o_claude: FRASE_DO_DESLIGADO });
      const textos = mensagens ?? [texto!];
      const e = banco.resolver(conversa);
      const tipos = banco.tiposDasConversas();
      const todas = banco.listarConversas();
      const resposta = (jids: readonly string[]): AmostraDoJeito => juntarAmostras(jids.map((j) => ctx.jeito.daConversa(banco, j).porTipo.resposta));
      const tipo = tipos[e.jid];
      const lado = todas.filter((x) => x.grupo === e.grupo).map((x) => x.jid);
      const nomeDoLado = e.grupo ? "grupos" : "individuais";
      let perfilUsado: { de: string; tipo_de_mensagem: string; tipo?: string };
      let amostra = resposta([e.jid]);
      if (amostra.mensagens >= AMOSTRA_MINIMA) perfilUsado = { de: "conversa", tipo_de_mensagem: "resposta" };
      else {
        const doTipo = tipo !== undefined ? resposta(todas.filter((x) => tipos[x.jid] !== undefined && chaveDoTipo(tipos[x.jid]!) === chaveDoTipo(tipo)).map((x) => x.jid)) : undefined;
        if (doTipo && doTipo.mensagens >= AMOSTRA_MINIMA) [amostra, perfilUsado] = [doTipo, { de: "tipo", tipo, tipo_de_mensagem: "resposta" }];
        else {
          const doLado = resposta(lado);
          if (doLado.mensagens >= AMOSTRA_MINIMA) [amostra, perfilUsado] = [doLado, { de: nomeDoLado, tipo_de_mensagem: "resposta" }];
          else [amostra, perfilUsado] = [juntarAmostras(lado.map((j) => ctx.jeito.daConversa(banco, j).amostra)), { de: nomeDoLado, tipo_de_mensagem: "todas" }];
        }
      }
      // Formalidade: só se o rascunho tem alguma, e só acusa a que o dono nunca escreveu (confere nas mensagens dele).
      const noRascunho = new Set(textos.flatMap(formalidadesNo));
      const doDono = new Set<string>();
      if (noRascunho.size > 0) {
        for (const c of todas) {
          for (const m of banco.lerMensagens(c.jid)) if (m.de_mim && m.texto) for (const f of formalidadesNo(m.texto)) doDono.add(f);
          if ([...noRascunho].every((f) => doDono.has(f))) break;
        }
      }
      const desvios = conferirContraOJeito(textos, amostra, doDono);
      const regras = regrasQueValem(banco, e.jid);
      const violadas: Array<Record<string, unknown>> = [];
      const aConferir: Array<Record<string, unknown>> = [];
      for (const r of regras) {
        const proibido = proibidoDaRegra(r.texto);
        if (proibido === undefined) aConferir.push(regraPublica(banco, r));
        else if (violaProibido(textos, proibido)) violadas.push({ ...regraPublica(banco, r), proibido });
      }
      const n = desvios.length + violadas.length;
      return respostaJson({
        ligado: true,
        conversa: { id: banco.idPublico(e.jid), grupo: e.grupo },
        perfil_usado: { ...perfilUsado, mensagens_medidas: amostra.mensagens, ...(amostra.mensagens < AMOSTRA_MINIMA ? { amostra_pequena: true } : {}) },
        desvios,
        regras_violadas: violadas,
        regras_a_conferir: aConferir,
        resumo: n === 0 ? "dentro do seu normal" : `${n} desvio${n === 1 ? "" : "s"}`,
        para_o_claude: PARA_O_CLAUDE + (amostra.mensagens < AMOSTRA_MINIMA ? ` Há poucas mensagens do dono para comparar (${amostra.mensagens}): os desvios são fracos.` : ""),
      });
    },
  );
}

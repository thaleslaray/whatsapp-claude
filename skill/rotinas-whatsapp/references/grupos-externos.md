# Rotina: Resumo dos grupos que o dono acompanha

> A lista real (grupos, pessoas, sinais aprovados) fica em `~/Documents/WhatsApp Claude/rotinas/grupos-externos.md`, fora do repositório. Se existir, leia de lá e use no lugar dos exemplos; se não existir, monte com o dono e salve lá.

## Para que serve

Os grupos de que o dono participa como membro (mentorias, comunidades de ferramenta) trazem novidades, dicas e insights que ele não tem tempo de rolar. Esta rotina lê esses grupos e entrega só o que vale para ele, por assunto. Não é a rotina dos grupos dele (alunos ou clientes): aqui ninguém espera resposta dele, e nada é respondido.

Formato combinado com o dono: todo dia, por assunto, mostrado na conversa quando ele pedir.

## Grupos

Exemplo fictício. A tabela real vem do arquivo do dono.

| Grupo | id | Pessoas |
|---|---|---|
| Comunidade de Automação | `g_000000000011` | 120 |
| Mentoria de Vendas | `g_000000000012` | 80 |
| Clube de Ferramentas de IA | `g_000000000013` | 300 |

Para mudar a lista, o dono diz quais entram ou saem; incluir grupo pede o clique dele (`wa_escolher_grupos`), tirar apaga o que estava guardado do grupo.

## Passos

1. **Ler só o que é novo.** Para cada grupo, `wa_ler_conversa` com `desde_o_ultimo_resumo: true` (paginando com `antes_de` se vier cortado). Sem resumo anterior, leia as últimas 24 horas. **Antes de ler, abra o relatório do dia** (`relatorios/AAAA-MM-DD-resumo-grupos.md`): se já houver resumo de hoje, a resposta é esse relatório mais o que é novo, nunca só o novo. Se a marca for de hoje e não houver relatório (leitura feita e não guardada), leia o dia inteiro sem `desde_o_ultimo_resumo`. Pedido de "mais insights" de um grupo: leia todo o histórico guardado dele. Com volume grande, entregue a leitura a um subagente Sonnet com só as ferramentas de leitura.
2. **Separar o que vale.** Entra: ferramenta ou versão nova, dica prática que dá para aplicar, número ou resultado concreto, mudança de mercado, evento com data, link que alguém recomendou com motivo. Sai: bom dia, figurinha, meme, autopromoção sem conteúdo, discussão que não chegou a lugar nenhum, pergunta sem resposta.
3. **Agrupar por assunto, não por grupo:**
   - **Ferramentas novas** (o que saiu, o que muda, para quem serve);
   - **Dicas práticas** (o que dá para fazer amanhã);
   - **Negócio e mercado** (números, estratégia, o que está vendendo);
   - **Datas** (eventos, aulas, lives), só se houver.
   Cada item em uma ou duas linhas, com o grupo de origem entre parênteses e o link quando houver. Assunto sem item fica de fora. Dia sem nada útil: "nada relevante hoje nos N grupos", sem enfeitar.
4. **Sem inventar e sem expor.** Frase entre aspas é cópia exata. Não ponha nome de quem falou, a não ser que a pessoa seja a fonte da dica e isso importe (ex.: o criador da ferramenta). Afirmação técnica duvidosa vai marcada "dito no grupo, não conferido".
5. **Mostrar na conversa** e gravar em `relatorios/AAAA-MM-DD-resumo-grupos.md`, acrescentando ao que já houver do dia (nunca sobrescrever). Grave o relatório ANTES de atualizar a marca com `wa_anotar`: marca sem relatório faz a próxima leitura pular o que ninguém viu. No fim, uma linha com quantas mensagens foram lidas por grupo e o que ficou de fora (áudio, imagem, link não aberto).
6. **Atualizar o resumo de cada grupo** com `wa_anotar` (`resumo` e `ate` com a `marca`), para a próxima leitura começar dali. O resumo interno guarda os assuntos que estão rolando, não a lista do dia.

## Cuidados

- Grupo recém-incluído começa vazio. O histórico antigo depende do celular (com iPhone, costuma vir só uns cem). Diga de quando a quando foi o recorte.
- Esses grupos são de outras pessoas: nada daqui vai para conteúdo público do dono sem ele decidir e sem autorização de quem falou.
- Esta rotina não responde nada nos grupos.

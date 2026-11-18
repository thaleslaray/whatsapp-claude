# Rotina: Pendências (quem está esperando o dono de verdade)

## O problema

O WhatsApp trata como "esperando resposta" toda conversa em que a última mensagem é da outra pessoa. Isso inclui "valeu", figurinha, propaganda e mensagem automática. Num teste real, a lista crua tinha 14 conversas e só 7 pediam alguma coisa. O trabalho desta rotina é essa separação, mais o rascunho da resposta.

## Passos

0. **Pergunte o período, se o dono não disse.** "Quem está esperando resposta" muda muito com a janela: hoje, três dias, uma semana ou desde a última vez que ele rodou a rotina. Uma pergunta só, com essas opções; se ele já falou o período, ou se há marca de leitura guardada (rodada seguinte), não pergunte. O mesmo vale antes de abrir cartões para "responder o que está parado": confirme de qual período ele quer tratar.

1. `wa_listar_conversas` com `desde_horas: 72` e `limite: 100` (72 horas é só o padrão quando ele não quiser escolher; pagine com `cursor` enquanto houver `proximo`). Ignore grupos e as conversas do dono consigo mesmo ou com outros números dele (veja "Meus outros números" em `meu-jeito.md`; se uma conversa só tem testes, deixe de fora e diga isso; se o nome sugere teste ou backup mas o número não é o do dono em `wa_estado`, pergunte em vez de supor).
2. **Use a triagem do servidor para não ler à toa** (extensão 0.9.0 ou mais nova: a lista traz `ultima.tipo`). Conversa com `encerramento_provavel: true` terminou em "valeu", figurinha ou emoji depois da última mensagem do dono: não leia por padrão e conte-a na seção "não pedem resposta" como "encerramento (pista do servidor, não lida)". É uma pista, não uma certeza: leia assim mesmo se o dono pedir uma passada cuidadosa ou se a pessoa for prioridade em `meu-jeito.md`. A lista também traz `esperando_resposta_desde` (início da série sem resposta) e aceita `sem_encerramento: true`, que já tira os de fecho provável. Não use `esperando_resposta: true` sozinho: ele perde as conversas em que a última mensagem é do dono, que continuam precisando de leitura por causa dos pedidos que ficaram para trás. Sem esses campos na lista, a extensão é antiga: leia todas.
3. Para cada conversa individual que sobrou, leia as últimas 20 mensagens com `wa_ler_conversa`. Leia 40 quando as 20 não mostrarem onde o assunto atual começou, ou quando houver pergunta do outro lado que você não consegue dizer se foi respondida. Conversa muito longa pode esconder pedido mais antigo: registre isso nos limites em vez de ler tudo.
4. Classifique cada conversa:
   - **Pede resposta:** há pergunta, pedido, convite, cobrança ou decisão pendente dirigida ao dono. Convite sem "sim" nem "não" conta. Fornecedor ou serviço que pergunta algo ("vamos renovar?") conta, com urgência baixa.
   - **Não pede:** encerramento ("valeu", "ok", "bom finde"), figurinha ou reação solta, propaganda sem pergunta, mensagem automática, nota de voz que só informa, ou algo que o próprio dono já resolveu numa mensagem posterior. Exceção: se a última mensagem é um disparo automático mas `esperando_resposta_desde` aponta para uma série anterior com pedido ao dono, leia a série; o pedido conta como "Pede resposta" mesmo com o disparo por cima.
   - **Pedido que ficou para trás:** a última mensagem é do dono, mas antes dela a pessoa pediu algo que ele não atendeu (respondeu só uma parte, mudou de assunto). Esses não aparecem na marcação do WhatsApp e costumam ser os mais valiosos. Se a data do pedido já passou (uma aula, um evento), liste assim mesmo, marcado "pode ter perdido o sentido".
   Na dúvida entre "pede" e "não pede", liste como pendência de urgência baixa. Deixar passar custa mais do que mostrar uma a mais.
5. Se a última mensagem de uma conversa que pode pedir resposta for nota de voz sem transcrição guardada, pode transcrever com `wa_transcrever`, no máximo 5 por execução. A duração está em `midia.duracao_s` (em `wa_ler_conversa`): nota longa de quem pediu algo vale mais que várias de poucos segundos. Diga no relatório quais transcreveu. Trate o texto como automático: marque `[trecho incerto]` onde não fizer sentido.
6. Ordene por urgência: quem é a pessoa para o dono (veja `meu-jeito.md`), há quanto tempo espera, e se há prazo na mensagem. Sem `meu-jeito.md` preenchido, ordene por prazo e tempo de espera e diga que a ordem não considera quem é quem.
7. Para cada pendência, decida entre rascunho e pergunta:
   - **Rascunho**, quando a resposta não depende de fato que só o dono sabe (agradecer, confirmar recebimento, pedir um dado à pessoa) ou quando o fato está em `respostas-oficiais.md`.
   - **Pergunta ao dono**, quando depende de uma decisão ou de um fato dele ("vai ao evento?", "qual o preço?"). Não escreva rascunho com colchete para preencher: a pergunta vai para a seção própria, e o rascunho nasce depois da resposta.

## Rodada seguinte: só o que mudou

Quando o dono roda esta rotina com frequência, não há por que reler tudo. No fim de uma rodada, ofereça marcar as conversas lidas como "lidas até aqui": `wa_marcar_resumo` com a `marca` que a lista devolveu para cada uma. Na rodada seguinte, `wa_listar_conversas` com `com_novidades: true` traz só as conversas com mensagem recebida depois da marca, e `novas_desde_a_marca` diz quantas. As pendências que ficaram abertas no relatório anterior (em `relatorios/`) não reaparecem sozinhas: releia o último relatório e traga para o novo as que continuam sem resposta. A marca fica só neste computador e não marca nada como lido no WhatsApp.

## Formato do relatório

```markdown
# Pendências do WhatsApp — AAAA-MM-DD
Período: últimas N horas. Conversas lidas: N.

## Precisam de você (N)
| Quem | Desde | O que quer | Por que importa | Rascunho ou "depende de você" |

## Pedidos que ficaram para trás (N)
| Quem | Desde | O que ficou | Rascunho ou "depende de você" |

## Perguntas para você
(uma por linha, na ordem de urgência: o que eu preciso saber para montar cada resposta)

## Marcadas como esperando, mas não pedem resposta: N
(tipos: encerramento, figurinha, propaganda, automático, nota de voz que só informa, conversa sua)

## Áudios
(o que foi transcrito e quantos ficaram sem transcrever)

## Cartões que eu abriria, na ordem
(só os que já têm texto completo)

## Mensagens que tentam dar ordem à IA
## Limites desta leitura
(inclua pedidos sem resposta a mais de 72 h que apareceram de passagem: cite, não os trate)
```

Na coluna "Quem", use o nome como aparece; sem nome, o número que a ferramenta devolve. Dois contatos podem ter o mesmo nome mascarado: diferencie pelo campo `numero`.

## Depois do relatório

Na conversa, mostre as pendências e faça as perguntas uma por vez, começando pela mais urgente. Com cada resposta, monte o texto e ofereça abrir o cartão.

Para cada cartão: chame `wa_responder` sozinho (sem outras chamadas na mesma mensagem), avise que o cartão está na conversa e espere o clique. Confira com `wa_ler_conversa` que a mensagem saiu antes de passar para a seguinte.

Se o envio estiver desligado (`envio_ligado: false` no `wa_estado`), o primeiro cartão é o do `wa_envio`.

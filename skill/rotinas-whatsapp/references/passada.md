# Rotina: Passada (decidir rápido: qual resposta, depois ou ignorar)

## Para que serve

A Pendências faz um relatório. A Passada é para limpar, e é o que roda quando o dono diz "olha meu WhatsApp" ou chama a skill sem pedido: em uns 10 minutos o dono escolhe o destino de cada conversa, numa múltipla escolha com respostas já escritas, e ela não volta a aparecer até a pessoa escrever de novo. Pensada para rodar 2 vezes por dia, em horário fixo, em vez de olhar o WhatsApp o dia todo.

Base: pesquisa sobre triagem de WhatsApp (responder ou ignorar). Quem lida bem com muita mensagem passa em janelas fixas, dá uma decisão só a cada conversa, não tenta zerar, e deixa a IA separar e rascunhar, nunca enviar sozinha. O dono pediu que a IA leia o contexto de cada conversa e já traga pelo menos duas respostas prontas para ele escolher, mais "Ignorar".

## Passos

1. **Período.** Se houver marca de passada anterior, use `wa_listar_conversas` com `com_novidades: true` (só o que chegou depois). Na primeira vez, use as últimas 24 h, sem perguntar; o dono pode pedir outro período. Releia o último registro em `relatorios/` e traga os itens "Depois" que continuam sem resposta.
2. **Separar** com as regras de `pendencias.md` (passos 1 a 5): tire grupos, números do dono e encerramentos prováveis; classifique em "pede resposta", "pedido que ficou para trás" e "não pede".
2b. **Juntar o resto do que precisa dele hoje**, na mesma fila, para ele não ter de pedir quatro rotinas:
   - **Promessas vencendo:** `wa_memoria` (compromissos abertos). Entram os do dono com prazo vencido ou até amanhã. Viram pergunta com opções: cumprir agora (rascunho), pedir mais prazo, ou já feito (fecha o compromisso com `wa_anotar`).
   - **Alertas da equipe:** se existir `rotinas/monitor-escola.md` na pasta do dono, leia o novo de cada grupo listado ali (`desde_o_ultimo_resumo: true`) e aplique os sinais de lá. Só entra o que bate num sinal; "tudo bem" vira uma linha no fim. Com muitos grupos, entregue a leitura a um subagente.
   - **Perguntas de hoje e de ontem nos grupos de alunos ou clientes** (os grupos com mais `novas_desde_a_marca` que não são de equipe nem da lista de grupos que ele acompanha), pelas regras de `grupo-perguntas.md`. Pergunta mais velha que ontem não entra.
   Ordene tudo junto por urgência: dinheiro e prazo vencendo primeiro, depois quem espera há mais tempo. Grupos que ele só acompanha (resumo de novidades) não entram na passada.
3. **Ler o contexto de cada conversa que pede resposta.** Não decida pelas últimas mensagens soltas:
   - Comece pelas 20 mensagens que a separação já leu. Só volte mais (`antes_de`, de 20 em 20) se ainda não tiver entendido o contexto: de onde veio o assunto, o que a pessoa já tentou, o que o dono já disse sobre ele. Entendeu, pare. Não leia mais só por ler.
   - Se houver resumo guardado (`resumida_ate`), use-o como pano de fundo e leia só o que veio depois.
   - Notas de voz que fazem parte do pedido: transcreva com `wa_transcrever` (até 5 por passada, as mais longas de quem pediu algo primeiro).
   - **Conferência item a item:** antes de dar como pendente, veja se o dono já resolveu em outro lugar. Busque com `wa_buscar` (`de_mim: true`, desde a data do pedido) duas ou três palavras do assunto: ele pode ter respondido num grupo, em outra conversa ou numa mensagem posterior. Se resolveu, o item sai e vai para "resolvidos" com a prova (onde e quando).
4. **Montar as opções de cada pendência.** Pelo menos duas respostas completas, prontas para enviar, mais "Ignorar":
   - **Respostas diferentes de verdade**, não a mesma frase com outra palavra. Caminhos comuns: resolver agora (a resposta em si), pedir o dado que falta ("me manda um print do armazenamento"), puxar para uma conversa ("bora numa call rápida?"), dar o sim ou o não quando é convite ou pedido, e a resposta de espera ("vi agora, te respondo com calma amanhã").
   - **Decisão do dono vira opção, nunca suposição.** Convite, preço, prazo ou "você vai?": as opções são as decisões possíveis ("vou sim", "não vou conseguir"), e é a escolha dele que decide. Não escreva fato que não está na conversa, em `respostas-oficiais.md` ou numa pesquisa feita agora.
   - **Dúvida técnica:** veja primeiro `wa_como_eu_respondi` (o que ele já respondeu). Se não houver resposta dele e você não tiver certeza da resposta, pesquise antes de sugerir, com a skill `search` (veja "Pesquisar uma dúvida técnica" abaixo). Uma das opções é a resposta pesquisada; na descrição da opção diga que veio de pesquisa e de onde.
   - **No jeito dele:** `wa_meu_jeito` e `wa_exemplos_do_meu_jeito` na primeira opção de cada conversa, e `wa_conferir_rascunho` em todas antes de mostrar. Quando ele costuma quebrar em várias mensagens, a opção já vem quebrada.
   - Nada de colchete para preencher. Se não dá para escrever duas respostas inteiras sem um fato que só ele sabe, uma das opções é a que pede o dado à pessoa ou a resposta de espera.
5. **Perguntar em lote.** `AskUserQuestion` com até 4 conversas por vez (uma pergunta por conversa), na ordem de urgência. Cada pergunta:
   - `question`: quem, o que quer e desde quando, em uma linha que se entenda sozinha (ex.: "Ana (sáb 10:44): Mac enchendo mesmo depois de apagar 50 GB; quer saber se compra HD externo. Qual resposta?").
   - `options` (no máximo 4): as duas melhores respostas, "Ignorar" e "Depois". Se houver uma terceira resposta realmente diferente e melhor que uma das duas, troque, mas "Ignorar" fica sempre. O rótulo é curto ("Pedir print", "Call rápida"); o texto exato que sairia vai no `preview`, e a `description` diz o caminho e, se for o caso, a fonte da pesquisa.
   - O campo "Outro" (automático) é para quando ele quiser escrever a resposta; o rascunho nasce do que ele disser.
   Com mais de 4 conversas, mande a leva seguinte depois da resposta. Mostre antes, em uma linha, os ignorados automáticos por tipo (encerramento, automático, propaganda), sem lista.
6. **Um cartão só, no fim.** Com a extensão 0.17.0 ou mais nova, junte todas as respostas escolhidas num único `wa_responder_lote`: um item por conversa, com as mensagens do item na ordem (quando ele costuma quebrar em várias mensagens curtas, cada uma vai separada no `mensagens`). O dono revisa, edita ou desmarca no cartão e manda tudo com um clique. Itens que pedem outra ação antes (transcrever, abrir foto, mandar arquivo) ficam fora do lote e são feitos depois. Diga em uma frase que o cartão está na conversa e espere; depois confira com `wa_ler_conversa` o que saiu. Extensão mais antiga: um `wa_responder` por mensagem, um por vez, esperando cada clique. Envio desligado → o primeiro cartão é o `wa_envio`. Se o conector não estiver nesta sessão, diga que os cartões abrem no Claude Desktop e grave as escolhas no registro.
7. **Marcar.** Para cada conversa respondida (depois de conferir que saiu) ou ignorada, `wa_marcar_resumo` com a `marca` da lista: ela só volta se chegar mensagem nova. As "Depois" **não** são marcadas e voltam na próxima passada. Diga em uma linha quantas foram marcadas.
8. **Gravar** um registro curto em `relatorios/AAAA-MM-DD-passada-HHhMM.md` (é ele que marca que a primeira vez já passou): o que foi respondido (com o texto), ignorado e deixado para depois, as pesquisas feitas e o que ficou de fora.
9. **Última linha da resposta:** o lembrete do resto ("Também faço: resumo dos grupos · ideias de conteúdo · buscar · *"o que você faz?"* para ver tudo"). Antes dele, no máximo uma sugestão na hora certa (veja "Modo de operação" no SKILL.md).

## Pesquisar uma dúvida técnica

O dono responde muita dúvida técnica e autorizou pesquisar antes de sugerir. É a única exceção à regra "não leve o conteúdo para outras ferramentas":

- Pesquise **a dúvida, não a conversa.** Reescreva como pergunta técnica genérica ("Mac com armazenamento enchendo sozinho mesmo depois de apagar arquivos: causas e como usar HD externo"). Nunca mande para a pesquisa nome, número, empresa, cliente, valor, trecho copiado da mensagem ou qualquer coisa que identifique quem perguntou.
- Use a skill `search`. Para dúvida simples, uma busca basta; não abra pesquisa profunda para pergunta de uma linha.
- A pesquisa é a base, não o texto. A opção sai como o dono falaria com aquela pessoa: palpite direto ("deve ser o claude code"), uma instrução curta, e a oferta de olhar junto ("manda print que te falo"). Nada de aula em tópicos, lista de causas ou passo a passo completo: resposta de várias mensagens explicando tudo soa mecânica, e o dono não responde assim. Antes de escrever, olhe como ele já respondeu dúvida técnica àquela pessoa na própria conversa.
- Na opção, só o que a pesquisa sustenta, no tamanho de uma mensagem de WhatsApp. Se a pesquisa não deixou claro, diga isso ao dono e use como opção pedir mais dado à pessoa.
- Quando o dono escolher a resposta pesquisada e ela servir para outras vezes, ofereça gravar em `respostas-oficiais.md`.

## Regras

- "Ignorar" é decisão do dono, item a item ou em bloco quando ele disser ("ignora todos os automáticos"). Nunca ignore por conta própria o que pede resposta.
- Cliente e aluno com pergunta direta não vão para os ignorados automáticos sem o dono ver, mesmo que pareça simples.
- Não há envio automático em nenhum caso, nem para a resposta de espera.
- Se o dono responder pelo celular entre uma passada e outra, a próxima passada vê a resposta dele (conferência item a item) e tira o item.
- Quando o dono escolher ou escrever algo que vale para outras vezes (preço, prazo, política, resposta técnica), ofereça gravar em `respostas-oficiais.md`.

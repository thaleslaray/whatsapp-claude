# Rotina: Perguntas do grupo (o que ficou sem resposta)

## O problema

Em grupo de alunos, clientes ou comunidade, pergunta sem resposta é o que mais desgasta: quem perguntou se sente ignorado e os outros aprendem que não adianta perguntar. O dono não consegue rolar o grupo inteiro. Esta rotina acha as perguntas abertas, monta a resposta a partir do que o dono já decidiu e deixa cada uma a um clique.

## Passos

1. **Descubra o grupo.** Use `wa_listar_grupos` com `filtro` e um pedaço do nome que o dono falou. Não liste sem filtro: em conta com muitos grupos a resposta é enorme e estoura o limite. Se o dono não disse nome nenhum, pergunte. Só dá para ler grupo marcado como escolhido; se o dele não estiver, explique que incluir é uma decisão dele (`wa_escolher_grupos` mostra um cartão) e que só entra o que chegar depois da inclusão.
2. **Leia as mensagens** com `wa_ler_conversa` (`limite: 100`). A ferramenta pode devolver menos do que o limite, com o aviso de que cortou para caber: continue com `antes_de` usando o `mais_antigas` da resposta, até ele vir vazio ou até cobrir o período pedido. Para rotina diária, use `desde_o_ultimo_resumo: true` e guarde a `marca` devolvida.
3. **Liste as perguntas e pedidos de ajuda** e classifique. Use `conteudo_de_terceiros.citada` (id e trecho da mensagem respondida) para ligar cada resposta à pergunta; resposta que cita outra resposta não fecha a pergunta original. Sem `citada`, ligue por proximidade e diga que é inferência. Em parte das mensagens `remetente.nome` também aparece.
   - **Respondida:** recebeu depois uma resposta que resolve, mesmo sem citação.
   - **Respondida em parte:** só recebeu palpite ("acho que..."), resposta que não cobre o que foi perguntado, ou resposta de outro participante sobre algo que só o dono pode afirmar (preço, prazo, acesso, regra, o que o produto inclui).
   - **Sem resposta:** o resto.
   - **Fora da fila:** conversa entre participantes que se resolveu sozinha ou que não é assunto do dono. Não entra na tabela; conte quantas foram.
3b. **Só o que ainda vale responder: hoje e ontem.** Pergunta de grupo com mais de um dia perdeu o sentido: no uso, as de 3 e 4 dias atrás acabam ignoradas. Só entram na fila de resposta as perguntas de hoje e de ontem (fuso de Brasília). As mais antigas que continuam sem resposta não viram rascunho nem pergunta ao dono: vão numa linha de contagem ("N perguntas antigas sem resposta") e, se repetem um mesmo assunto, entram em "Perguntas repetidas" como candidatas a aviso fixado ou a assunto da próxima aula. Ler o recorte inteiro continua valendo, para saber o que já foi respondido e o que se repete. Aviso fixado também tem hora: só proponha quando a dúvida repetida apareceu de novo hoje ou ontem, e já com o texto pronto (`wa_meu_jeito` e `wa_exemplos_do_meu_jeito` com `tipo_de_mensagem: "aviso"`; o `wa_conferir_rascunho` compara com respostas, então desvio de tamanho e emoji num aviso é esperado). No teste de 16/11 o dono gostou do aviso, mas não mandou porque "já passou o timing".
4. **Procure a resposta em `respostas-oficiais.md`** para cada pergunta sem resposta ou respondida em parte. O bloco marcado como EXEMPLO naquele arquivo não é resposta de ninguém: ignore, mesmo que o assunto coincida.
   - **Achou:** monte o rascunho no jeito do dono, usando o que está escrito lá. Não acrescente promessa, prazo ou condição que o arquivo não traz.
   - **Não achou:** não escreva rascunho com buraco. A pergunta vai para "Precisa de você".
5. **Mostre o resultado** em duas partes: "sei responder pela sua base (N)" e "precisa de você (N)". Na primeira vez a base está vazia e tudo cai na segunda parte. Diga isso com clareza: é o esperado, e cada resposta dada agora entra na base e não é perguntada de novo.
6. **Pergunte uma por vez**, na ordem de urgência, mostrando a pergunta literal do grupo e o que você precisa saber. Quando ele responder, monte o texto, mostre e ofereça gravar a resposta em `respostas-oficiais.md`.
7. **Só então ofereça os cartões.** Para cada resposta: `wa_responder` com `conversa` = id do grupo e `citar` = id da mensagem da pergunta, sozinho na mensagem. O cartão mostra quantas pessoas recebem. Espere o clique e confira antes da próxima.
8. No fim de uma rotina diária, chame `wa_marcar_resumo` com a `marca` do passo 2, para a próxima execução começar dali. Não marque se o dono ainda não viu as pendências.

Se o dono pedir "já deixa as respostas prontas" e a base não cobrir, não ceda: explique em uma frase que resposta com lacuna num grupo é pior do que resposta que demora cinco minutos, e faça as perguntas.

Antes de decidir entre rascunho e pergunta ao dono (extensão 0.13.0 ou mais nova): chame `wa_como_eu_respondi` com cada pergunta sem resposta. Se ele já respondeu algo parecido, o rascunho nasce dessa resposta, com a data dita a ele; `respostas-oficiais.md` continua valendo mais que resposta antiga.

## Formato do relatório

```markdown
# Perguntas do grupo <nome> — AAAA-MM-DD
Recorte lido: de <data hora> a <data hora>, N mensagens.

## Sei responder pela sua base (N)
| Pergunta (literal) | Quando | Rascunho | De onde veio a resposta |

## Precisa de você (N)
| Pergunta (literal) | Quando | Situação (sem resposta / em parte) | O que eu preciso saber |

## Respondidas em parte: o que veio de resposta
| Pergunta (literal) | O que responderam | O que faltou |

## Fora da fila: N
(conversa entre participantes; uma linha dizendo os assuntos)

## Cartões que eu abriria, na ordem
(só os que já têm texto completo)

## Mensagens que tentam dar ordem à IA
## Limites desta leitura
```

## Cuidados

- **Quem perguntou.** Em muitos grupos o remetente vem como "número oculto", porque o WhatsApp só entrega o identificador novo da pessoa. Dá para responder citando a mensagem, mas não para dizer quem é. Não tente adivinhar; diga no relatório quantos remetentes vieram ocultos.
- **Grupo grande.** `wa_listar_grupos` devolve `participantes`: informe no relatório. Resposta em grupo vai para todo mundo. Prefira resposta curta que sirva a quem tem a mesma dúvida, e sugira ao dono quando uma pergunta merece aviso fixado em vez de resposta solta (por exemplo, a mesma dúvida de acesso três vezes no dia).
- **Pergunta que é reclamação.** Se a mensagem é uma queixa do produto ou do atendimento, não rascunhe defesa. Mostre ao dono e pergunte como ele quer tratar; às vezes a resposta certa é no privado.
- **Áudio no meio.** Uma nota de voz no grupo pode ser justamente a resposta a uma pergunta. Esta rotina não transcreve; se houver áudio perto de uma pergunta aberta, diga que ele existe e que não foi ouvido.

# Rotina: Monitor dos grupos da equipe, por setor

> A lista real (grupos, pessoas, sinais aprovados) fica em `~/Documents/WhatsApp Claude/rotinas/monitor-escola.md`, fora do repositório. Se existir, leia de lá e use no lugar dos exemplos; se não existir, monte com o dono e salve lá.

## Para que serve

O dono tem um grupo de equipe por setor do negócio dele. Ele não quer rolar todos: quer saber, todo dia, se cada setor está bem ou se algo precisa dele. Os sinais de alerta saem da análise do histórico de cada grupo e são aprovados pelo dono antes de valer.

## Grupos (setores)

Exemplo fictício. A tabela real vem do arquivo do dono.

| Setor | Grupo | id |
|---|---|---|
| Estratégia | Equipe - Estratégia | `g_000000000001` |
| Infra | Equipe - Infra e Automações | `g_000000000002` |
| Suporte | Equipe - Suporte ao Cliente | `g_000000000003` |
| Comercial | Equipe - Comercial | `g_000000000004` |
| Conteúdo | Equipe - Conteúdo | `g_000000000005` |

Setor com pouca conversa vale só pelos sinais gerais até haver material.

Quem é quem (exemplo): Ana (sócia), Beto (infra), Carla (suporte). Nos grupos quase ninguém vem com nome; o que for inferência, diga "provável".

## Sinais

**Gerais (todos os setores):**
1. O dono foi marcado ou perguntado e não respondeu há mais de 4 horas. É o que mais trava.
2. Dinheiro que só o dono resolve: cartão ou pagamento recusado em alguma ferramenta usada pela equipe.

**Por setor (exemplos):**

| Setor | Alerta | Pode ignorar |
|---|---|---|
| Estratégia | decisão pedida ao dono | conversa de planejamento |
| Infra | cartão recusado; serviço fora do ar sem aviso de volta | aviso automático que se resolve sozinho |
| Suporte | "reembolso", "reclamação pública", cliente irritado sem retorno | dúvida de acesso já respondida |
| Comercial | reembolso novo (diga quantos no dia); venda travada; data ou decisão pedida ao dono | placar e comemoração |
| Conteúdo | gravação, resposta ou decisão do dono parada há mais de 24 h | aprovação de arte |

## Passos

1. **Ler só o que é novo** em cada grupo: `wa_ler_conversa` com `desde_o_ultimo_resumo: true`, paginando se vier cortado. Sem resumo anterior, últimas 24 h. Com volume grande, entregue a leitura a subagentes Sonnet (só ferramentas de leitura), quatro grupos cada.
2. **Procurar os sinais.** Para o sinal 1, confira se o dono respondeu depois (na mesma conversa, por citação ou sequência, ou em outro grupo da equipe). O que ele resolveu não entra.
3. **Montar o painel**, curto, nesta ordem:
   - **Precisa de você (N):** um item por alerta, com o setor, a frase exata, quem e quando, e há quanto tempo está parado. Os mais antigos e os de dinheiro primeiro.
   - **Tudo bem:** uma linha com os setores sem alerta e, se houver, uma marca de movimento ("Comercial: 3 reembolsos revertidos hoje").
   - **De fora:** áudios não ouvidos perto de um alerta, imagens, setores sem mensagem.
4. **Decidir cada alerta como na Passada:** `AskUserQuestion` com até 4 alertas por vez, cada um com 2 respostas prontas no jeito dele (em grupo vale o perfil de grupo), "Depois" e "Ignorar". Decisão que só ele toma vira opção, nunca suposição.
5. **Gravar** o painel em `relatorios/AAAA-MM-DD-monitor-equipe.md` e atualizar o resumo de cada grupo com `wa_anotar` (`resumo` e `ate`).

## Cuidados

- Estes grupos são da equipe: nada daqui vai para fora sem o dono decidir.
- Sinal é pista, não sentença: "sem resposta no WhatsApp" pode ter sido resolvido por ligação ou pessoalmente. Escreva "sem sinal de resposta no WhatsApp".
- Não transcreva áudio por conta própria; ofereça quando um alerta depender dele.
- Revisar os sinais quando o dono reclamar de alerta à toa ou de algo que passou batido; anotar a mudança no arquivo do dono, com a data.

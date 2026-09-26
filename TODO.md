Sim. Com a documentação atual do DeepSeek em mãos, eu faria uma mudança importante na proposta anterior: **não criaria um novo runtime paralelo ao DeepSeek Harness**. Eu faria um *distribution/fork* arquiteturalmente orientado a plugins, mantendo o Cordis e o loop do DeepSeek como substrate, e acrescentaria uma camada nossa de **capabilities, personas, routing, decisions e governance**.

O motivo é forte: o DeepSeek já tem exatamente os pontos de extensão que precisaríamos construir do zero — `ctx.llm`, `ctx.tools`, `ctx.sessions`, `ctx.agents`, `ctx.agentLoop`, sandbox, approvals, goals, jobs, MCP, eventos de ciclo e profiles/bundles. ([GitHub][1])

E o Hermes e os padrões da Anthropic podem entrar como **fontes de capacidades/adapters**, não como runtimes concorrentes.

---

# 1. O projeto que eu proporia

Vou dar um nome provisório:

# **OpenHarness**

> **A model-agnostic, plugin-native AI execution harness for data-intensive and long-running tasks.**

Base:

```text
DeepSeek Harness
       │
       ▼
     Cordis
       │
       ▼
OpenHarness
```

Não:

```text
DeepSeek Harness
      +
Hermes
      +
Claude
```

mas:

```text
                   OpenHarness
                       │
          ┌────────────┼─────────────┐
          │            │             │
      DeepSeek      Hermes        Claude
      primitives   primitives    primitives
          │            │             │
          └────────────┼─────────────┘
                       │
                 common contracts
```

O DeepSeek já foi projetado para que cada componente seja substituível via plugin, sem um “core privilegiado” que precise ser alterado para cada extensão. Profiles e bundles também permitem compor diferentes árvores de plugins. ([GitHub][1])

Essa propriedade deve ser preservada.

---

# 2. A regra número 1 do projeto

Eu colocaria isso no `ARCHITECTURE.md`:

> **Never modify the DeepSeek agent loop when a plugin seam can express the behavior.**

Porque o DeepSeek já tem eventos como:

```text
agent/pre-step
agent/request
agent/request-error
tools/pre-execute
tools/execute
tools/post-execute
llm/stream
system-prompt/assemble
agent/turn-stopping
```

e o próprio projeto usa esses eventos como pontos de extensão para políticas, workflows, interceptação e recuperação. ([GitHub][2])

Portanto:

```text
feature
  │
  ├── can be plugin?
  │      │
  │      └── YES → plugin
  │
  └── NO → modify core
```

O segundo caminho deve ser excepcional.

---

# 3. O que vamos herdar do DeepSeek

O DeepSeek já nos dá uma base extraordinariamente boa.

## Core runtime

```text
Cordis
Agent
AgentLoop
Session
LLM
Tool Registry
Scope
Events
```

## Execution

```text
filesystem
shell
terminal
sandbox
approval
jobs
```

## Persistence

```text
SessionEvent
session log
replay
fork
resume
```

## Integration

```text
MCP
webhook
SDK
ACP
Web UI
```

## Composition

```text
profiles
bundles
patches
plugins
```

Tudo isso já está presente na arquitetura documentada. ([GitHub][1])

Portanto, **não devemos reimplementar nada disso no MVP.**

---

# 4. A arquitetura nova

Eu acrescentaria cinco grandes subsistemas:

```text
                         OpenHarness
                              │
       ┌──────────────────────┼──────────────────────┐
       │                      │                      │
       ▼                      ▼                      ▼
   PERSONAS               ROUTING                DECISIONS
       │                      │                      │
       └──────────────────────┼──────────────────────┘
                              │
                              ▼
                       TASK ORCHESTRATOR
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
                  SKILLS     TOOLS    MODELS
                    │         │         │
                    └─────────┼─────────┘
                              │
                              ▼
                        EVALUATION
                              │
                              ▼
                         ARTIFACTS
                              │
                              ▼
                         GOVERNANCE
```

E tudo isso vive **em cima do Cordis**.

---

# 5. O conceito central: Persona

Essa é uma das primeiras coisas que eu implementaria.

Mas não como:

```yaml
persona:
  system_prompt: "You are a data scientist..."
```

Isso é superficial.

Nossa definição seria:

# Persona = Identity + Skills + Tools + Model Policy + Decision Policy + Memory + Evaluators + Security Policy

Por exemplo:

```yaml
id: data-scientist

identity:
  name: Data Scientist
  description: >
    Performs statistical analysis, experimentation,
    modeling and data investigation.

models:
  reasoning:
    policy: adaptive

  coding:
    policy: adaptive

  decision:
    provider: jev-like

skills:
  - statistics
  - python
  - polars
  - machine-learning
  - experiment-design

tools:
  allow:
    - python.execute
    - sql.query
    - data.profile
    - artifact.create

policies:
  deny:
    - production.write

memory:
  scope: project

evaluators:
  - numerical-correctness
  - statistical-validity
  - code-execution
  - evidence-grounding
```

Isso é uma **persona executável**.

---

# 6. Personas passam a ser bundles

Aqui o sistema do DeepSeek ajuda muito.

Poderíamos ter:

```text
profiles/
│
├── data-scientist/
├── data-engineer/
├── analyst/
├── researcher/
├── software-engineer/
└── executive/
```

Mas eu faria uma distinção:

```text
Persona
    ↓
configuration
    +
plugins
    +
skills
    +
policies
```

Então:

```text
Data Scientist
     │
     ├── statistics skill
     ├── python skill
     ├── SQL tool
     ├── ML tools
     ├── data policies
     └── evaluation suite
```

---

# 7. O que vamos importar do Hermes

O Hermes tem uma arquitetura bastante rica em:

* skills;
* memória;
* provider routing;
* plugins;
* MCP;
* sessões;
* context compression;
* scheduling;
* messaging;
* subagents.

A documentação atual descreve, por exemplo, um registry de ferramentas, persistência SQLite de sessões, providers, plugins e múltiplos backends de terminal/sandbox. ([GitHub][3])

Mas não precisamos copiar o Hermes.

Precisamos **traduzir suas ideias para os seams do DeepSeek**.

---

# 8. Hermes → OpenHarness

| Hermes           | OpenHarness               |
| ---------------- | ------------------------- |
| Skills           | `ctx.skills`              |
| Memory           | `ctx.memory`              |
| Provider routing | `ctx.modelRouter`         |
| Context engine   | `ctx.context`             |
| Cron             | `ctx.jobs`                |
| MCP              | `ctx.tools` / MCP adapter |
| Subagents        | `ctx.agents`              |
| Plugin           | Cordis plugin             |
| Tool registry    | `ctx.tools`               |
| Session          | `ctx.sessions`            |
| Sandbox          | `ctx.sandbox`             |
| Messaging        | gateway adapter           |

Hermes já trata skills e memória como conceitos diferentes: skill é conhecimento **procedural**, carregado quando necessário; memory é conhecimento factual persistente. Essa separação vale a pena preservar. ([GitHub][4])

---

# 9. O sistema de Skills

Eu criaria:

```text
skills/
│
├── data/
│   ├── statistics/
│   ├── sql/
│   ├── pandas/
│   ├── polars/
│   └── spark/
│
├── research/
│   ├── literature-review/
│   ├── evidence/
│   └── citation/
│
├── engineering/
│   ├── python/
│   ├── rust/
│   └── testing/
│
└── business/
    ├── finance/
    ├── marketing/
    └── operations/
```

Cada skill:

```text
SKILL.md
metadata.yaml
examples/
tests/
```

Por exemplo:

```yaml
name: statistical-analysis

description: >
  Statistical analysis of structured datasets.

activation:
  triggers:
    - hypothesis test
    - statistical significance
    - confidence interval
    - regression

requirements:
  tools:
    - python.execute

evaluators:
  - statistical-validity
```

---

# 10. A diferença entre Tool e Skill

Isso precisa ficar muito claro.

### Tool

**faz alguma coisa.**

```text
sql.query
python.execute
browser.search
file.read
```

### Skill

**ensina como fazer alguma coisa.**

```text
statistics
SQL optimization
financial analysis
literature review
```

Portanto:

```text
Data Scientist
     │
     ├── Skill: statistics
     │
     └── Tool: python.execute
```

O Hermes faz uma distinção semelhante e recomenda skills pequenas e focadas, em vez de grandes documentos que tentam explicar uma área inteira. ([GitHub][4])

---

# 11. Agora entra o componente mais importante da nossa arquitetura:

# Decision Engine

Esse será o nosso **modo Jev**.

Eu não chamaria internamente de `JevEngine`.

Chamaria:

```text
DecisionModel
```

porque queremos que o sistema possa usar:

```text
Jev
Jev-like local model
classifier
rules
small LLM
specialized model
```

sem mudar o runtime.

---

# 12. Três tipos de inteligência

Nossa arquitetura teria:

```text
                 MODEL LAYER
                      │
        ┌─────────────┼──────────────┐
        │             │              │
        ▼             ▼              ▼
   Generative      Decision      Deterministic
     Model          Model           Engine
```

### GenerativeModel

```text
DeepSeek
Qwen
Claude
GPT
Gemini
Llama
Mistral
```

Para:

```text
reasoning
coding
writing
planning
synthesis
```

### DecisionModel

```text
Jev
Jev-like
classifier
ranker
small reasoning model
```

Para:

```text
classification
routing
scoring
ranking
approval recommendation
retry
stop
escalation
```

### DeterministicEngine

```text
SQL
Python
Polars
Spark
DuckDB
Rules
```

Para:

```text
computation
validation
transformation
permission
aggregation
```

---

# 13. Interface do DecisionModel

Algo conceitualmente assim:

```typescript
interface DecisionModel {
  decide<TInput, TDecision>(
    request: DecisionRequest<TInput, TDecision>
  ): Promise<DecisionResult<TDecision>>
}
```

Exemplo:

```typescript
const decision = await ctx.decisions.decide({
  question: "Should this task continue?",
  input: {
    objective,
    progress,
    errors,
    budget,
    evidence
  },
  schema: {
    decision: ["continue", "retry", "complete", "escalate"]
  }
})
```

Resultado:

```json
{
  "decision": "retry",
  "confidence": 0.93,
  "reason_code": "tool_timeout",
  "metadata": {
    "provider": "jev"
  }
}
```

A TypeSafe posiciona Jev justamente como uma classe de modelo voltada a decisões rápidas e estruturadas que software pode consumir diretamente, em vez de geração textual convencional. ([TypeSafe AI][5])

---

# 14. O modo `jev`

Eu colocaria três modos no runtime.

## `standard`

```text
LLM
 ↓
tool
 ↓
LLM
 ↓
tool
```

Para tarefas simples.

---

## `agent`

```text
LLM
 ↓
plan
 ↓
execute
 ↓
LLM
 ↓
execute
```

Para tarefas complexas.

---

## `decision`

```text
state
 ↓
DecisionModel
 ↓
action
```

Para loops rápidos.

---

# 15. E um quarto modo seria extremamente interessante

# `adaptive`

```text
                   TASK
                     │
                     ▼
                  ROUTER
                     │
        ┌────────────┼─────────────┐
        ▼            ▼             ▼
   deterministic   decision      generative
        │            │             │
        ▼            ▼             ▼
       SQL          Jev          DeepSeek
       Rule         rank         Claude
       Python       route        Qwen
```

Esse seria o modo corporativo principal.

O harness decide **quanto de inteligência é necessário**.

---

# 16. Exemplo: 500 milhões de registros

Pergunta:

> “Encontre anomalias nas transações de 2025.”

O sistema poderia fazer:

```text
USER
 │
 ▼
Planner
 │
 ▼
SQL/Spark
 │
 ▼
100M candidates
 │
 ▼
statistical engine
 │
 ▼
100k candidates
 │
 ▼
Jev
 │
 ▼
5k high-priority
 │
 ▼
LLM
 │
 ▼
50 investigations
 │
 ▼
Evaluator
 │
 ▼
Report
```

Isso é fundamental.

O LLM **não deveria processar 500 milhões de linhas**.

---

# 17. O modo Jev é particularmente importante para isso

Imagine 100.000 objetos:

```text
customer_001
customer_002
...
customer_100000
```

Não fazemos:

```text
100k × expensive LLM
```

Podemos fazer:

```text
100k
 ↓
Jev
 ↓
top 1k
 ↓
LLM
```

ou:

```text
100k
 ↓
deterministic filters
 ↓
10k
 ↓
Jev
 ↓
500
 ↓
frontier LLM
```

O harness vira um **sistema de progressive intelligence**.

---

# 18. Isso é uma das características que eu colocaria como princípio do projeto

> **Use the cheapest reliable computation capable of reducing the problem before invoking expensive intelligence.**

Em português:

> **Primeiro reduza o espaço de decisão com computação barata e confiável; só depois aplique inteligência cara.**

Essa regra é especialmente boa para corporações com grandes volumes de dados.

---

# 19. Agora: o Supervisor

Precisamos de um componente:

```text
Supervisor
```

Mas novamente não necessariamente um LLM.

Ele deve coordenar:

```text
Persona
Model
DecisionModel
Tools
Skills
Budget
Policy
Evaluation
```

Fluxo:

```text
Task
 │
 ▼
Supervisor
 │
 ├── choose persona
 ├── choose model
 ├── choose skills
 ├── choose tools
 ├── choose decision mode
 ├── enforce policy
 └── monitor execution
```

---

# 20. O Supervisor pode usar Jev

Isso é importantíssimo.

Não:

```text
Supervisor = giant LLM
```

Mas:

```text
Supervisor
   │
   ├── deterministic rules
   │
   ├── Jev
   │
   └── LLM when necessary
```

Exemplo:

```text
Tool timeout
     │
     ▼
Rule:
retry_count < 3
     │
     ▼
Jev:
is retry useful?
     │
 ┌───┴───┐
yes      no
 │        │
retry   escalate
```

---

# 21. Vamos incorporar o padrão mais interessante da Anthropic

O projeto `cwc-long-running-agents` da Anthropic implementa explicitamente um **generator/evaluator loop**, em que um modelo separado verifica se o objetivo foi atingido. A versão de referência transforma esse mecanismo em hooks e subagent reutilizáveis. ([GitHub][6])

Nós faríamos:

```text
                 TASK
                   │
                   ▼
               GENERATOR
                   │
                   ▼
                ACTION
                   │
                   ▼
               EVALUATOR
                   │
          ┌────────┼────────┐
          ▼        ▼        ▼
       complete   retry   escalate
```

Mas adicionando Jev:

```text
                GENERATOR
                    │
                    ▼
                 ACTION
                    │
                    ▼
             EVIDENCE BUILDER
                    │
                    ▼
               EVALUATOR
                    │
                    ▼
                  JEV
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
       complete    retry    escalate
```

Isso é muito mais interessante.

---

# 22. E o Evaluator não deve ser o mesmo agente

Regra:

```text
generator ≠ evaluator
```

Porque:

```text
Agent:
"Meu trabalho está correto."

```

não é uma validação independente.

O evaluator pode ser:

```text
deterministic
small LLM
Jev
specialized evaluator
human
```

---

# 23. Arquitetura completa

Eu chegaria a algo assim:

```text
                             USER
                               │
                               ▼
                        ┌──────────────┐
                        │ TASK INTAKE  │
                        └──────┬───────┘
                               │
                               ▼
                       ┌────────────────┐
                       │   SUPERVISOR   │
                       └───────┬────────┘
                               │
               ┌───────────────┼────────────────┐
               │               │                │
               ▼               ▼                ▼
           PERSONA          ROUTER           POLICY
               │               │                │
               └───────────────┼────────────────┘
                               │
                               ▼
                         TASK PLANNER
                               │
                               ▼
                      ┌─────────────────┐
                      │ EXECUTION LOOP  │
                      └────────┬────────┘
                               │
             ┌─────────────────┼──────────────────┐
             │                 │                  │
             ▼                 ▼                  ▼
         GENERATIVE         DECISION          DETERMINISTIC
           MODEL             MODEL              ENGINE
             │                 │                  │
          Claude            Jev-like             SQL
          DeepSeek          Jev                  Spark
          Qwen              Rule                 Python
             │                 │                  │
             └─────────────────┼──────────────────┘
                               │
                               ▼
                          EVALUATOR
                               │
                               ▼
                         DECISION MODEL
                               │
                  ┌────────────┼────────────┐
                  ▼            ▼            ▼
               COMPLETE       RETRY       ESCALATE
                  │
                  ▼
               ARTIFACT
                  │
                  ▼
                AUDIT
```

---

# 24. Agora vamos para o repositório

Eu **não destruiria a estrutura original do DeepSeek**.

Faria:

```text
deepseek-harness/
│
├── packages/
│   ├── cordis/
│   ├── core/
│   ├── llm/
│   ├── tools/
│   ├── ...
│
└── packages/
    └── openharness/
```

Mas, dependendo da organização do monorepo, eu preferiria eventualmente:

```text
packages/
│
├── core/
├── llm/
├── tools/
├── ...
│
├── harness-personas/
├── harness-skills/
├── harness-decisions/
├── harness-routing/
├── harness-evaluation/
├── harness-governance/
└── harness-data/
```

---

# 25. Estrutura que eu adotaria

```text
packages/
│
├── core/
│
├── llm/
│
├── tools/
│
├── sessions/
│
├── sandbox/
│
├── web/
│
├── ...
│
├── openharness/
│   │
│   ├── persona/
│   │   ├── service.ts
│   │   ├── registry.ts
│   │   ├── schema.ts
│   │   └── loader.ts
│   │
│   ├── skills/
│   │   ├── service.ts
│   │   ├── registry.ts
│   │   └── loader.ts
│   │
│   ├── decisions/
│   │   ├── service.ts
│   │   ├── types.ts
│   │   ├── router.ts
│   │   └── providers/
│   │       ├── jev.ts
│   │       ├── rule.ts
│   │       └── llm.ts
│   │
│   ├── routing/
│   │   ├── model-router.ts
│   │   ├── tool-router.ts
│   │   └── task-router.ts
│   │
│   ├── supervisor/
│   │   ├── supervisor.ts
│   │   ├── policy.ts
│   │   └── lifecycle.ts
│   │
│   ├── evaluation/
│   │   ├── evaluator.ts
│   │   ├── registry.ts
│   │   ├── assertions.ts
│   │   └── suites/
│   │
│   ├── artifacts/
│   │   ├── registry.ts
│   │   └── store.ts
│   │
│   ├── governance/
│   │   ├── permissions.ts
│   │   ├── budgets.ts
│   │   ├── audit.ts
│   │   └── policies.ts
│   │
│   └── task/
│       ├── task.ts
│       ├── state.ts
│       ├── planner.ts
│       └── lifecycle.ts
```

---

# 26. Interfaces

Eu faria questão de que o núcleo fosse extremamente pequeno.

## Model

```typescript
interface Model {
  readonly id: string;
  readonly capabilities: ModelCapabilities;

  generate(
    request: ModelRequest,
    context: ModelContext
  ): Promise<ModelResponse>;
}
```

---

## DecisionModel

```typescript
interface DecisionModel {
  readonly id: string;
  readonly capabilities: DecisionCapabilities;

  decide<T>(
    request: DecisionRequest<T>
  ): Promise<DecisionResult<T>>;
}
```

---

## Tool

Já existe no DeepSeek.

**Não criar outra abstração.**

Nós usamos:

```text
ctx.tools
```

O DeepSeek já tem um registry de ferramentas com execução guardada e escopo por agente. ([GitHub][1])

---

# 27. Skill

```typescript
interface Skill {
  readonly id: string;
  readonly version: string;

  activate(
    context: SkillContext
  ): Promise<SkillActivation>;
}
```

Uma skill pode contribuir:

```text
prompt sections
tools
evaluators
decision policies
examples
references
```

---

# 28. Persona

```typescript
interface Persona {
  readonly id: string;
  readonly version: string;

  identity: PersonaIdentity;

  modelPolicy: ModelPolicy;
  decisionPolicy: DecisionPolicy;

  skills: SkillRef[];
  tools: ToolPolicy;
  memory: MemoryPolicy;

  evaluation: EvaluationPolicy;
  security: SecurityPolicy;
}
```

---

# 29. Task

A abstração de Task é importantíssima.

```typescript
interface Task {
  id: TaskId;

  objective: string;

  persona: PersonaRef;

  mode:
    | "standard"
    | "agent"
    | "decision"
    | "adaptive";

  state: TaskState;

  budget: TaskBudget;

  constraints: TaskConstraints;
}
```

---

# 30. Task State

```typescript
interface TaskState {
  objective: string;

  plan?: Plan;

  steps: Step[];

  artifacts: ArtifactRef[];

  evidence: Evidence[];

  errors: TaskError[];

  metrics: TaskMetrics;

  status:
    | "pending"
    | "running"
    | "waiting"
    | "completed"
    | "failed"
    | "escalated";
}
```

Esse estado deve ser compatível com o sistema de sessão/eventos do DeepSeek em vez de criar uma segunda fonte de verdade.

O DeepSeek já trata o session log como a fonte do contexto e usa eventos duráveis para reconstrução/replay. ([GitHub][1])

---

# 31. O Decision Engine

Essa será provavelmente nossa contribuição conceitual mais importante.

```text
packages/openharness/decisions/
```

Teremos:

```text
DecisionModel
DecisionRequest
DecisionResult
DecisionRouter
DecisionPolicy
DecisionSchema
```

E providers:

```text
providers/
├── jev.ts
├── openai.ts
├── anthropic.ts
├── local.ts
├── rule.ts
└── composite.ts
```

---

# 32. `CompositeDecisionModel`

Esse componente seria muito poderoso.

```text
CompositeDecisionModel
        │
        ├── rules
        │
        ├── Jev
        │
        ├── local model
        │
        └── frontier LLM
```

Exemplo:

```text
"Can I retry?"

        │
        ▼
      RULE
        │
    ambiguous
        │
        ▼
       JEV
        │
    uncertain
        │
        ▼
     LLM
```

Isso minimiza custo.

---

# 33. Model Router

O mesmo princípio:

```text
ModelRouter
```

recebe:

```yaml
task:
  type: code_generation

constraints:
  max_cost: 0.10
  max_latency: 10s

requirements:
  tool_calling: true
  context: 64k
```

e escolhe:

```text
Qwen
```

em vez de automaticamente usar:

```text
Claude
```

---

# 34. Mas eu faria uma coisa ainda mais interessante

## Capability-based routing

O modelo declara:

```yaml
capabilities:
  code: high
  reasoning: medium
  vision: none
  structured_output: high
  tool_calling: high
```

A persona declara:

```yaml
requirements:
  code: high
  structured_output: high
```

O router resolve:

```text
requirements
     ↓
capabilities
     ↓
eligible models
     ↓
cost / latency / policy
     ↓
selected model
```

Isso evita hardcode:

```python
if task == "coding":
    use_qwen()
```

---

# 35. Skills do Claude

Nós não precisamos incorporar o Claude Code inteiro.

Podemos trazer padrões.

Por exemplo:

```text
claude/
├── long-running/
├── evaluator/
├── goal/
├── context-management/
├── verification/
└── coding-agent/
```

A Anthropic explicitamente demonstra o padrão de um `/goal` com generator + evaluator separado para long-running agents. ([GitHub][6])

Nós transformaríamos isso em:

```text
plugins/
└── anthropic-patterns/
    ├── goal/
    ├── evaluator/
    └── verification/
```

---

# 36. Long-running Task

Eu adicionaria uma abstração:

```text
Goal
```

O DeepSeek já possui `ctx.goals`, então não precisamos inventar outra infraestrutura de objetivo. ([GitHub][1])

Mas colocaríamos uma política:

```yaml
goal:
  success:
    evaluator: task_success

  max_iterations: 100

  stopping:
    provider: jev

  escalation:
    after: 3
```

Então:

```text
Goal
 │
 ▼
Agent
 │
 ▼
Evaluator
 │
 ▼
Jev
 │
 ├── continue
 ├── retry
 ├── complete
 └── escalate
```

---

# 37. Isso cria o nosso `Jev Mode`

O usuário poderia escolher:

```text
Mode:

○ Standard
○ Agent
○ Adaptive
● Decision
```

Ou via API:

```json
{
  "mode": "adaptive"
}
```

E internamente:

```text
adaptive
    ↓
planner
    ↓
deterministic reduction
    ↓
decision model
    ↓
generative model
    ↓
evaluation
```

---

# 38. Ferramentas que eu criaria primeiro

Não dezenas.

Estas:

### Data

```text
data.inspect
data.profile
data.sample
data.schema
data.aggregate
```

### SQL

```text
sql.query
sql.explain
sql.validate
```

### Python

```text
python.execute
python.inspect
```

### Artifacts

```text
artifact.create
artifact.read
artifact.list
```

### Evidence

```text
evidence.attach
evidence.inspect
```

### Agent

```text
agent.spawn
agent.delegate
agent.inspect
```

### Decision

```text
decision.evaluate
```

Grande parte delas pode simplesmente encapsular capacidades que já existem no DeepSeek.

---

# 39. Não esquecer MCP

O Hermes já possui integração MCP de primeira classe, incluindo servidores locais/remotos, discovery e filtragem de ferramentas. ([GitHub][7])

Nós faríamos:

```text
MCP Server
    │
    ▼
MCP Adapter
    │
    ▼
ctx.tools
```

Portanto, para o agente:

```text
native tool
```

e:

```text
MCP tool
```

parecem a mesma coisa.

Isso é exatamente o que queremos.

---

# 40. E isso nos permite criar um Tool Policy

Por exemplo:

```yaml
persona: analyst

tools:
  allow:
    - sql.query
    - sql.explain
    - data.profile
    - artifact.create

  deny:
    - shell.execute
    - sql.write
    - email.send
```

Enquanto:

```yaml
persona: data-engineer

tools:
  allow:
    - sql.query
    - sql.write
    - spark.submit
    - pipeline.deploy
```

Mas com:

```yaml
approval:
  sql.write: human
  pipeline.deploy: human
```

---

# 41. Esse é outro motivo pelo qual o DeepSeek é uma excelente base

O próprio sistema já tem:

```text
scoped tools
guarded execution
sandbox
approval policy
```

e permite adicionar políticas nos seams de ferramentas e filesystem. ([GitHub][1])

Ou seja:

**não precisamos reinventar segurança de execução no primeiro ciclo.**

---

# 42. Data plane

Para o seu foco de grandes volumes:

```text
OpenHarness
      │
      ├── PostgreSQL
      ├── DuckDB
      ├── ClickHouse
      ├── Snowflake
      ├── Databricks
      ├── BigQuery
      ├── Spark
      ├── Polars
      └── Object Storage
```

Não queremos que todos sejam tools especiais.

Queremos adaptadores:

```text
DataSource
QueryEngine
ArtifactStore
```

---

# 43. E uma regra:

## O agente pede uma operação, não uma implementação.

Ele diz:

```text
"aggregate sales by month"
```

O planner escolhe:

```text
DuckDB
```

ou:

```text
Spark
```

ou:

```text
Snowflake
```

dependendo:

```text
dataset size
location
cost
latency
permissions
```

---

# 44. Essa seria a hierarquia final

```text
                    USER
                     │
                     ▼
                    TASK
                     │
                     ▼
                  PERSONA
                     │
        ┌────────────┼────────────┐
        ▼            ▼            ▼
      SKILLS       POLICY      MEMORY
        │            │
        └────────────┼────────────┘
                     ▼
                 SUPERVISOR
                     │
          ┌──────────┼──────────┐
          ▼          ▼          ▼
        MODEL      DECISION     DATA
        ROUTER      ROUTER     ROUTER
          │          │          │
          ▼          ▼          ▼
      LLMs          Jev       SQL/Spark
          │          │          │
          └──────────┼──────────┘
                     ▼
                  ACTION
                     │
                     ▼
                EVALUATOR
                     │
                     ▼
                DECISION
                     │
             ┌───────┼───────┐
             ▼       ▼       ▼
           DONE    RETRY   ESCALATE
```

---

# 45. O roadmap que eu adotaria

## Phase 0 — Fork/branch strategy

**Não alterar o core.**

Criar:

```text
openharness/*
```

como plugins/bundles.

---

## Phase 1 — Contracts

Implementar:

```text
Persona
Skill
DecisionModel
DecisionRouter
ModelRouter
Task
Evaluator
Artifact
Evidence
```

Sem IA nova ainda.

---

## Phase 2 — Personas

Criar:

```text
Data Analyst
Data Scientist
Researcher
Software Engineer
```

---

## Phase 3 — Hermes compatibility

Adicionar:

```text
skills
memory
MCP
subagents
provider routing
```

---

## Phase 4 — Claude patterns

Adicionar:

```text
goal
generator/evaluator
verification
long-running
context management
```

---

## Phase 5 — Jev

Implementar:

```text
DecisionModel
JevProvider
JevLikeProvider
CompositeDecisionModel
```

E os modos:

```text
standard
agent
decision
adaptive
```

---

## Phase 6 — Data

Adicionar:

```text
SQL
DuckDB
Polars
Spark
warehouse adapters
```

---

## Phase 7 — Evaluation

```text
task success
tool correctness
SQL correctness
numerical correctness
grounding
evidence
cost
latency
```

---

## Phase 8 — Governance

```text
RBAC
ABAC
budgets
audit
approval
PII policy
model policy
tool policy
```

---

# 46. O MVP que eu realmente construiria

Não tentaria implementar tudo isso imediatamente.

O primeiro milestone seria:

```text
OpenHarness v0.1
```

com:

```text
DeepSeek Harness
      │
      ├── Persona
      ├── Skill
      ├── DecisionModel
      ├── ModelRouter
      ├── Evaluator
      └── Adaptive Mode
```

E três modelos:

```text
DeepSeek
Qwen
Jev-like mock
```

O `Jev-like mock` é importante.

Antes de depender da API do Jev, podemos implementar:

```text
RuleDecisionModel
```

com a mesma interface:

```text
DecisionModel
```

Depois:

```text
JevProvider
```

entra sem alterar o restante do sistema.

---

# 47. Exemplo de uso final

O usuário poderia fazer:

```bash
openharness run \
  --persona data-scientist \
  --mode adaptive \
  "Analise as vendas de 2025 e identifique os principais fatores associados à queda de receita."
```

Internamente:

```text
TASK
 │
 ▼
DATA-SCIENTIST
 │
 ▼
ADAPTIVE
 │
 ▼
Planner
 │
 ├── inspect dataset
 ├── profile data
 └── generate hypotheses
 │
 ▼
SQL
 │
 ▼
Statistics
 │
 ▼
Jev
 │
 ├── prioritize hypotheses
 │
 ▼
LLM
 │
 ├── investigate
 │
 ▼
Evaluator
 │
 ▼
Jev
 │
 ├── complete
 │
 ▼
Report
```

E o resultado deveria carregar:

```json
{
  "task_id": "...",
  "status": "completed",

  "persona": "data-scientist",

  "models": [
    "deepseek",
    "jev"
  ],

  "tools": [
    "sql.query",
    "python.execute"
  ],

  "artifacts": [
    "analysis.parquet",
    "report.md",
    "charts/"
  ],

  "evidence": [
    "query://...",
    "dataset://..."
  ],

  "evaluation": {
    "task_success": 0.94,
    "numerical_correctness": 0.99,
    "groundedness": 0.96
  },

  "usage": {
    "tokens": 12340,
    "runtime_seconds": 42
  }
}
```

Isso já é um **harness corporativo de verdade**, não apenas um agent wrapper.

---

# 48. Uma decisão que eu tomaria agora

Eu manteria o nome interno dos componentes **agnóstico**.

Não:

```text
JevController
ClaudePersona
DeepSeekAgent
HermesSkill
```

Mas:

```text
DecisionModel
GenerativeModel
Persona
Skill
Tool
Evaluator
Runtime
Router
```

Os vendors aparecem apenas nos adapters:

```text
providers/
├── deepseek/
├── anthropic/
├── openai/
├── qwen/
├── jev/
└── local/
```

Isso garante que, se amanhã aparecer:

```text
Jev 2
```

ou:

```text
Jev-like open-source model
```

ou:

```text
Meta Decision Model
```

nada no core precisa mudar.

---

# 49. E há uma segunda decisão que considero essencial

**Não criaríamos um “Hermes mode” ou “Claude mode” que simplesmente copia o comportamento deles.**

Em vez disso:

```text
Hermes
  │
  ├── Skills
  ├── Memory
  ├── MCP
  └── Routing
       ↓
   adapters

Claude
  │
  ├── Goals
  ├── Evaluator
  ├── Long-running
  └── Verification
       ↓
   adapters

DeepSeek
  │
  ├── Cordis
  ├── Agent Loop
  ├── Sessions
  ├── Tools
  ├── Sandbox
  └── Events
       ↓
     core
```

Ou seja:

# DeepSeek = substrate

# Hermes = capability inspiration/adapters

# Claude = control/evaluation patterns

# Jev = decision substrate

# OpenHarness = integração de tudo isso

---

# 50. A arquitetura conceitual final

Eu desenharia o projeto assim:

```text
┌─────────────────────────────────────────────────────────────────┐
│                         OPENHARNESS                              │
│                                                                 │
│  ┌─────────────┐       ┌──────────────┐       ┌──────────────┐ │
│  │  PERSONAS   │──────►│  SUPERVISOR  │──────►│   ROUTERS    │ │
│  └─────────────┘       └──────────────┘       └──────┬───────┘ │
│                                                       │         │
│                  ┌────────────────────────────────────┼──────┐ │
│                  │                                    │      │ │
│                  ▼                                    ▼      ▼ │
│            GENERATIVE                              DECISION DATA
│               MODELS                                MODELS  │ │
│                  │                                    │      │ │
│          ┌───────┼────────┐                      ┌────┼───┐  │ │
│          │       │        │                      │    │   │  │ │
│       DeepSeek  Qwen   Claude                   Jev  Rules LLM │
│                                                                 │
│                  └────────────────┬────────────────────────────┘ │
│                                   │                              │
│                                   ▼                              │
│                              EXECUTION                           │
│                                   │                              │
│                         ┌─────────┼─────────┐                    │
│                         ▼         ▼         ▼                    │
│                       TOOLS     SKILLS    SUBAGENTS              │
│                         │         │         │                    │
│                         └─────────┼─────────┘                    │
│                                   ▼                              │
│                              EVALUATOR                           │
│                                   │                              │
│                              JEV/RULES                           │
│                                   │                              │
│                       ┌───────────┼───────────┐                  │
│                       ▼           ▼           ▼                  │
│                    COMPLETE      RETRY      ESCALATE             │
│                                   │                              │
│                                   ▼                              │
│                              ARTIFACTS                            │
│                                   │                              │
│                              EVIDENCE                             │
│                                   │                              │
│                               AUDIT                               │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              DEEPSEEK / CORDIS RUNTIME
```

E por baixo de tudo:

```text
Cordis
 ├── ctx.llm
 ├── ctx.tools
 ├── ctx.sessions
 ├── ctx.agents
 ├── ctx.agentLoop
 ├── ctx.sandbox
 ├── ctx.goals
 ├── ctx.jobs
 └── typed events
```

Essa última camada **já existe**, que é precisamente por que partir do DeepSeek é uma decisão tão boa para o projeto. ([GitHub][1])

---

## Minha conclusão arquitetural

Eu seguiria exatamente essa direção:

**DeepSeek Harness não seria apenas o ponto de partida; seria o kernel de execução.**

Sobre ele:

1. **Personas** — composição de skills, ferramentas, políticas, memória e modelos.
2. **Skills** — conhecimento procedural portável, inspirado no Hermes.
3. **Model Router** — escolha dinâmica do modelo generativo.
4. **Decision Router** — escolha entre regras, Jev, Jev-like ou LLM.
5. **Adaptive Mode** — combinação dos três tipos de computação.
6. **Evaluator** — padrão generator → evaluator da Anthropic.
7. **Goal Runtime** — aproveitando o `ctx.goals` existente.
8. **Evidence/Artifact layer** — respostas auditáveis.
9. **Governance layer** — permissions, budget, approval e policy.
10. **Data layer** — SQL/Polars/Spark/DuckDB para mover grandes volumes sem passar os dados pelo LLM.

O resultado não seria um “clone melhorado do DeepSeek Harness”.

Seria uma coisa conceitualmente diferente:

> **um sistema operacional de execução de tarefas de IA, no qual o LLM é apenas uma classe de recurso computacional — ao lado de modelos de decisão como Jev e engines determinísticos como SQL, Python e Spark.**

E, na minha visão, **essa é a direção certa para o problema corporativo que você descreveu**.

O primeiro código que eu escreveria não seria ainda um agente. Seria o **contrato `DecisionModel` + `Persona` + `Task` + `Evaluator`**, encaixado nos seams do Cordis. Depois disso conseguimos fazer o primeiro plugin `openharness-decisions`, um `JevProvider`, um `RuleDecisionProvider` e uma persona `data-scientist`, sem tocar no agent loop original. ([GitHub][1])

[1]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md?ref=aiposthub.com "deepseek-harness/docs/architecture.md at master · deepseek-ai/deepseek-harness · GitHub"
[2]: https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md "deepseek-harness/.agents/notes/implemented/architecture/2026-06-11-microkernel-event-taxonomy.md at master · deepseek-ai/deepseek-harness · GitHub"
[3]: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/developer-guide/architecture.md "hermes-agent/website/docs/developer-guide/architecture.md at main · NousResearch/hermes-agent · GitHub"
[4]: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/guides/work-with-skills.md?utm_source=chatgpt.com "hermes-agent/website/docs/guides/work-with-skills.md at main · NousResearch/hermes-agent · GitHub"
[5]: https://typesafe.ai/blog/introducing-system-one-models-and-jev "Introducing System One Models & Jev - TypeSafe AI Blog"
[6]: https://github.com/anthropics/cwc-long-running-agents/blob/main/README.md "cwc-long-running-agents/README.md at main · anthropics/cwc-long-running-agents · GitHub"
[7]: https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md?utm_source=chatgpt.com "hermes-agent/website/docs/user-guide/features/mcp.md at main · NousResearch/hermes-agent · GitHub"

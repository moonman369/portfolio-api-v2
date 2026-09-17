# knowledge — Phase 7 baseline

Generated: 2026-09-17T07:18:01.629Z  |  route: `knowledge`  |  retrieval only, no tools

**What this file is for.** Phase 7 collapsed `about_me` and `complex` into `knowledge`, so the
trend and comparison questions that used to answer "not implemented yet" now go through
retrieval alone. Phase 9 adds the one-per-turn escalation to `agent` for the questions that
genuinely need a tool. **This is the answer Phase 9 must not regress**: if the escalation makes
this question worse, or slower for no gain, the escalation is wrong.

## Q. How have Ayan's AI skills evolved over time?

- Route: `knowledge` — was `complex`, which returned "not implemented yet".
- Documents: 15 (k=15, rerank on, decompose off — the Phase 6 decisions)
- Chronologically ordered from retrieval alone: the corpus carries `date_start`,
  `date_end` and `completion_year`, and the sanitizer passes all three to `generate`.

### Answer

```
Ayan's AI skills have evolved significantly over time, particularly since he began focusing on AI and related technologies in 2023. Here are some key milestones in his development:

- **Early Experience (2022-2023)**: Ayan started his journey in AI by leveraging Generative AI to enhance code quality and debug systems while working on microservices architecture. He also interned as a Web3 Developer, gaining foundational skills in decentralized applications and smart contracts.

- **Professional Role at TCS (August 2023)**: As a Systems Engineer at Tata Consultancy Services, Ayan built Azure-based integration systems and developed a multi-agent AI system prototype. He created production-grade AI prompts for documentation and code reviews, significantly improving engineering quality.

- **Independent Projects (2023-Present)**: Ayan has been actively working on personal projects that showcase his AI capabilities:
  - **MoonMind AI**: An AI-powered portfolio assistant that utilizes a retrieval-augmented generation pipeline.
  - **YeGPT**: A GPT-4-based chatbot that emulates Kanye West's conversational style.
  - **CodeSage**: An AI-powered code navigation tool currently under development.

- **Certifications and Continuous Learning**: Ayan has earned multiple certifications in Generative AI, including the Oracle Cloud Infrastructure 2025 Certified Generative AI Professional and the Claude Certified Developer - Foundations, which validate his expertise in building AI applications.

- **Recent Developments (2026)**: Ayan continues to expand his skills with ongoing projects and certifications, focusing on advanced AI techniques, including RAG systems and multi-agent orchestration.

Overall, Ayan's journey reflects a strong commitment to learning and applying AI technologies in practical, impactful ways.
```

### Retrieved document ids

- 3341e59a-2a2f-4e8a-8aff-eb957e1ceeba
- 8ad4c068-85e4-4a4b-aa05-bb2c59c3cd4f
- 06e6a867-36f8-4346-a177-4afa73ee8d91
- 1db2acf2-2dcd-4b07-903e-3e1a94977818
- 4b9ed8be-cca1-4bdb-9259-f7b522af8d84
- 19c78340-59ad-48f4-b278-d3bcff0f72a5
- 47223904-53c8-447f-ae6e-74a3a7af45c0
- c35b7e17-b48d-4c38-b043-c69ae6fd0727
- 55e0837f-f2c5-47c4-b192-56f5c67b3cb0
- bb24a199-cbab-4e0e-9a09-7b7619d67bf9
- 17dfdfeb-cb2d-4f33-95f6-36fee6efc982
- 201ac957-a288-4509-9436-65185762844e
- 39c1c711-78ee-4ecc-8f79-ffb313a84c09
- d743561e-33e4-43c0-8a2b-e1f9ab0f85c0
- 54964157-71e5-44fd-b340-c6095f6a3053

## Regression guards recorded alongside it

Both verify the Phase 7 gate decision — mixed queries became `slots.withDocuments` on
`stats` rather than an eighth label.

| question | route | documents | stats |
|---|---|---|---|
| Show me my github stats and my projects | `stats` | 15 | yes |
| How many GitHub repos does Ayan have? | `stats` | 0 | yes |

The second row is the point: a pure numbers question skips retrieval entirely instead of
paying for documents it would discard.

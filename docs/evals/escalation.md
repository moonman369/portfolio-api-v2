# Escalation — knowledge → agent, once per turn

Generated: 2026-09-23T09:38:20.184Z
Floors: MOONMIND_MIN_SEMANTIC_SCORE=0.82 (cut-off) · MOONMIND_ESCALATION_MIN_TOP_SCORE=0.84 (trigger) · k=15

Produced by `scripts/escalation-eval.js`. **Before** is the pre-Phase-9 path exactly:
the knowledge node then generate, floor 0. **After** is `runTurn` through the real graph.

## 1. Before / after

### What AI projects has he built and how relevant are they to the market today?

**Before** — 16693 ms, 15 documents, no tools.

```
Ayan Maiti has built several AI projects that are highly relevant to today's market, focusing on various applications of AI, including generative AI, automation, and intelligent systems. Here are some notable projects:

1. **Moonmind AI**: 
   - An AI-powered professional portfolio assistant that utilizes a custom Node.js/Express API and OpenAI's embeddings for data retrieval. It is designed to serve personal and professional data efficiently.
   - [Demo](https://moonman.in) | [GitHub](https://github.com/moonman369/Portfolio-Stats-API)

2. **Apixi**: 
   - A full-stack AI image generation platform using OpenAI's DALL-E, allowing users to create and share images from text prompts.
   - [Demo](https://apixi.vercel.app/) | [GitHub](https://github.com/moonman369/ApixiClient)

3. **Recogno**: 
   - An AI-assisted platform for learning data structures and algorithms (DSA) through spaced repetition, focusing on pattern recognition and problem-solving skills.
   - [Demo](https://recogno.moonman.in) | [GitHub](https://github.com/moonman369/recogno-ui)

4. **HirexAI**: 
   - An AI-assisted recruiting tool that matches candidates with roles using LLM-driven techniques.

5. **QueryForge**: 
   - A tool that applies retrieval-augmented generation (RAG) techniques for natural language querying over various data sources.

6. **CodeSage**: 
   - An AI-powered code navigation tool currently under development, designed to help developers understand codebases more effectively.

7. **YeGPT**: 
   - A chatbot that emulates Kanye West's conversational style, showcasing prompt engineering and integration with OpenAI's API.
   - [Demo](https://yegpt-0.vercel.app/) | [GitHub](https://github.com/moonman369/YeGPT)

8. **Ping-Bot-v0**: 
   - An AI-powered Discord chatbot that integrates conversational AI into Discord servers.
   - [Demo](https://top.gg/bot/1134185454502170694) | [GitHub](https://github.com/moonman369/Go-Discord-Bot)

9. **MeshNode**: 
   - A decentralized Q&A platform developed during a hackathon, utilizing smart contracts for trustless interactions.
   - [Demo](https://mesh-node.vercel.app/) | [GitHub](https://github.com/moonman369/MeshNode)

These projects reflect Ayan's expertise in AI and its applications, addressing current market needs such as automation, intelligent assistance, and enhanced user experiences.
```

**After** — 20323 ms · route `knowledge` · escalations=1 (`needs_current`) · 15 documents handed over · 5 web sources, 10 document-tool sources · 4 URLs cited, 0 from neither a tool nor a handed-over document. PASS

```
Ayan Maiti has built several notable AI projects, which are highly relevant to current market trends. Here’s a summary of his key projects:

1. **Moonmind AI**: An AI-powered professional portfolio assistant that utilizes a retrieval-augmented generation (RAG) pipeline. It serves personal and professional data through a custom Node.js/Express API, leveraging OpenAI's embeddings and MongoDB Atlas for vector search. This project is live and showcases advanced AI capabilities in managing and presenting portfolio data. [More details here](https://moonman.in).

2. **YeGPT**: A chatbot designed to emulate Kanye West's conversational style, focusing on prompt engineering and deployed as a public web app. This project highlights the use of generative AI in creating engaging user interactions. [Explore YeGPT](https://yegpt-0.vercel.app/).

3. **Apixi**: A full-stack AI image generation platform powered by OpenAI's DALL-E model, allowing users to generate and share images from text prompts. This project reflects the growing interest in generative AI for creative applications. [Check out Apixi](https://apixi.vercel.app/).

4. **Ping-Bot-v0**: An AI-powered Discord chatbot built with Go, integrating conversational AI capabilities into Discord servers. This project demonstrates the application of AI in social and gaming environments. [View Ping-Bot-v0](https://top.gg/bot/1134185454502170694).

5. **Claude Certified Developer**: A certification that validates Ayan's expertise in building production-ready AI applications using the Claude platform, emphasizing skills in prompt engineering and agent SDK workflows.

### Market Relevance in 2026
The current trends in AI for 2026 emphasize the following:

- **Agentic AI**: There is a significant focus on agentic AI, which involves systems that can plan, use tools, and reduce routine errors. Ayan's work in building agentic AI solutions aligns well with this trend.
- **Generative AI**: The market is increasingly viewing generative AI as a resource for organizations rather than just individual use. Projects like Moonmind AI and Apixi are positioned well within this context.
- **Workflow Orchestration**: AI is shifting towards orchestrating workflows across teams, which is relevant to Ayan's ongoing work at EY GDS, focusing on agentic workflow orchestration.
- **Practical Applications**: There is a growing demand for AI projects that deliver tangible results, such as saving time and reducing costs, which Ayan's projects aim to achieve.

Overall, Ayan Maiti's AI projects are not only innovative but also strategically aligned with the evolving demands of the AI market in 2026.
```

### Has Ayan published a cookbook?

**Before** — 9555 ms, 15 documents, no tools.

```
There is no information indicating that Ayan Maiti has published a cookbook. If you have any other questions or need assistance with something else, feel free to ask!
```

**After** — 11260 ms · route `knowledge` · escalations=1 (`weak_retrieval`) · 0 documents handed over · 0 web sources, 0 document-tool sources · 0 URLs cited, 0 from neither a tool nor a handed-over document. PASS

```
There are no records indicating that Ayan has published a cookbook.
```

## 2. No regression — the Phase 3b set and the Phase 7 baseline

None may escalate.

| question | route | escalated | documents | ms |
|---|---|---|---|---|
| What backend technologies does Ayan work with? | knowledge | no | 15 | 9806 |
| Tell me about Ayan's experience at Tata Consultancy Services. | knowledge | no | 10 | 10002 |
| What certifications does he hold? | knowledge | no | 9 | 13098 |
| What projects has he built involving RAG or vector search? | knowledge | no | 15 | 10283 |
| What is his educational background? | knowledge | no | 5 | 12703 |
| What are his hobbies and interests outside work? | knowledge | no | 1 | 8642 |
| How has he used generative AI in his day-to-day engineering work? | knowledge | no | 13 | 15628 |
| What are his strongest skills, and which projects demonstrate them? | knowledge | no | 15 | 10979 |
| Has Ayan ever worked on underwater basket weaving? | knowledge | no | 4 | 9519 |
| Show me my github stats and my projects | stats | no | 8 | 9689 |
| How have Ayan's AI skills evolved over time? | knowledge | no | 13 | 9866 |

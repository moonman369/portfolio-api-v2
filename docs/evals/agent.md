# agent — the unified four-tool node

Generated: 2026-09-17T07:31:03.837Z
Tools bound: `resolve_time`, `metadata_filter`, `semantic_search`, `web_search`  |  maxSteps: 6

## Read this first: what the router actually sends here

Phase 7's taxonomy routes every question **about Ayan** to `knowledge` — "never agent,
however much technology it mentions". Measured against the live router:

| question | route |
|---|---|
| How have his backend skills changed from 2023 to now? | `knowledge` (0.90) |
| How has Ayan upskilled in AI? | `knowledge` (0.90) |
| What AI projects has he built and how relevant are they to the market today? | `knowledge` (0.80) |

So the three questions this phase was asked to record **do not reach the agent through
the router today**. Phase 9's `knowledge` → `agent` escalation is what will hand them
over. They are recorded below by invoking the agent node directly, which measures the
node Phase 8 built; the routing gap is Phase 9's to close, and these answers are the
baseline it should beat.

## 1. Tech questions — through the whole graph

These route to `agent`, so this is end to end, and the regression guard on Phase 5.

### What is new in LangGraph this year?

- Route: `agent`
- 12223ms
- Tool sources: 5 web source(s)
- URLs in the answer: 2

Web sources returned:

- [LangGraph RCE Chain: Checkpointer Flaw Enables Server Takeover – Lab Space](https://labs.cloudsecurityalliance.org/research/csa-research-note-langgraph-rce-chain-20260614-csa-styled)
- [LangGraph Alternatives: 5 Options Compared for 2026](https://www.truefoundry.com/blog/langgraph-alternatives)
- [30+ LangChain & LangGraph Project Ideas to Build in 2026 ...](https://www.codersarts.com/post/30-langchain-langgraph-project-ideas-to-build-in-2026-beginner-to-advanced)
- [LangGraph Flaw Chain Exposes Self-Hosted AI Agents to ...](https://thehackernews.com/2026/06/langgraph-flaw-chain-exposes-self.html)
- [State of Agent Engineering - LangChain](https://www.langchain.com/state-of-agent-engineering)

```
In 2026, LangGraph has been in the spotlight due to a critical security vulnerability. A Remote Code Execution (RCE) vulnerability chain was discovered, which could potentially allow attackers to execute arbitrary code on self-hosted AI agent servers. This vulnerability, identified as CVE-2026-28277, involves unsafe deserialization in LangGraph's checkpoint loading process. However, it's important to note that managed deployments, such as those on LangChain's platform, remain unaffected by this issue. The vulnerability was reported by cybersecurity researchers and has since been patched ([The Hacker News](https://thehackernews.com/2026/06/langgraph-flaw-chain-exposes-self.html)).

Additionally, there are discussions around alternatives to LangGraph, with various options being compared for their suitability in different use cases. The landscape of AI engineering is evolving, with many organizations moving from proof-of-concept stages to deploying agents in production environments ([TrueFoundry](https://www.truefoundry.com/blog/langgraph-alternatives)).

Overall, while LangGraph continues to be a significant tool in AI development, the recent security concerns highlight the importance of vigilance in managing self-hosted deployments.
```

### How does RAG compare to fine-tuning in 2026?

- Route: `agent`
- 10993ms
- Tool sources: 15 web source(s)
- URLs in the answer: 3

Web sources returned:

- [RAG vs Fine-Tuning in 2026: A Decision Framework for LLM Teams](https://winder.ai/rag-vs-fine-tuning-2026-decision-framework)
- [RAG vs. fine-tuning](https://www.redhat.com/en/topics/ai/rag-vs-fine-tuning)
- [RAG vs Fine-Tuning for Enterprise AI: When to Use Each in 2026 | Gain America](https://gainam.com/insights/rag-vs-fine-tuning-enterprise)
- [Fine-Tuning LLMs in 2026: When RAG Isn't Enough (and When It Still Is)](https://bigdataboutique.com/blog/fine-tuning-llms-when-rag-isnt-enough)
- [RAG vs Fine Tuning: Enterprise Decisions for AI Models and AI Systems | Databricks Blog](https://www.databricks.com/blog/rag-vs-fine-tuning)
- [The 1st Workshop on Retrieval Augmented Generation for Report Generation @ ACL 2026 | ACL Member Portal](https://www.aclweb.org/portal/content/1st-workshop-retrieval-augmented-generation-report-generation-acl-2026)
- [All you need to know about RAG (in 2026) - AI with Aish](https://aishwaryasrinivasan.substack.com/p/all-you-need-to-know-about-rag-in)
- [🧠 RAG in 2026: A Practical Blueprint for Retrieval-Augmented Generation - DEV Community](https://dev.to/suraj_khaitan_f893c243958/-rag-in-2026-a-practical-blueprint-for-retrieval-augmented-generation-16pp)
- [RAG Tutorial 2026: Complete Introduction to Retrieval ... - YouTube](https://www.youtube.com/watch?v=vAK0iqA6-QI)
- [RAG in 2026: Architecture Shifts, Emerging Patterns, and What It Means for Java Developers](https://medium.com/@elammarisoufiane/rag-in-2026-architecture-shifts-emerging-patterns-and-what-it-means-for-java-developers-6f2803e39787)
- [Fine-tuning large language models (LLMs) in 2026](https://www.superannotate.com/blog/llm-fine-tuning)
- [Medium](https://medium.com/@knish5790/fine-tuning-large-language-models-llms-in-2025-623567db84e9)
- [How to Fine-Tune LLMs in 2026: Costs, GPUs, and Code | Spheron Blog](https://www.spheron.network/blog/how-to-fine-tune-llm-2026)
- [Frontiers | An efficient strategy for fine-tuning large language models](https://www.frontiersin.org/journals/artificial-intelligence/articles/10.3389/frai.2026.1665992/full)
- [Fine-tuning Large Language Models with Limited Data](https://direct.mit.edu/tacl/article/doi/10.1162/TACL.a.627/136154/Fine-tuning-Large-Language-Models-with-Limited)

```
In 2026, **Retrieval-Augmented Generation (RAG)** and **fine-tuning** are both prominent techniques for enhancing large language models (LLMs), but they serve different purposes and are often used in tandem.

### RAG
- **Dynamic Knowledge Updates**: RAG is preferred for applications requiring frequent updates to knowledge. It allows models to retrieve relevant information at query time without needing to retrain the model itself. This makes it ideal for scenarios where the underlying data changes regularly.
- **Hybrid Approach**: Most effective systems in 2026 utilize a hybrid model where RAG is combined with fine-tuning. RAG handles the retrieval of current information, while fine-tuning is used to adjust the model's behavior, style, or output structure.
- **Cost and Scalability**: RAG operates as an ongoing expense that scales with usage, making it suitable for applications with high query volumes. It is seen as the default choice for about 80% of enterprise LLM applications due to its flexibility and efficiency ([Winder AI](https://winder.ai/rag-vs-fine-tuning-2026-decision-framework)).

### Fine-Tuning
- **Stable Behavioral Adjustments**: Fine-tuning is used when a model needs to be adapted for specific tasks or domains, particularly when consistent output format or specialized behavior is required. It modifies the model's internal weights based on labeled data.
- **Affordability and Accessibility**: The process has become significantly cheaper and faster, allowing fine-tuning of models with a single GPU for under $5. This accessibility has broadened its use among developers and organizations ([SuperAnnotate](https://www.superannotate.com/blog/llm-fine-tuning)).
- **Specific Use Cases**: Fine-tuning is particularly effective for tasks that require a stable output, such as medical or legal applications, where the knowledge does not change frequently. It is less effective for rapidly changing information ([Red Hat](https://www.redhat.com/en/topics/ai/rag-vs-fine-tuning)).

### Conclusion
In summary, RAG is favored for its ability to keep models updated with current information without retraining, while fine-tuning is essential for ensuring consistent behavior and adapting models to specific tasks. The most effective strategy in 2026 is often a combination of both, leveraging RAG for dynamic content and fine-tuning for stable characteristics.
```

### What are the current best practices for vector database indexing?

- Route: `agent`
- 6716ms
- Tool sources: 5 web source(s)
- URLs in the answer: 2

Web sources returned:

- [Vector Database Guide 2026 Options Features and Benefits](https://zignuts.com/blog/vector-database-guide)
- [Best open source vector database solutions: Top 8 in 2026](https://www.instaclustr.com/education/vector-database/best-open-source-vector-database-solutions-top-5-in-2026)
- [Indexing Strategies for Efficient Vector-Based Search Guide | Unstructured](https://unstructured.io/insights/vector-indexing-strategies-for-high-performance-ai-search)
- [Vector indexing best practices  |  Spanner  |  Google Cloud Documentation](https://docs.cloud.google.com/spanner/docs/vector-index-best-practices)
- [My strategy for picking a vector database: a side-by- ...](https://www.reddit.com/r/vectordatabase/comments/170j6zd/my_strategy_for_picking_a_vector_database_a)

```
As of 2026, the best practices for vector database indexing focus on enhancing performance, scalability, and reliability. Here are the key strategies:

1. **Hybrid Indexing**: This approach combines dense vectors (which capture abstract meanings) with sparse vectors (which represent specific features). This dual strategy allows for more efficient searches across various types of data.

2. **DiskANN Technique**: This method stores the majority of the index on SSDs rather than in RAM, enabling billion-scale searches on a single machine with minimal performance lag. This is particularly useful for large datasets.

3. **Distributed and Replicated Indexing**: Spreading the vector index across multiple agents and maintaining replicas enhances reliability. This setup allows for automatic rebalancing and recovery in case of node failures.

4. **Embedding Normalization**: Ensuring consistent vector scales helps maintain predictable search results. This practice avoids issues like index drift, which can occur due to mismatched preprocessing between offline indexing and online queries.

5. **Asynchronous Auto-Indexing**: This technique allows for background index building, enabling searches to continue running while the index is updated. This minimizes downtime and improves user experience.

6. **Performance Monitoring**: Treating recall, latency, and throughput as a coupled system is crucial for maintaining high performance in production environments. Regular evaluations of indexing strategies against performance metrics are recommended.

These practices are essential for developing robust and efficient vector databases that can handle the demands of modern AI applications. For more detailed insights, you can refer to sources like the [Vector Database Guide 2026](https://zignuts.com/blog/vector-database-guide) and [Unstructured's Indexing Strategies](https://unstructured.io/insights/vector-indexing-strategies-for-high-performance-ai-search).
```

### Which vector database should I use for a small production RAG app?

- Route: `agent`
- 6442ms
- Tool sources: 5 web source(s)
- URLs in the answer: 2

Web sources returned:

- [The 6 Best Vector Database Solutions for RAG Applications | GigaSpaces AI](https://www.gigaspaces.com/blog/best-vector-database-solutions-for-rag-applications)
- [We Tried and Tested 10 Best Vector Databases for RAG ...](https://www.zenml.io/blog/vector-databases-for-rag)
- [Best Vector Databases for RAG: Top Picks for 2026](https://www.pingcap.com/compare/best-vector-database)
- [Best Vector Databases for RAG 2026: Top 7 Picks](https://alphacorp.ai/blog/best-vector-databases-for-rag-2026-top-7-picks)
- [Vector Database Comparison: Best Picks by Use Case - PE Collective](https://pecollective.com/tools/best-vector-databases)

```
For a small production RAG (Retrieval-Augmented Generation) app, **Pinecone** is highly recommended. It is a fully managed vector database designed for fast, scalable similarity search, making it ideal for production-grade RAG and real-time AI workloads. Its serverless architecture allows developers to focus on building without worrying about infrastructure management.

Here are some key points about Pinecone:
- **Ease of Use**: It abstracts away scaling constraints, simplifying deployment.
- **Performance**: Offers excellent performance with very low latency, making it suitable for production environments.
- **Cost**: While it has a free tier supporting up to 100,000 vectors, costs can increase at high sustained volumes.

Other options to consider include:
- **Qdrant**: A self-hosted option that provides strong performance and cost control, suitable for performance-critical applications.
- **Weaviate**: An open-source alternative that offers flexibility and is good for teams looking for a customizable solution.
- **Chroma**: Best for prototyping and smaller-scale applications, focusing on simplicity.

For more detailed comparisons, you can check out sources like [GigaSpaces AI](https://www.gigaspaces.com/blog/best-vector-database-solutions-for-rag-applications) and [ZenML](https://www.zenml.io/blog/vector-databases-for-rag).
```

### What changed in Node.js 22 that matters for backend services?

- Route: `agent`
- 7510ms
- Tool sources: 10 web source(s)
- URLs in the answer: 1

Web sources returned:

- [Automated individual decision-making, including profiling](https://gdpr-info.eu/art-22-gdpr)
- [22 Tips for Conference and Seminar Presentations](https://marcfbellemare.com/wordpress/10053)
- ["22" - Taylor Swift (Rock Cover by First To Eleven)](https://www.youtube.com/watch?v=OPj-dwV_T-U)
- [Covers Singing and Guitar Cover of Taylor Swift's 22 Song](https://www.tiktok.com/@obeddarkwa/video/7277661999058783520)
- [NEW MUSIC OCT 22🚨 Just some updates](https://www.instagram.com/reel/DPfS2ZVCVsk?hl=en)
- [What's new in Node.js 22?](https://zealousys.com/blog/node-js-22)
- [What's New in Node.js 22: Features & Updates You Can't Miss](https://www.drcsystems.com/nodejs-22-new-features-and-updates)
- [Node.js 22: A Game-Changer in the Development Landscape - Kellton](https://www.kellton.com/kellton-tech-blog/nodejs-22-exciting-new-features-updates)
- [Node.js 22 LTS Release: Key Features and Migration Tips - Objects](https://objects.ws/blog/node-js-22-lts-release)
- [Node.js 18: Top New Features and Updates](https://www.angularminds.com/blog/node-js-18-features-and-updates)

```
Node.js 22 introduces several significant changes that enhance backend services, focusing on performance, stability, and developer experience. Here are the key updates:

1. **Stabilized Fetch API**: Previously experimental, the Fetch API is now stable, allowing for more consistent and reliable HTTP requests. This is crucial for backend services that rely on external APIs.

2. **Enhanced Stream API**: The Stream API has been improved for better performance and usability, particularly for applications handling large data volumes. New methods and options provide better control over data flow, which is essential for real-time data processing.

3. **WebSocket Improvements**: WebSocket support has been enhanced, eliminating the need for experimental flags. This makes it easier to implement real-time communication features in applications.

4. **Better Diagnostics**: Enhanced stack traces and diagnostic reporting capabilities simplify debugging and monitoring, making it easier for developers to maintain and optimize their applications.

5. **Experimental Features**: Node.js 22 includes experimental updates for the WebAssembly System Interface (WASI) and improvements to the built-in test runner, which can help developers explore new capabilities and enhance their applications.

These updates aim to improve scalability and performance, making Node.js 22 a compelling choice for developers building backend services. For more details, you can check the [Node.js 22 release notes](https://zealousys.com/blog/node-js-22).
```

## 2. Questions about Ayan — agent node invoked directly

Watch the document tools being chosen over `web_search`, and the answers citing
document titles rather than URLs.

### How have his backend skills changed from 2023 to now?

- 5878ms
- Tool sources: 8 document(s)
- URLs in the answer: 0

Documents used:

- Java
- SpringBoot
- NodeJS
- ExpressJS
- Java
- SpringBoot
- NodeJS
- ExpressJS

```
From 2023 to now, Ayan's backend skills have remained consistent, with no new additions or changes in the technologies he is proficient in. Here’s a summary of his backend skills during both periods:

### Backend Skills in 2023
1. **Java**: Developed resilient backend services and microservice interfaces, focusing on business logic and performance optimization.
2. **SpringBoot**: Built enterprise microservices and REST APIs, optimizing performance and reliability.
3. **NodeJS**: Developed backend APIs and middleware, implementing asynchronous workflows.
4. **ExpressJS**: Created REST services and designed middleware for routing and validation.

### Backend Skills Now (2026)
- The same skills are still active and utilized:
  1. **Java**
  2. **SpringBoot**
  3. **NodeJS**
  4. **ExpressJS**

Overall, Ayan has maintained his expertise in these backend technologies without introducing new skills or making significant changes in his approach.
```

### How has Ayan upskilled in AI?

- 5855ms
- Tool sources: 5 document(s)
- URLs in the answer: 2

Documents used:

- Generative AI Mastermind – Outskill
- Oracle Cloud Infrastructure 2025 Certified Generative AI Professional
- Ayan Maiti - Professional Resume Overview
- Claude Certified Developer - Foundations
- LinkedIn Profile – Ayan Maiti

```
Ayan has significantly upskilled in AI through various certifications and practical applications in his work. Here are the key highlights:

1. **Generative AI Mastermind Certification**: Ayan completed this program by Outskill on October 26, 2025. This certification focuses on advanced concepts in generative AI, enhancing his understanding and capabilities in this area. [View Certificate](https://drive.google.com/file/d/1Es_HYqbuCvWUvdPtgaBIR-t9msRtEeZC/view?usp=sharing).

2. **Oracle Cloud Infrastructure 2025 Certified Generative AI Professional**: He earned this certification on January 14, 2026, which validates his skills in OCI Generative AI services, large language models, retrieval-augmented generation (RAG), and enterprise AI deployment patterns. [View Certificate](https://drive.google.com/file/d/1s3i9218hfue91ELClDyhXQqNdj2c7YNG/view?usp=sharing).

3. **Claude Certified Developer - Foundations**: This certification demonstrates Ayan's foundational expertise in building production-ready AI applications using the Claude platform, including skills in prompt engineering and model integration. [View Certificate](https://drive.google.com/file/d/1s3i9218hfue91ELClDyhXQqNdj2c7YNG/view?usp=sharing).

4. **Practical Application in Work**: As a Systems Engineer at Tata Consultancy Services, Ayan has leveraged generative AI to enhance code quality, debug systems, and optimize microservices architecture. His work includes developing resilient microservice interfaces and maintaining high code coverage, showcasing his ability to apply AI concepts in real-world scenarios.

These efforts reflect Ayan's commitment to advancing his skills in AI and integrating them into his professional work.
```

### What AI projects has he built and how relevant are they to the market today?

- 9828ms
- Tool sources: 5 document(s), 5 web source(s)
- URLs in the answer: 4

Documents used:

- Moonmind AI: AI Powered Professional Portfolio Assistant
- Apixi: AI Image Generator and Sharing Platform (uses DALL-E)
- Ping-Bot-v0: Golang Based AI Discord Chat Bot
- AI, GenAI & Agentic Automation Engineering Experience
- YeGPT - GPT-4 Based Kanye West Chatbot

Web sources returned:

- [What's Next in AI: Five Trends to Watch in 2026](https://blog.bytebytego.com/p/whats-next-in-ai-five-trends-to-watch)
- [8 Project Management Trends of 2026: What to Prepare For? - Epicflow](https://www.epicflow.com/blog/current-trends-in-project-management-what-to-prepare-for)
- [AI Trends Report 2026 - statworx](https://www.statworx.com/en/content-hub/whitepaper/ai-trends-report-2026)
- [The trends that will shape AI and tech in 2026 - IBM](https://www.ibm.com/think/news/ai-tech-trends-predictions-2026)
- [What's next in AI: 7 trends to watch in 2026](https://news.microsoft.com/source/features/ai/whats-next-in-ai-7-trends-to-watch-in-2026)

```
Ayan Maiti has developed several AI projects that showcase his skills and align with current market trends. Here are some notable projects:

1. **Moonmind AI**: An AI-powered professional portfolio assistant that utilizes a custom Node.js/Express API. It employs a retrieval-augmented generation pipeline to serve personal and professional data. This project is live and demonstrates Ayan's ability to integrate AI with practical applications, making it relevant for professionals seeking to enhance their portfolios. [More details here](https://moonman.in).

2. **Apixi**: A full-stack AI image generation and sharing platform powered by OpenAI's DALL-E model. Users can generate images from text prompts and share them in a community feed. This project reflects the growing interest in generative AI and creative applications, which are increasingly popular in the market. [Explore Apixi](https://apixi.vercel.app/).

3. **Ping-Bot-v0**: An AI Discord chat bot built with Go, integrating conversational AI capabilities into Discord servers. This project taps into the expanding use of AI in social platforms, making it relevant for community engagement and interaction. [Check out Ping-Bot](https://top.gg/bot/1134185454502170694).

4. **YeGPT**: A chatbot designed to emulate Kanye West's conversational style using GPT-4. This project highlights Ayan's expertise in prompt engineering and character emulation, which are increasingly sought after in entertainment and marketing sectors. [Visit YeGPT](https://yegpt-0.vercel.app/).

### Market Relevance in 2026
The AI landscape in 2026 is characterized by several trends that enhance the relevance of Ayan's projects:

- **Persistent Agents**: AI is evolving into persistent agents that manage longer workflows, which aligns with the capabilities of Moonmind AI.
- **Collaborative Problem-Solving**: AI is transitioning from passive assistance to active collaboration, making tools like Apixi and Ping-Bot more valuable in creative and community contexts.
- **Integration in Project Management**: AI is becoming a core capability in project management, which supports the relevance of Ayan's work in automating and enhancing workflows.

Overall, Ayan's projects not only demonstrate his technical skills but also align well with the current and emerging trends in the AI market, making them highly relevant today.
```

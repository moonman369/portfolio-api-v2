# Retrieval floor — semantic score distribution

Generated: 2026-09-23T09:24:21.313Z
k (MOONMIND_FINAL_DOCUMENT_LIMIT): 15 · current MOONMIND_MIN_SEMANTIC_SCORE: 0
candidate limit per arm: 30 · decompose: false

Scores are Atlas `vectorSearchScore`, i.e. (1 + cos) / 2. `kind` is what a person would
expect, for reading the table — not an input. Produced by `scripts/retrieval-floor.js`.

## 1. Semantic arm, per query

| id | kind | #1 | #2 | #5 | #10 | #15 | last | #1−#10 | arms | no-semantic candidates | returned today |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 3b-1 | broad | 0.8896 | 0.8544 | 0.8456 | 0.8367 | 0.8312 | 0.8160 | 0.0530 | semantic=30 metadata=4 | 0 | 15 |
| 3b-2 | focused | 0.8698 | 0.8632 | 0.8304 | 0.8208 | 0.8115 | 0.7919 | 0.0491 | semantic=30 metadata=1 | 0 | 15 |
| 3b-3 | focused | 0.8615 | 0.8529 | 0.8458 | 0.8189 | 0.8121 | 0.8018 | 0.0427 | semantic=30 metadata=5 | 0 | 15 |
| 3b-4 | focused | 0.8962 | 0.8852 | 0.8658 | 0.8460 | 0.8413 | 0.8133 | 0.0502 | semantic=30 metadata=2 | 0 | 15 |
| 3b-5 | focused | 0.8518 | 0.8474 | 0.8209 | 0.8073 | 0.8005 | 0.7905 | 0.0445 | semantic=30 metadata=3 | 0 | 15 |
| 3b-6 | focused | 0.8755 | 0.8184 | 0.8049 | 0.7984 | 0.7949 | 0.7874 | 0.0771 | semantic=30 metadata=1 | 0 | 15 |
| 3b-7 | broad | 0.8666 | 0.8592 | 0.8388 | 0.8245 | 0.8164 | 0.7900 | 0.0421 | semantic=30 metadata=4 | 0 | 15 |
| 3b-8 | broad | 0.8552 | 0.8505 | 0.8394 | 0.8369 | 0.8319 | 0.8207 | 0.0184 | semantic=30 metadata=16 | 4 | 15 |
| 3b-9 | nothing | 0.8539 | 0.8475 | 0.8190 | 0.8086 | 0.8061 | 0.7921 | 0.0452 | semantic=30 metadata=11 | 5 | 15 |
| 3b-10 | broad | 0.8674 | 0.8486 | 0.8231 | 0.8165 | 0.8085 | 0.7941 | 0.0509 | semantic=30 metadata=11 | 0 | 15 |
| p7 | broad | 0.8625 | 0.8471 | 0.8389 | 0.8247 | 0.8156 | 0.7941 | 0.0378 | semantic=30 metadata=2 | 0 | 15 |
| p8-1 | broad | 0.8502 | 0.8442 | 0.8360 | 0.8303 | 0.8261 | 0.8139 | 0.0200 | semantic=30 metadata=4 | 0 | 15 |
| p8-2 | broad | 0.8677 | 0.8669 | 0.8489 | 0.8306 | 0.8177 | 0.7837 | 0.0371 | semantic=30 metadata=4 | 0 | 15 |
| p8-3 | broad | 0.8635 | 0.8631 | 0.8504 | 0.8422 | 0.8325 | 0.8031 | 0.0213 | semantic=30 metadata=6 | 0 | 15 |
| n-1 | narrow | 0.8785 | 0.8519 | 0.8444 | 0.8361 | 0.8271 | 0.8124 | 0.0424 | semantic=30 metadata=3 | 1 | 15 |
| n-2 | narrow | 0.8726 | 0.8344 | 0.8316 | 0.8168 | 0.8120 | 0.8059 | 0.0558 | semantic=30 metadata=3 | 0 | 15 |
| x-1 | nothing | 0.8198 | 0.8137 | 0.7987 | 0.7817 | 0.7782 | 0.7612 | 0.0381 | semantic=30 metadata=11 | 2 | 15 |
| x-2 | nothing | 0.8276 | 0.8200 | 0.7970 | 0.7931 | 0.7776 | 0.7620 | 0.0345 | semantic=30 metadata=1 | 0 | 15 |

## 2. Documents the gate would leave — absolute floor (capped at k)

| id | kind | 0.8 | 0.82 | 0.83 | 0.84 | 0.85 | 0.86 | 0.87 |
|---|---|---|---|---|---|---|---|---|
| 3b-1 | broad | 15 | 15 | 15 | 7 | 2 | 1 | 1 |
| 3b-2 | focused | 15 | 10 | 5 | 3 | 3 | 2 | 0 |
| 3b-3 | focused | 15 | 9 | 6 | 5 | 2 | 1 | 0 |
| 3b-4 | focused | 15 | 15 | 15 | 15 | 6 | 5 | 4 |
| 3b-5 | focused | 15 | 5 | 3 | 3 | 1 | 0 | 0 |
| 3b-6 | focused | 8 | 1 | 1 | 1 | 1 | 1 | 1 |
| 3b-7 | broad | 15 | 13 | 6 | 4 | 3 | 1 | 0 |
| 3b-8 | broad | 15 | 15 | 15 | 3 | 2 | 0 | 0 |
| 3b-9 | nothing | 15 | 4 | 2 | 2 | 1 | 0 | 0 |
| 3b-10 | broad | 15 | 8 | 2 | 2 | 1 | 1 | 0 |
| p7 | broad | 15 | 13 | 8 | 4 | 1 | 1 | 0 |
| p8-1 | broad | 15 | 15 | 10 | 3 | 1 | 0 | 0 |
| p8-2 | broad | 15 | 14 | 10 | 6 | 4 | 2 | 0 |
| p8-3 | broad | 15 | 15 | 15 | 10 | 5 | 2 | 0 |
| n-1 | narrow | 15 | 15 | 13 | 6 | 2 | 1 | 1 |
| n-2 | narrow | 15 | 7 | 5 | 1 | 1 | 1 | 1 |
| x-1 | nothing | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| x-2 | nothing | 3 | 1 | 0 | 0 | 0 | 0 | 0 |

## 3. Documents the gate would leave — relative floor (within X of the query's #1, capped at k)

| id | kind | −0.01 | −0.02 | −0.03 | −0.04 |
|---|---|---|---|---|---|
| 3b-1 | broad | 1 | 1 | 1 | 2 |
| 3b-2 | focused | 2 | 3 | 3 | 5 |
| 3b-3 | focused | 2 | 5 | 6 | 9 |
| 3b-4 | focused | 1 | 4 | 4 | 5 |
| 3b-5 | focused | 3 | 3 | 4 | 8 |
| 3b-6 | focused | 1 | 1 | 1 | 1 |
| 3b-7 | broad | 2 | 3 | 5 | 9 |
| 3b-8 | broad | 2 | 11 | 15 | 15 |
| 3b-9 | nothing | 2 | 2 | 2 | 7 |
| 3b-10 | broad | 1 | 2 | 2 | 3 |
| p7 | broad | 1 | 4 | 7 | 10 |
| p8-1 | broad | 3 | 10 | 15 | 15 |
| p8-2 | broad | 2 | 6 | 6 | 10 |
| p8-3 | broad | 3 | 9 | 14 | 15 |
| n-1 | narrow | 1 | 1 | 2 | 8 |
| n-2 | narrow | 1 | 1 | 1 | 3 |
| x-1 | nothing | 2 | 4 | 5 | 12 |
| x-2 | nothing | 2 | 2 | 4 | 13 |

## 4. Top five semantic hits, per query

**3b-1** — What backend technologies does Ayan work with?

- 0.8896 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8544 NodeJS
- 0.8473 Python
- 0.8461 ExpressJS
- 0.8456 Claude Certified Developer - Foundations

**3b-2** — Tell me about Ayan's experience at Tata Consultancy Services.

- 0.8698 Systems Engineer – Tata Consultancy Services (TCS)
- 0.8632 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8548 LinkedIn Profile – Ayan Maiti
- 0.8332 B.Tech – Electrical Engineering, Techno Main Salt Lake
- 0.8304 AI, GenAI & Agentic Automation Engineering Experience

**3b-3** — What certifications does he hold?

- 0.8615 Claude Certified Developer - Foundations
- 0.8529 Generative AI Mastermind – Outskill
- 0.8492 Oracle Cloud Infrastructure 2025 Certified Generative AI Professional
- 0.8476 Google IT Automation with Python Professional Certificate
- 0.8458 Microsoft Certified: Azure Fundamentals (AZ-900)

**3b-4** — What projects has he built involving RAG or vector search?

- 0.8962 Moonmind AI: AI Powered Professional Portfolio Assistant
- 0.8852 AI, GenAI & Agentic Automation Engineering Experience
- 0.8833 CodeSage: AI Powered Code Navigator (Under Development)
- 0.8783 Generative AI
- 0.8658 GitHub Profile – moonman369

**3b-5** — What is his educational background?

- 0.8518 B.Tech – Electrical Engineering, Techno Main Salt Lake
- 0.8474 CBSE Class 12 – Delhi Public School, Ruby Park
- 0.8466 ICSE Class 10 – Ram Mohan Mission High School
- 0.8226 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8209 Generative AI Mastermind – Outskill

**3b-6** — What are his hobbies and interests outside work?

- 0.8755 Ayan Maiti - Hobbies & Personal Interests
- 0.8184 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8070 LinkedIn Profile – Ayan Maiti
- 0.8062 LeetCode Profile – moonman369
- 0.8049 GitHub Profile – moonman369

**3b-7** — How has he used generative AI in his day-to-day engineering work?

- 0.8666 Generative AI
- 0.8592 AI Engineer – EY GDS
- 0.8546 AI, GenAI & Agentic Automation Engineering Experience
- 0.8413 CodeSage: AI Powered Code Navigator (Under Development)
- 0.8388 Systems Engineer – Tata Consultancy Services (TCS)

**3b-8** — What are his strongest skills, and which projects demonstrate them?

- 0.8552 AI, GenAI & Agentic Automation Engineering Experience
- 0.8505 Quick Learning
- 0.8421 Systems Engineer – Tata Consultancy Services (TCS)
- 0.8399 Moonmind AI: AI Powered Professional Portfolio Assistant
- 0.8394 BlinkMart - Fully Functional Quick Commerce Platform

**3b-9** — Has Ayan ever worked on underwater basket weaving?

- 0.8539 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8475 Ayan Maiti - Hobbies & Personal Interests
- 0.8235 Claude Certified Developer - Foundations
- 0.8222 AI Engineer – EY GDS
- 0.8190 LinkedIn Profile – Ayan Maiti

**3b-10** — Show me my github stats and my projects

- 0.8674 GitHub Profile – moonman369
- 0.8486 Moonmind AI: AI Powered Professional Portfolio Assistant
- 0.8285 BlinkMart - Fully Functional Quick Commerce Platform
- 0.8254 Ping-Bot-v0: Golang Based AI Discord Chat Bot
- 0.8231 DeFund: Decentralized Crowdfunding

**p7** — How have Ayan's AI skills evolved over time?

- 0.8625 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8471 Generative AI Mastermind – Outskill
- 0.8448 Claude Certified Developer - Foundations
- 0.8441 AI Engineer – EY GDS
- 0.8389 Oracle Cloud Infrastructure 2025 Certified Generative AI Professional

**p8-1** — How have his backend skills changed from 2023 to now?

- 0.8502 Systems Engineer – Tata Consultancy Services (TCS)
- 0.8442 NodeJS
- 0.8405 Python
- 0.8363 SpringBoot
- 0.8360 Generative AI

**p8-2** — How has Ayan upskilled in AI?

- 0.8677 Generative AI Mastermind – Outskill
- 0.8669 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8539 Oracle Cloud Infrastructure 2025 Certified Generative AI Professional
- 0.8524 Claude Certified Developer - Foundations
- 0.8489 LinkedIn Profile – Ayan Maiti

**p8-3** — What AI projects has he built and how relevant are they to the market today?

- 0.8635 Moonmind AI: AI Powered Professional Portfolio Assistant
- 0.8631 AI, GenAI & Agentic Automation Engineering Experience
- 0.8569 YeGPT - Kanye West Chatbot
- 0.8521 Ping-Bot-v0: Golang Based AI Discord Chat Bot
- 0.8504 CodeSage: AI Powered Code Navigator (Under Development)

**n-1** — Ayan's resume

- 0.8785 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8519 LinkedIn Profile – Ayan Maiti
- 0.8462 CBSE Class 12 – Delhi Public School, Ruby Park
- 0.8460 ICSE Class 10 – Ram Mohan Mission High School
- 0.8444 Ayan Maiti - Hobbies & Personal Interests

**n-2** — What is his LinkedIn profile?

- 0.8726 LinkedIn Profile – Ayan Maiti
- 0.8344 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8328 GitHub Profile – moonman369
- 0.8324 Moonmind AI: AI Powered Professional Portfolio Assistant
- 0.8316 LeetCode Profile – moonman369

**x-1** — Has Ayan published a cookbook?

- 0.8198 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8137 Ayan Maiti - Hobbies & Personal Interests
- 0.8026 Claude Certified Developer - Foundations
- 0.8023 Generative AI Mastermind – Outskill
- 0.7987 LinkedIn Profile – Ayan Maiti

**x-2** — What is Ayan's favourite football club?

- 0.8276 About Ayan Maiti a.k.a moonman369 a.k.a moonman
- 0.8200 Ayan Maiti - Hobbies & Personal Interests
- 0.8024 LinkedIn Profile – Ayan Maiti
- 0.7991 Generative AI Mastermind – Outskill
- 0.7970 Microsoft Certified: Azure Fundamentals (AZ-900)


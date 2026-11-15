# Project Requirements: TableSpace — 3D SQL Visualizer & Local AI Data Architect

## 1. Overview
Build a React web application that renders SQL database schemas (tables, columns, and foreign key relationships) as an interactive 3D spatial universe using **React Three Fiber (R3F)** and **Drei**. Embed an autonomous **AI Agent powered by a in-browser wllama hosted LLM** that goes beyond standard SQL generation, entity relationship viewer to visually manipulate the 3D scene, simulate query execution, and preview schema refactoring in real time.

---

## 2. Tech Stack
* **Frontend:** React, TypeScript, Tailwind CSS, Zustand (state management).
* **3D Engine:** `@react-three/fiber`, `@react-three/drei`, `three`, `d3-force-3d` (for automatic 3D spatial clustering), and `@react-three/postprocessing` (glow/bloom effects).
* **AI Integration:** Local wllama hosted LLM w/ structured tool-calling / function-calling.
* **Backend Bridge:** no backend for now, use a built-in realistic mock schema/metadata for instant zero-setup preview/demo (w/ extension capability to add more mock schema later).

---

## 3. Core 3D Visualization Requirements
* **3D Table Monoliths:** Render each SQL table as a sleek, glassmorphic 3D card/box displaying table name, primary/foreign keys, and column data types. Dynamically scale node volume or height based on table row count, and color-code by schema or domain, w/ collapsible design to make it mobile friendly.
* **3D Relationship Splines:** Connect foreign key columns to target primary keys using curved 3D lines with animated directional particle flows indicating cardinality (`1:1`, `1:N`, `M:N`).
* **Spatial Layout & Camera:** Automatically cluster heavily related tables together in 3D space using force-directed physics. Support smooth camera flight transitions to clicked/searched tables, an exploded-cluster view, and an X-ray mode that dims unrelated tables to isolate dependencies.

---

## 4. Autonomous AI Agent Capabilities (Beyond Traditional Apps)
Embed a collapsible AI chat drawer that uses Ollama tool-calling to control both the 3D canvas and database workflows:
* **AI-Controlled Camera & Isolation:** When asked about a domain or table, the agent flies the 3D camera to the relevant cluster, highlights those nodes, and dims the rest of the database.
* **Visual Query Packet Tracing:** When given a complex query, the agent parses the execution plan and animates glowing data pulses across the 3D relationship lines in the exact join sequence, turning red on slow sequential scans.
* **Holographic "Ghost-Mode" Refactoring:** When asked to normalize or split tables, the agent spawns translucent wireframe "ghost tables" and dashed relationships directly in the 3D scene alongside live tables to preview changes before generating migration SQL.
* **3D Architectural Anti-Pattern Radar:** The agent audits the schema for missing foreign-key indexes, orphaned tables, or bloated "God tables" and attaches floating 3D warning badges directly above affected tables.
* **Dependency-Aware Synthetic Data Seeding:** The agent traverses the 3D relationship graph in topological order to generate and insert realistic mock records across parent and child tables while animating data filling the 3D table volumes.

---

## 5. UI / UX Layout
* **Full-Screen 3D Viewport:** Dark cyber-slate environment with a subtle spatial floor grid and ambient lighting.
* **Bar:** Database switcher (including Demo Mode), wllama connection status indicator, and local model selector.
* **Control Dock:** Quick action buttons for resetting the camera, toggling X-ray mode, exploding clusters, clearing AI ghost previews, and quick-searching tables (`Cmd+K`).
* **Right Collapsible AI Drawer:** Streaming chat interface with one-click smart prompt chips (e.g., *"Audit missing indexes"*, *"Simulate checkout join"*, *"Normalize bloated tables"*).


## 6. Reference
Refer to the Andai project for wllama hosting & how to make it mobile-friendly: /Users/aldrickwan/Documents/project/Andai.

## 7. Make sure it can be deployed into firebase as a static WPA web app.

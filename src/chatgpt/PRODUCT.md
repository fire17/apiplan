# ChatGPT terminal

## Register
Product: a terminal workspace within APIPlan.

## Users and purpose
Tami and local agents use an existing ChatGPT website account from their terminal. The primary workflows are finding any conversation, continuing work in its original project, and using multimodal tools without losing conversation identity. Every interactive action has a scriptable command.

## Character
Direct, precise, responsive. Inherit APIPlan's terminal typography and blue active/green success/amber attention colors from `bin/apiplan.ts` and `src/chat.ts`. Favor readable transcripts and useful metadata over ornamental dashboards.

## Design principles
- Account and conversation identity are always visible.
- Search and full enumeration do not depend on collapsed navigation.
- Streaming, cancellation, failures, partial indexes, and unavailable capabilities are explicit states.
- Keyboard-first with discoverable commands; preserve Unicode text, terminal resize, and safe paste.
- Media has a native preview when supported and a useful accessible fallback.
- Credentials and private conversation data never appear in diagnostic logs by default.

## Context
The user works in an existing terminal alongside several agentic tools. Honor the terminal background and familiar APIPlan colors; no imposed light/dark page theme. A three-region workspace separates navigation, transcript, and context at wide widths, collapsing structurally in smaller terminals.

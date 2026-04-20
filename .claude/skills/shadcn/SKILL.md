---
name: shadcn
description: Use shadcn/ui for non-chat UI in ted/web. Chat primitives (Thread, Composer) keep using @assistant-ui/react. Settings pages, forms, dialogs, modals, admin surfaces use shadcn components. Run this skill when the user asks to add, style, or refactor non-chat UI in the web app.
---

# shadcn/ui in ted

## Scope
- **Use shadcn for:** settings pages, forms, dialogs, dropdowns, toasts, badges, cards, tables, navigation.
- **Do NOT use shadcn for chat:** `@assistant-ui/react` + the AI SDK `useChat` hook still drive the chat thread. The one exception is if you need a styled Button inside a chat control — fine to import from shadcn.

## Install locations
- App lives at `/home/robert/ted/web` (Next.js 15, App Router, Tailwind 3, React 19).
- shadcn CLI config: `web/components.json`.
- Components are written to `web/components/ui/*` (copy-paste, not a dep).
- Utility `cn()` at `web/lib/utils.ts`.

## Adding a component

```bash
cd /home/robert/ted/web
npx shadcn@latest add button input card dialog badge dropdown-menu
```

Each component is added to `components/ui/`. Import with:
```tsx
import { Button } from '@/components/ui/button';
```

## Theming
- App is dark-first (`body.bg-zinc-950`).
- CSS variables live in `app/globals.css` (`:root` + `.dark`). The `dark` class is on `<html>`.
- When adding components, don't hardcode zinc/neutral values — use the theme tokens (`bg-background`, `text-foreground`, `border-input`, etc.) so light/dark stay in sync.

## When not to touch
- Files under `components/ChatThread.tsx`, `components/ChatHeader.tsx`, and anything inside `app/chat/**` that drives the streaming bubble flow. Those use bespoke styling tied to the assistant-ui protocol.

## Reusing vs. overriding
- Prefer composing shadcn primitives over forking them. If a design needs a variant (e.g. a destructive outline button), add it via the component's `variant` enum rather than cloning the file.
- If a component's shipped styles don't match ted's dark theme, edit `components/ui/*` directly — copy-paste is by design, you own the file.

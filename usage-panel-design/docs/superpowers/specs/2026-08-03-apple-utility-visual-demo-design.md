# Apple Utility Visual Demo Design

**Status:** Approved in conversation on 2026-08-03

## Goal

Explore an Apple-inspired visual direction for the Sub2API Windows widget, including a system-aware appearance setting and a tray-triggered floating quota window, without changing the production Tauri/React UI yet.

## Decisions

- The floating window opens from the tray and hides when it loses focus.
- Appearance choices are `跟随系统`, `浅色`, and `深色`.
- If no appearance choice has been saved, the effective appearance is light.
- `跟随系统` responds to the OS color-scheme media query.
- The floating window shows the selected API's display name, health state, remaining percentage, and a compact progress indicator.
- The full panel remains the place for history, models, settings, and configuration.

## Visual Direction

The recommended direction is **Quiet Apple Utility**: restrained system typography, generous rounded geometry, translucent material for floating surfaces, soft depth, and a single warm accent reserved for quota and action feedback. The prototype should make the main panel and float state visible at the same time so their hierarchy can be judged together.

## Prototype Scope

Create one standalone, clearly marked HTML prototype with three structurally different variants, switchable via `?variant=` and a fixed prototype switcher:

- `quiet`: recommended utility layout with large remaining percentage and compact sections.
- `capsule`: float-first layout with a glass capsule as the primary object.
- `native`: Windows-utility layout with denser settings and a more explicit status rail.

Each variant supports in-memory light/dark/system theme switching, a simulated selected API, and a click that toggles the floating quota card. No real credentials, network calls, persistence, or production imports are used.

## Acceptance Criteria

- Opening the HTML file renders without a build step.
- The appearance control visibly switches light, dark, and system-derived states; an unset state starts light.
- The floating card is shown in the design and can be opened/hidden in the prototype.
- The three variants are shareable using `?variant=quiet`, `?variant=capsule`, and `?variant=native`.
- Arrow buttons and keyboard arrow keys switch variants without intercepting text-input navigation.
- The prototype is clearly labeled as exploratory and does not alter `src/App.jsx` or `src/styles.css`.

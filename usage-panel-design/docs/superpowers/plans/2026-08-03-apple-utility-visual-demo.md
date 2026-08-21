# Apple Utility visual demo implementation plan

## Goal

Create a standalone, no-build HTML prototype for the Sub2API usage panel so the approved visual direction and the Windows floating-window interaction can be reviewed before touching the production app.

## Scope

- Add `prototypes/apple-utility-demo.html` as the only prototype implementation file.
- Keep all prototype state in memory; do not read credentials, call an API, or write production settings.
- Provide three switchable variants on the same route:
  - `?variant=quiet`: recommended Quiet Apple Utility dashboard.
  - `?variant=capsule`: float-first translucent capsule.
  - `?variant=native`: denser Windows utility layout.
- Include an in-page variant switcher, left/right keyboard navigation, a simulated API selector, and an appearance selector with `跟随系统 / 浅色 / 深色`.
- Make the effective initial appearance light when no choice has been made; make `跟随系统` respond to the OS color-scheme media query.
- Simulate the agreed float behavior with a compact quota card that can be shown or hidden and opens the full panel when selected.

## Implementation steps

1. Build the self-contained HTML structure, design tokens, responsive layouts, and motion styles for all three variants.
2. Add lightweight vanilla JavaScript for URL-based variant selection, keyboard/arrow navigation, appearance state, system-theme changes, API selection, and float visibility.
3. Verify the file is standalone, contains the three variant paths and requested controls, and does not modify `src/` or require a build tool.
4. Hand off the local file and the three preview URLs for visual review; production implementation remains a separate follow-up.

## Acceptance criteria

- Opening the file directly renders a usable prototype without dependencies or a build step.
- The default screen is the `quiet` variant with light appearance.
- Appearance options visibly update the prototype; `跟随系统` resolves from the OS preference.
- The compact float preview shows API name, status, remaining percentage, and progress; the main surface can be opened from it.
- All three variants are materially different and can be reached through the fixed bottom switcher and keyboard arrows.
- The prototype clearly labels itself as an exploration and does not imply that real API data is connected.

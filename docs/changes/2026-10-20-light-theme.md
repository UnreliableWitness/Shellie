# Light theme

Light theme (spec `docs/superpowers/specs/2026-10-20-light-theme-design.md`) implemented 2026-10-20 on `feature/light-theme`: Settings → Appearance → Theme (System / Light / Dark, default System) sets `nativeTheme.themeSource`; CSS follows `prefers-color-scheme` (light block in `tokens.css`), terminals, Monaco and Mermaid follow `src/renderer/colorScheme.ts`, main re-colours the window background and Windows title-bar overlay on `nativeTheme` updates. `tokens.test.ts` checks contrast and that no stylesheet outside `tokens.css` has colour literals.

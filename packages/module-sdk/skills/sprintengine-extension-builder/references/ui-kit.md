# UI: the host's kit, the door shell, theme tokens

Studio lends its own components to modules, so an extension looks like the
app instead of a shade off it. They are **host-provided**: the SDK ships their
types, and the real components arrive at runtime through an import map. Mark
them external (the template build already does) — bundling the SDK's copy in
fails loudly at load: "…is provided by the host at runtime; mark it external".

## `@sprintengine/module-sdk/ui`

| Component | Use |
| --- | --- |
| `PrimaryButton` | The one affirmative action on a surface (`busy` for pending) |
| `GhostButton` | Every other button (`tone`, `pressed`, `size`) |
| `OutlineButton` | A secondary action beside a primary one |
| `LinkButton` | Navigation that reads as a link |
| `RowButton` | A full-width list row (`selected`, `density`) |
| `Input`, `Textarea` | Text entry (`variant`, `size`, `fullWidth`; Textarea `resize`) |
| `Field` | Label + help + error around ONE input; pass `htmlFor` matching the input's `id`. Omit `htmlFor` for a composite control (a segmented control) and it renders the label as text |
| `Select` | A dropdown: `ariaLabel`, `items: [{ value, label }]`, `value`, `onChange` |
| `SegmentedControl` | A small exclusive choice |
| `PanelHeader` | A panel's title row (`subtitle` or `scope`, `primaryAction`, `count`) |
| `Section` | A titled group (`title`, `count`, `action`) |
| `EmptyState` | Nothing here yet (`title`, `body`, `action`; `density="list"` inside a list) |
| `Banner` | Panel-wide error/warn strip with retry |
| `InlineNotice` | An error/warning where it happened |
| `Spinner` | Loading (give it `label` to announce it) |
| `LifecycleGlyph` | A state shown as a shape (`state`, `live`) |
| `Drawer` / `Drawer.Body` | A side drawer |
| `TruncatedText` | Clamped text with a tooltip only when clipped |
| `KbdChord` | A keyboard shortcut, drawn per platform |
| `CliModelPickerButton` | The runtime + model picker the app uses |
| `FOCUS_RING_CLASS` | The focus-ring class for a focusable you draw yourself |

`StatusDot` exists for compatibility and draws shapes; do not add dots of
your own. State is a word, a lifecycle glyph, or a timer.

The kit is deliberately small and frozen. A component that is not in it is
cheaper copied into your module than waited for.

## `@sprintengine/module-sdk/surface`

For a global surface (door) or a modal body:

```tsx
import { GlobalSurfaceShell, SurfaceCanvasState, useSurfaceBackNav } from '@sprintengine/module-sdk/surface'

function Door() {
  const { onBack, canGoBack } = useSurfaceBackNav()
  return (
    <GlobalSurfaceShell ariaLabel="Weather" bar={{ title: 'Weather', actions: <GhostButton>Refresh</GhostButton> }}
      rail={<MyList />} onBack={onBack} canGoBack={canGoBack}>
      <SurfaceCanvasState kind="empty" glyph={<CloudIcon />} title="Pick a city" />
    </GlobalSurfaceShell>
  )
}
```

`SurfaceRail` is the list column the app's own doors use (rows, groups,
search, filter, a "new" affordance); `SurfaceCanvasState` is the one
loading / empty / error canvas.

## `@monaco-editor/react`

Depend on it for types; the host provides the instance (one Monaco in the
process). Drive its theme from `host.watchColorScheme(scheme => …)`.

## Styling

- **Theme tokens only.** `var(--bg-surface)`, `var(--text-muted)`,
  `var(--border-subtle)`, `var(--accent-primary)`, `var(--tone-warn)`… The full
  list is `THEME_TOKENS` in the SDK. Never a hex value, never a value read from
  the DOM and cached.
- Tones are single values. For a soft fill:
  `color-mix(in srgb, var(--tone-good) 15%, transparent)`.
- Motion: `transition: opacity var(--motion-normal) var(--motion-ease)`.
- **Tailwind classes you write produce no CSS** — Studio's stylesheet is built
  from Studio's source only. Either:
  - inline styles and plain CSS on tokens, injected once as a `<style>`
    element (the panel template's `styles.ts` + `styles.css`, imported as
    text with esbuild's `--loader:.css=text`), with every selector prefixed by
    the module id; or
  - your own utilities-only Tailwind build: an entry with
    `@import "tailwindcss/theme" theme(reference); @import "tailwindcss/utilities" layer(utilities) source(none); @source "./src";`,
    compiled with `@tailwindcss/cli` and injected the same way. Never ship
    Tailwind's preflight: it would restyle the whole app.
- Icons: 24×24 viewBox, `stroke="currentColor"`, sized by the `className`
  the shell passes.

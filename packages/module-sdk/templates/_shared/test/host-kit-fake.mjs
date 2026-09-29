// Stand-ins for the specifiers SprintEngine Studio answers at runtime
// (`@sprintengine/module-sdk/ui`, `@sprintengine/module-sdk/surface`,
// `@monaco-editor/react`). The published package's own copies of the first two
// throw the moment they load — on purpose, so a bundle that inlined them fails
// loudly — which means a test that loads your renderer bundle outside the app
// needs these instead. smoke.test.mjs routes the specifiers here.
//
// Every export renders nothing. They exist so the bundle can load and register;
// what your components draw is checked in the app.

const component = (name) => {
  const Component = () => null
  Component.displayName = name
  return Component
}

// @sprintengine/module-sdk/ui
export const FOCUS_RING_CLASS = ''
export const PrimaryButton = component('PrimaryButton')
export const GhostButton = component('GhostButton')
export const OutlineButton = component('OutlineButton')
export const LinkButton = component('LinkButton')
export const RowButton = component('RowButton')
export const Input = component('Input')
export const Textarea = component('Textarea')
export const Field = component('Field')
export const Select = component('Select')
export const SegmentedControl = component('SegmentedControl')
export const PanelHeader = component('PanelHeader')
export const Banner = component('Banner')
export const InlineNotice = component('InlineNotice')
export const EmptyState = component('EmptyState')
export const Spinner = component('Spinner')
export const StatusDot = component('StatusDot')
export const LifecycleGlyph = component('LifecycleGlyph')
export const Section = component('Section')
export const Drawer = Object.assign(component('Drawer'), { Body: component('Drawer.Body') })
export const TruncatedText = component('TruncatedText')
export const KbdChord = component('KbdChord')
export const CliModelPickerButton = component('CliModelPickerButton')

// @sprintengine/module-sdk/surface
export const GlobalSurfaceShell = component('GlobalSurfaceShell')
export const useSurfaceBackNav = () => ({ onBack() {}, canGoBack: false })
export const SurfaceCanvasState = component('SurfaceCanvasState')
export const SurfaceRail = component('SurfaceRail')

// @monaco-editor/react
export const Editor = component('Editor')
export const DiffEditor = component('DiffEditor')
export default Editor

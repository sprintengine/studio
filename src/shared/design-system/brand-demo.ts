// Result shape for resolving the built-in "seed from the Multicode brand"
// demo source (main-process resolver ↔ preload ↔ renderer). Unavailable
// builds resolve ok:false with the cause; the wizard renders it verbatim as
// the disabled demo card's body copy.
export type DesignSystemBrandDemoResolveResult =
  | { ok: true; path: string }
  | { ok: false; message: string }

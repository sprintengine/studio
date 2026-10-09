// `@sprintengine/module-sdk/testing/register` — install the pass-through kit
// before any test file loads:
//
//   node --import @sprintengine/module-sdk/testing/register --test …
//
// A test that imports a module's renderer source (or its built bundle)
// statically pulls in `@sprintengine/module-sdk/ui` before its own first line
// runs, so `installTestingKit()` inside the test would be too late. Loading
// this first routes the host-provided specifiers for the whole run; `node
// --test` passes the flag on to every test file's process.

import { installTestingKit } from './testing.js'

installTestingKit()

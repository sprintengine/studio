import type { DesignSystemAttachResult, DesignSystemAttachSource, DesignSystemDetachResult } from '../../shared/design-system/attach';
import { type LibraryPaths } from './library-registry';
export declare const DESIGN_SYSTEM_ATTACH_DIRNAME = "design-system";
/**
 * Attach a design-system bundle to a consuming workspace: validate the source
 * bundle, refuse an existing `design-system/` in the target, copy the full
 * bundle through a dot-prefixed staging dir + rename, and stamp `attachedAt`
 * (plus the library coordinates for library sources) into the copy's manifest
 * via the canonical parser round-trip — unknown fields preserved, the source
 * bundle never mutated. A browsed folder that already carries release
 * provenance keeps it verbatim.
 */
export declare function attachDesignSystemBundle(source: DesignSystemAttachSource, workspaceRoot: string, libraryPaths: LibraryPaths): Promise<DesignSystemAttachResult>;
/**
 * Detach: remove `<workspace>/design-system/` outright. The caller owns the
 * confirmation — this deletes local edits along with the copy, and a bundle
 * authored in place rather than attached is deleted the same way. A symlinked
 * `design-system/` removes the LINK only (lstat, not stat), never the folder
 * it points at; nothing here ever writes outside the workspace root.
 */
export declare function detachDesignSystemBundle(workspaceRoot: string): Promise<DesignSystemDetachResult>;

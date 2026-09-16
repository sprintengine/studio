import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { STUDIO_SKILL_SOURCE_NAME } from './skills'
import {
  ADD_LOCAL_SKILL_SOURCE_LABEL,
  DEFAULT_USER_SKILLS_DIR_DISPLAY,
  NO_WORKFLOW_ROLES_HEAD,
  NO_WORKFLOW_ROLES_INSTALLED_MESSAGE,
  NO_WORKFLOW_ROLES_INSTALLED_ON_DESKTOP_MESSAGE,
  WORKFLOW_ROLES_PACK_ID,
  missingRoleMessage,
  workflowRolesInstalled,
} from './workflow-roles'

const CATALOGUE = readFileSync(
  join(process.cwd(), 'src/renderer/src/components/workspace/globalSurface/extensions/catalogue/CatalogueSurface.tsx'),
  'utf8',
)

assert.equal(
  ADD_LOCAL_SKILL_SOURCE_LABEL,
  'Add from folder…',
  'the shipping menu label is the folder picker, not a file picker',
)
assert.match(
  CATALOGUE,
  /ADD_LOCAL_SKILL_SOURCE_LABEL/,
  'the Extensions plus menu renders the same constant the empty-pack error quotes',
)
assert.equal(
  NO_WORKFLOW_ROLES_INSTALLED_MESSAGE.includes(ADD_LOCAL_SKILL_SOURCE_LABEL),
  true,
  'the error quotes the shipping menu label verbatim',
)
assert.equal(
  NO_WORKFLOW_ROLES_INSTALLED_MESSAGE.includes(STUDIO_SKILL_SOURCE_NAME),
  true,
  'the error names the SprintEngine Studio skill source',
)
assert.equal(
  NO_WORKFLOW_ROLES_INSTALLED_MESSAGE.includes(WORKFLOW_ROLES_PACK_ID),
  true,
  'the error names the workflow-roles pack',
)
assert.equal(
  NO_WORKFLOW_ROLES_INSTALLED_MESSAGE.includes(DEFAULT_USER_SKILLS_DIR_DISPLAY),
  true,
  'the error names the default skills folder',
)

assert.match(
  missingRoleMessage('architect'),
  /Unknown role 'architect': no workflow roles are installed in this workspace/,
)
assert.match(missingRoleMessage('architect'), new RegExp(ADD_LOCAL_SKILL_SOURCE_LABEL.replace(/[…]/g, '…')))
assert.doesNotMatch(missingRoleMessage('architect'), /Known roles/)

assert.match(
  missingRoleMessage('qa-test', ['architect', 'developer']),
  /Unknown role 'qa-test': no skill declaring it is installed in this workspace/,
)
assert.match(missingRoleMessage('qa-test', ['architect', 'developer']), /Known roles: architect, developer/)
assert.doesNotMatch(missingRoleMessage('qa-test', ['architect', 'developer']), /tester/)

assert.equal(workflowRolesInstalled(null), false)
assert.equal(workflowRolesInstalled({ roles: {} }), false)
assert.equal(
  workflowRolesInstalled({ roles: { host: { source: { layer: 'bundled' } } } }),
  false,
  'a bundled-layer leftover is not an installed role',
)
assert.equal(
  workflowRolesInstalled({ roles: { architect: { source: { layer: 'workspace' } } } }),
  true,
)

assert.match(NO_WORKFLOW_ROLES_INSTALLED_ON_DESKTOP_MESSAGE, /on the desktop/)
assert.doesNotMatch(NO_WORKFLOW_ROLES_INSTALLED_ON_DESKTOP_MESSAGE, /Add from/)

const pythonRegistry = readFileSync(
  join(process.cwd(), 'sprintengine_core', 'role_registry.py'),
  'utf8',
)
assert.ok(
  pythonRegistry.includes(NO_WORKFLOW_ROLES_HEAD),
  'the engine empty-pack head matches the desktop copy',
)
assert.ok(
  pythonRegistry.includes(ADD_LOCAL_SKILL_SOURCE_LABEL),
  'the engine quotes the same shipping menu label',
)
assert.ok(
  pythonRegistry.includes(STUDIO_SKILL_SOURCE_NAME),
  'the engine names the same skill source',
)

console.log('workflow-roles.test.ts passed')

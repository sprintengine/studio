// Generated from sprintengine_mcp/schemas.py — do not edit.
// Regenerate: python3 scripts/generate_sprintengine_tool_names.py

export const SPRINTENGINE_TOOL_NAMES = [
  'sprintengine.agent.heartbeat',
  'sprintengine.agent.join',
  'sprintengine.agent.leave',
  'sprintengine.agent.next_directive',
  'sprintengine.artifact.add',
  'sprintengine.artifact.approve',
  'sprintengine.artifact.list',
  'sprintengine.artifact.ready',
  'sprintengine.artifact.request_changes',
  'sprintengine.feedback.recommend_actions',
  'sprintengine.feedback.summarize',
  'sprintengine.handover',
  'sprintengine.health',
  'sprintengine.help',
  'sprintengine.init',
  'sprintengine.join',
  'sprintengine.plan.add_dependency',
  'sprintengine.plan.add_task',
  'sprintengine.plan.address_reviews',
  'sprintengine.plan.delete_task',
  'sprintengine.plan.list',
  'sprintengine.plan.read',
  'sprintengine.plan.remove_dependency',
  'sprintengine.plan.review_status',
  'sprintengine.plan.start_review',
  'sprintengine.plan.update_task',
  'sprintengine.recover',
  'sprintengine.roles.get',
  'sprintengine.roles.list',
  'sprintengine.roster.configure',
  'sprintengine.run.get',
  'sprintengine.run.policy.get',
  'sprintengine.run.subscribe',
  'sprintengine.skill.get',
  'sprintengine.skills.list',
  'sprintengine.soul.get',
  'sprintengine.summary',
  'sprintengine.task.advance',
  'sprintengine.task.claim',
  'sprintengine.task.comment',
  'sprintengine.task.comment.list',
  'sprintengine.task.get',
  'sprintengine.task.list',
  'sprintengine.task.log',
  'sprintengine.task.next',
  'sprintengine.task.note',
  'sprintengine.task.publish',
  'sprintengine.task.release',
  'sprintengine.task.resolve_input',
  'sprintengine.task.status',
  'sprintengine.triage.needs_input',
  'sprintengine.vcs.commit',
  'sprintengine.vcs.pr',
  'sprintengine.vcs.request_repo',
  'sprintengine.vcs.status',
] as const

export type SprintEngineToolName = (typeof SPRINTENGINE_TOOL_NAMES)[number]

// Canonical definitions are generated from the Python MCP owner. The Studio
// gateway consumes these to advertise run-native tools even before a run
// exists, without reimplementing schemas in Electron main.
export const SPRINTENGINE_TOOL_DEFINITIONS = [
  {
    "name": "sprintengine.agent.heartbeat",
    "description": "agent heartbeat",
    "inputSchema": {
      "type": "object",
      "required": [
        "agentId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "agentId": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        }
      }
    }
  },
  {
    "name": "sprintengine.agent.join",
    "description": "agent join",
    "inputSchema": {
      "type": "object",
      "required": [
        "role",
        "agentId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "agentId": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        }
      }
    }
  },
  {
    "name": "sprintengine.agent.leave",
    "description": "agent leave",
    "inputSchema": {
      "type": "object",
      "required": [
        "agentId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "agentId": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "reason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.agent.next_directive",
    "description": "agent next directive",
    "inputSchema": {
      "type": "object",
      "required": [
        "role",
        "agentId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "agentId": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "attempts": {
          "type": "integer",
          "minimum": 1,
          "description": "Current watch attempt count, used only to calculate retry timing for idle auto-mode directives."
        }
      }
    }
  },
  {
    "name": "sprintengine.artifact.add",
    "description": "artifact add",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "kind",
        "title",
        "path"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "artifactId": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "kind": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "path": {
          "type": "string"
        },
        "createdBy": {
          "type": "string"
        },
        "recommendedTask": {
          "type": "array"
        },
        "ready": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.artifact.approve",
    "description": "artifact approve",
    "inputSchema": {
      "type": "object",
      "required": [
        "artifactId",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "artifactId": {
          "type": "string",
          "description": "Sprint Engine artifact id."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "approvalMode": {
          "type": "string",
          "enum": [
            "manual",
            "policy"
          ],
          "description": "Approval provenance: 'manual' (human) or 'policy' (run auto-approval). Optional; omit for a plain approval."
        }
      }
    }
  },
  {
    "name": "sprintengine.artifact.list",
    "description": "artifact list",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "kind": {
          "type": "string"
        },
        "status": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.artifact.ready",
    "description": "artifact ready",
    "inputSchema": {
      "type": "object",
      "required": [
        "artifactId",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "artifactId": {
          "type": "string",
          "description": "Sprint Engine artifact id."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "directiveClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "taskClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "acceptanceCriteriaClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "swarmToolEffectivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "promptOptimizationPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "contextFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "hallucinationRiskPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "roleFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "autonomyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "confidencePct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "correctnessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "evidenceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "instructionFollowingPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "codeQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "maintainabilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "testQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "securityQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "performanceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendFunctionalityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendAestheticQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "accessibilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "uxCompetitivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "claimsChecked": {
          "type": "integer",
          "minimum": 0
        },
        "hallucinatedClaims": {
          "type": "integer",
          "minimum": 0
        },
        "factualErrors": {
          "type": "integer",
          "minimum": 0
        },
        "implementationMistakes": {
          "type": "integer",
          "minimum": 0
        },
        "missedRequirements": {
          "type": "integer",
          "minimum": 0
        },
        "regressionCount": {
          "type": "integer",
          "minimum": 0
        },
        "testFailuresIntroduced": {
          "type": "integer",
          "minimum": 0
        },
        "unsafeChanges": {
          "type": "integer",
          "minimum": 0
        },
        "accessibilityIssues": {
          "type": "integer",
          "minimum": 0
        },
        "designIssues": {
          "type": "integer",
          "minimum": 0
        },
        "topFriction": {
          "type": "string"
        },
        "suggestedImprovement": {
          "type": "string"
        },
        "reviewTargetTaskId": {
          "type": "string",
          "description": "Audited task id; attributes feedback to its implementer."
        },
        "reviewTargetAgentId": {
          "type": "string"
        },
        "issueJson": {
          "type": "array"
        },
        "findingJson": {
          "type": "array"
        }
      }
    }
  },
  {
    "name": "sprintengine.artifact.request_changes",
    "description": "artifact request changes",
    "inputSchema": {
      "type": "object",
      "required": [
        "artifactId",
        "id",
        "feedback"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "artifactId": {
          "type": "string",
          "description": "Sprint Engine artifact id."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "feedback": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.feedback.recommend_actions",
    "description": "feedback recommend actions",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.feedback.summarize",
    "description": "feedback summarize",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.handover",
    "description": "handover",
    "inputSchema": {
      "type": "object",
      "required": [
        "name"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "name": {
          "type": "string",
          "description": "Sprint Engine team name used for the bootstrap."
        },
        "goal": {
          "type": "string"
        },
        "handoverPath": {
          "type": "string",
          "description": "Markdown handoff file to import into the canonical handover.md (or reference in place when reference is true)."
        },
        "handoverText": {
          "type": "string",
          "description": "Inline markdown handoff context to write into the canonical handover.md."
        },
        "sourcePlanKind": {
          "type": "string",
          "enum": [
            "unknown",
            "product_plan",
            "architect_plan",
            "epic"
          ]
        },
        "reference": {
          "type": "boolean",
          "description": "When true, record handoverPath and every sourceBundle item as project-root-relative references instead of copying them into the run store. The originals stay canonical and are read and updated in place. Used for backlog-sourced sprints (e.g. an epic and its child design documents)."
        },
        "sourceBundle": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "kind": {
                "type": "string",
                "enum": [
                  "unknown",
                  "product_plan",
                  "architect_plan",
                  "html_mockup",
                  "design_notes",
                  "plan_overview",
                  "generic_context"
                ]
              },
              "sourcePath": {
                "type": "string"
              }
            },
            "required": [
              "kind",
              "sourcePath"
            ],
            "additionalProperties": true
          }
        },
        "actor": {
          "type": "string"
        },
        "force": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.health",
    "description": "health",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.help",
    "description": "help",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "agentId": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "topic": {
          "type": "string",
          "enum": [
            "agent_workflow",
            "tools",
            "needs_input",
            "artifacts",
            "phases"
          ],
          "description": "Optional help topic. Defaults to agent_workflow."
        }
      }
    }
  },
  {
    "name": "sprintengine.init",
    "description": "init",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "goal": {
          "type": "string"
        },
        "useWorktrees": {
          "type": "boolean"
        },
        "agent": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.join",
    "description": "join",
    "inputSchema": {
      "type": "object",
      "required": [
        "role",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "watch": {
          "type": "boolean",
          "description": "Compatibility flag for CLI join --watch polling."
        },
        "maxWaitSeconds": {
          "type": "number",
          "description": "Compatibility timeout for CLI join --watch diagnostics."
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.add_dependency",
    "description": "plan add dependency",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "dependsOn"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "dependsOn": {
          "type": "array"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.add_task",
    "description": "plan add task",
    "inputSchema": {
      "type": "object",
      "required": [
        "title",
        "role"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "role": {
          "type": "string"
        },
        "repo": {
          "type": "string",
          "description": "Id of the project this task works in, from the ones the run declares. Omit for the run's main project. Owned paths stay relative to that project's root."
        },
        "dependsOn": {
          "type": "array"
        },
        "path": {
          "type": "array"
        },
        "acceptance": {
          "type": "array"
        },
        "note": {
          "type": "array"
        },
        "taskNote": {
          "type": "array"
        },
        "producesImplementation": {
          "type": "boolean"
        },
        "kind": {
          "type": "string",
          "enum": [
            "work",
            "integration_review"
          ],
          "description": "Charter marker: integration_review = the terminal task proving the pieces work together; runs like any other task."
        },
        "needsTriage": {
          "type": "boolean"
        },
        "phases": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "review"
            ]
          },
          "description": "Ordered post-implementation phases for this task. Omit to inherit the run default; [] for none. Must be a subset of the run's defaultPhases."
        },
        "productFacing": {
          "type": "boolean"
        },
        "notProductFacing": {
          "type": "boolean"
        },
        "difficultyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "difficultyReason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.address_reviews",
    "description": "plan address reviews",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.delete_task",
    "description": "plan delete task",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "unlinkDependents": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.list",
    "description": "plan list",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.read",
    "description": "plan read",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.remove_dependency",
    "description": "plan remove dependency",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "dependsOn"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "dependsOn": {
          "type": "array"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.review_status",
    "description": "plan review status",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.start_review",
    "description": "plan start review",
    "inputSchema": {
      "type": "object",
      "required": [
        "role",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string"
        },
        "id": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.plan.update_task",
    "description": "plan update task",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "actor": {
          "type": "string"
        },
        "taskId": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "description": {
          "type": "string"
        },
        "role": {
          "type": "string"
        },
        "repo": {
          "type": "string",
          "description": "Id of the project this task works in, from the ones the run declares. Omit for the run's main project. Owned paths stay relative to that project's root."
        },
        "path": {
          "type": "array"
        },
        "acceptance": {
          "type": "array"
        },
        "note": {
          "type": "array"
        },
        "taskNote": {
          "type": "array"
        },
        "clearTaskNotes": {
          "type": "boolean"
        },
        "producesImplementation": {
          "type": "boolean"
        },
        "kind": {
          "type": "string",
          "enum": [
            "work",
            "integration_review"
          ],
          "description": "Set or clear the charter marker; work clears it."
        },
        "needsTriage": {
          "type": "boolean"
        },
        "clearNeedsTriage": {
          "type": "boolean"
        },
        "phases": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "review"
            ]
          },
          "description": "Ordered post-implementation phases for this task. Omit to inherit the run default; [] for none. Must be a subset of the run's defaultPhases."
        },
        "productFacing": {
          "type": "boolean"
        },
        "notProductFacing": {
          "type": "boolean"
        },
        "difficultyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "difficultyReason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.recover",
    "description": "recover",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.roles.get",
    "description": "roles get",
    "inputSchema": {
      "type": "object",
      "required": [
        "roleId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        },
        "roleId": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "pluginRegistryRoots": {
          "type": "array",
          "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
          "items": {
            "type": "object",
            "required": [
              "root"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "root": {
                "type": "string"
              }
            }
          }
        },
        "extraDirs": {
          "type": "array",
          "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.roles.list",
    "description": "roles list",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        },
        "includeShadowed": {
          "type": "boolean"
        },
        "pluginRegistryRoots": {
          "type": "array",
          "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
          "items": {
            "type": "object",
            "required": [
              "root"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "root": {
                "type": "string"
              }
            }
          }
        },
        "extraDirs": {
          "type": "array",
          "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.roster.configure",
    "description": "roster configure",
    "inputSchema": {
      "type": "object",
      "required": [
        "roles"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "roles": {
          "type": "array",
          "description": "Roles to enable with a pinned runtime each. Every cli/model must exactly match an entry in the sprint's allowedRuntimes palette.",
          "items": {
            "type": "object",
            "required": [
              "role",
              "cli"
            ],
            "properties": {
              "role": {
                "type": "string",
                "description": "Registry role id to enable."
              },
              "cli": {
                "type": "string",
                "description": "Runtime CLI/plugin id, e.g. claude-code."
              },
              "model": {
                "type": [
                  "string",
                  "null"
                ],
                "description": "Model id, or null for the CLI's default (no --model)."
              }
            }
          }
        },
        "id": {
          "type": "string",
          "description": "Architect actor id recording the configuration."
        }
      }
    }
  },
  {
    "name": "sprintengine.run.get",
    "description": "run get",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.run.policy.get",
    "description": "run policy get",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.run.subscribe",
    "description": "run subscribe",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "lastEventId": {
          "type": "string"
        },
        "transport": {
          "type": "string",
          "enum": [
            "mcp_notifications",
            "poll"
          ]
        }
      }
    }
  },
  {
    "name": "sprintengine.skill.get",
    "description": "skill get",
    "inputSchema": {
      "type": "object",
      "required": [
        "skillId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        },
        "skillId": {
          "type": "string"
        },
        "pluginRegistryRoots": {
          "type": "array",
          "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
          "items": {
            "type": "object",
            "required": [
              "root"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "root": {
                "type": "string"
              }
            }
          }
        },
        "extraDirs": {
          "type": "array",
          "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.skills.list",
    "description": "skills list",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        },
        "includeBody": {
          "type": "boolean"
        },
        "pluginRegistryRoots": {
          "type": "array",
          "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
          "items": {
            "type": "object",
            "required": [
              "root"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "root": {
                "type": "string"
              }
            }
          }
        },
        "extraDirs": {
          "type": "array",
          "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.soul.get",
    "description": "soul get",
    "inputSchema": {
      "type": "object",
      "required": [
        "roleId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "workspaceRoot": {
          "type": "string",
          "description": "Project root for registry, role, Soul, and run discovery. Must resolve under an allowed root."
        },
        "roleId": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "runId": {
          "type": "string"
        },
        "pluginRegistryRoots": {
          "type": "array",
          "description": "Loaded plugin registry roots that contain Sprint Engine roles/ and skills/ directories.",
          "items": {
            "type": "object",
            "required": [
              "root"
            ],
            "properties": {
              "id": {
                "type": "string"
              },
              "root": {
                "type": "string"
              }
            }
          }
        },
        "extraDirs": {
          "type": "array",
          "description": "Additional path-only registry roots containing roles/ and skills/ directories.",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.summary",
    "description": "summary",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.task.advance",
    "description": "task advance",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "phase",
        "outcome",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "phase": {
          "type": "string",
          "enum": [
            "review"
          ],
          "description": "The phase you are closing. Must equal the task's current status."
        },
        "outcome": {
          "type": "string",
          "enum": [
            "escalate",
            "pass",
            "pass_with_fixes"
          ],
          "description": "pass = nothing to fix; pass_with_fixes = you found and fixed issues; escalate = a plan/scope/product decision blocks you."
        },
        "summary": {
          "type": "string",
          "description": "Short rationale for agent readers (~280 chars)."
        },
        "needsInputKind": {
          "type": "string",
          "enum": [
            "architect",
            "planner",
            "user"
          ]
        },
        "needsInputReason": {
          "type": "string",
          "enum": [
            "artifact_review",
            "blocked_other",
            "product_decision",
            "task_scope",
            "tooling",
            "verification"
          ]
        },
        "needsInputQuestion": {
          "type": "string",
          "description": "Required with outcome=escalate."
        },
        "needsInputSuggestedResolution": {
          "type": "string"
        },
        "directiveClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "taskClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "acceptanceCriteriaClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "swarmToolEffectivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "promptOptimizationPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "contextFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "hallucinationRiskPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "roleFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "autonomyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "confidencePct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "correctnessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "evidenceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "instructionFollowingPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "codeQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "maintainabilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "testQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "securityQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "performanceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendFunctionalityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendAestheticQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "accessibilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "uxCompetitivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "claimsChecked": {
          "type": "integer",
          "minimum": 0
        },
        "hallucinatedClaims": {
          "type": "integer",
          "minimum": 0
        },
        "factualErrors": {
          "type": "integer",
          "minimum": 0
        },
        "implementationMistakes": {
          "type": "integer",
          "minimum": 0
        },
        "missedRequirements": {
          "type": "integer",
          "minimum": 0
        },
        "regressionCount": {
          "type": "integer",
          "minimum": 0
        },
        "testFailuresIntroduced": {
          "type": "integer",
          "minimum": 0
        },
        "unsafeChanges": {
          "type": "integer",
          "minimum": 0
        },
        "accessibilityIssues": {
          "type": "integer",
          "minimum": 0
        },
        "designIssues": {
          "type": "integer",
          "minimum": 0
        },
        "topFriction": {
          "type": "string"
        },
        "suggestedImprovement": {
          "type": "string"
        },
        "reviewTargetTaskId": {
          "type": "string",
          "description": "Audited task id; attributes feedback to its implementer."
        },
        "reviewTargetAgentId": {
          "type": "string"
        },
        "issueJson": {
          "type": "array"
        },
        "findingJson": {
          "type": "array"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.claim",
    "description": "task claim",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "id": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.comment",
    "description": "task comment",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "body"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "body": {
          "type": "string"
        },
        "source": {
          "type": "string"
        },
        "commentType": {
          "type": "string"
        },
        "paths": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "data": {
          "type": "object"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.comment.list",
    "description": "task comment list",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "description": "Maximum comments returned, newest last. Defaults to 20."
        }
      }
    }
  },
  {
    "name": "sprintengine.task.get",
    "description": "task get",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "include": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "activity",
              "comments",
              "evidence_log",
              "diffs"
            ]
          },
          "description": "Deep-read sections to add to the slim task card."
        }
      }
    }
  },
  {
    "name": "sprintengine.task.list",
    "description": "task list",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string",
          "description": "Canonical Sprint Engine role id, after registry alias resolution."
        },
        "status": {
          "type": "string"
        },
        "includeDone": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.log",
    "description": "task log",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "file": {
          "type": "array"
        },
        "command": {
          "type": "array"
        },
        "result": {
          "type": "array"
        },
        "scopeExpansionJson": {
          "type": "array"
        },
        "reviewTargetTaskId": {
          "type": "string",
          "description": "Audited task id; attributes feedback to its implementer."
        },
        "findingJson": {
          "type": "array"
        },
        "claimsChecked": {
          "type": "integer",
          "minimum": 0
        },
        "hallucinatedClaims": {
          "type": "integer",
          "minimum": 0
        },
        "factualErrors": {
          "type": "integer",
          "minimum": 0
        },
        "implementationMistakes": {
          "type": "integer",
          "minimum": 0
        },
        "missedRequirements": {
          "type": "integer",
          "minimum": 0
        },
        "regressionCount": {
          "type": "integer",
          "minimum": 0
        },
        "testFailuresIntroduced": {
          "type": "integer",
          "minimum": 0
        },
        "unsafeChanges": {
          "type": "integer",
          "minimum": 0
        },
        "accessibilityIssues": {
          "type": "integer",
          "minimum": 0
        },
        "designIssues": {
          "type": "integer",
          "minimum": 0
        }
      }
    }
  },
  {
    "name": "sprintengine.task.next",
    "description": "task next",
    "inputSchema": {
      "type": "object",
      "required": [
        "role",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "role": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "repo": {
          "type": "string",
          "description": "Declared repo to claim work from. Server-owned: bound from the session's own worktree, so agents omit it."
        }
      }
    }
  },
  {
    "name": "sprintengine.task.note",
    "description": "task note",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "note"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "note": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.publish",
    "description": "task publish",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "summary"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "summary": {
          "type": "string"
        },
        "path": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "file": {
          "type": "array",
          "items": {
            "type": "string"
          }
        },
        "data": {
          "type": "object"
        },
        "summaryDataJson": {
          "type": "string"
        },
        "noChangesOk": {
          "type": "boolean",
          "description": "Explicitly complete a task that produced NO committed changes (analysis/verification-only deliverable). Without it a no-changes publish is rejected."
        },
        "actualDifficultyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "actualDifficultyReason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.release",
    "description": "task release",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "reason"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.resolve_input",
    "description": "task resolve input",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id",
        "resolution"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "id": {
          "type": "string"
        },
        "resolution": {
          "type": "string"
        },
        "complete": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.task.status",
    "description": "task status",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "status",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string"
        },
        "status": {
          "type": "string",
          "enum": [
            "canceled",
            "done",
            "in_progress",
            "needs_input",
            "review",
            "todo"
          ]
        },
        "id": {
          "type": "string"
        },
        "summary": {
          "type": "string"
        },
        "needsInputKind": {
          "type": "string",
          "enum": [
            "architect",
            "planner",
            "user"
          ]
        },
        "needsInputReason": {
          "type": "string"
        },
        "needsInputArtifactId": {
          "type": "string"
        },
        "needsInputQuestion": {
          "type": "string"
        },
        "needsInputSuggestedResolution": {
          "type": "string"
        },
        "directiveClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "taskClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "acceptanceCriteriaClarityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "swarmToolEffectivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "promptOptimizationPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "contextFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "hallucinationRiskPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "roleFitPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "autonomyPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "confidencePct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "correctnessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "evidenceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "instructionFollowingPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "codeQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "maintainabilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "testQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "securityQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "performanceQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendFunctionalityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "frontendAestheticQualityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "accessibilityPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "uxCompetitivenessPct": {
          "type": "integer",
          "minimum": 0,
          "maximum": 100
        },
        "claimsChecked": {
          "type": "integer",
          "minimum": 0
        },
        "hallucinatedClaims": {
          "type": "integer",
          "minimum": 0
        },
        "factualErrors": {
          "type": "integer",
          "minimum": 0
        },
        "implementationMistakes": {
          "type": "integer",
          "minimum": 0
        },
        "missedRequirements": {
          "type": "integer",
          "minimum": 0
        },
        "regressionCount": {
          "type": "integer",
          "minimum": 0
        },
        "testFailuresIntroduced": {
          "type": "integer",
          "minimum": 0
        },
        "unsafeChanges": {
          "type": "integer",
          "minimum": 0
        },
        "accessibilityIssues": {
          "type": "integer",
          "minimum": 0
        },
        "designIssues": {
          "type": "integer",
          "minimum": 0
        },
        "topFriction": {
          "type": "string"
        },
        "suggestedImprovement": {
          "type": "string"
        },
        "reviewTargetTaskId": {
          "type": "string",
          "description": "Audited task id; attributes feedback to its implementer."
        },
        "reviewTargetAgentId": {
          "type": "string"
        },
        "issueJson": {
          "type": "array"
        },
        "findingJson": {
          "type": "array"
        }
      }
    }
  },
  {
    "name": "sprintengine.triage.needs_input",
    "description": "triage needs input",
    "inputSchema": {
      "type": "object",
      "required": [
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        }
      }
    }
  },
  {
    "name": "sprintengine.vcs.commit",
    "description": "vcs commit",
    "inputSchema": {
      "type": "object",
      "required": [
        "taskId",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "taskId": {
          "type": "string",
          "description": "Sprint Engine task id, for example T3."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "summary": {
          "type": "string"
        },
        "path": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    }
  },
  {
    "name": "sprintengine.vcs.pr",
    "description": "vcs pr",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "base": {
          "type": "string"
        },
        "title": {
          "type": "string"
        },
        "body": {
          "type": "string"
        },
        "draft": {
          "type": "boolean"
        },
        "noPush": {
          "type": "boolean"
        }
      }
    }
  },
  {
    "name": "sprintengine.vcs.request_repo",
    "description": "vcs request repo",
    "inputSchema": {
      "type": "object",
      "required": [
        "root",
        "id"
      ],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        },
        "root": {
          "type": "string",
          "description": "Path to the sibling git project to bring into this sprint."
        },
        "id": {
          "type": "string",
          "description": "Stable Sprint Engine agent id, for example developer-1."
        },
        "repoId": {
          "type": "string",
          "description": "Preferred short project id; defaults to the folder name."
        }
      }
    }
  },
  {
    "name": "sprintengine.vcs.status",
    "description": "vcs status",
    "inputSchema": {
      "type": "object",
      "required": [],
      "additionalProperties": true,
      "properties": {
        "statePath": {
          "type": "string",
          "description": "Run state path; server-resolved, agents normally omit it."
        }
      }
    }
  }
] as const

export const SPRINTENGINE_MUTATING_TOOL_NAMES = [
  'sprintengine.agent.heartbeat',
  'sprintengine.agent.join',
  'sprintengine.agent.leave',
  'sprintengine.agent.next_directive',
  'sprintengine.artifact.add',
  'sprintengine.artifact.approve',
  'sprintengine.artifact.ready',
  'sprintengine.artifact.request_changes',
  'sprintengine.handover',
  'sprintengine.init',
  'sprintengine.join',
  'sprintengine.plan.add_dependency',
  'sprintengine.plan.add_task',
  'sprintengine.plan.address_reviews',
  'sprintengine.plan.delete_task',
  'sprintengine.plan.remove_dependency',
  'sprintengine.plan.start_review',
  'sprintengine.plan.update_task',
  'sprintengine.recover',
  'sprintengine.roster.configure',
  'sprintengine.task.advance',
  'sprintengine.task.claim',
  'sprintengine.task.comment',
  'sprintengine.task.log',
  'sprintengine.task.next',
  'sprintengine.task.note',
  'sprintengine.task.publish',
  'sprintengine.task.release',
  'sprintengine.task.resolve_input',
  'sprintengine.task.status',
  'sprintengine.triage.needs_input',
  'sprintengine.vcs.commit',
  'sprintengine.vcs.pr',
  'sprintengine.vcs.request_repo',
] as const

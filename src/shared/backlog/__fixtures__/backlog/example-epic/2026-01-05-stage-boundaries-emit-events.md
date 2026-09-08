---
type: feature
status: ready
difficulty: m
criticality: high
risk: normal
epic: example-epic
dependsOn: 2026-01-06-name-the-stages-once
id: 1002
updated: 2026-01-06T11:30:00.000Z
sprints: 2026-01-06-widget-pipeline-observability
mockups: 2026-01-05-stage-timeline
pr: 412
---

# Each stage boundary emits an event

Every stage entry and exit writes one event carrying the stage name, the widget
id, and a monotonic timestamp. Nothing else: the point is a spine a reader can
follow, not a second log.

## Acceptance

- Entering and leaving a stage each produce exactly one event.
- The events are ordered by the same clock, so a duration is a subtraction.
- A stage that throws still emits its exit event, with the failure named.

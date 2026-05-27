---
name: skill-optimization-review
description: "Evaluate and improve Hermes skills with a SkillOpt-inspired rollout, reflection, and validation gate."
version: 1.0.0
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [skills, evaluation, optimization, reuse]
    category: maintenance
    requires_toolsets: [file, git]
    source_inspiration:
      name: microsoft/SkillOpt
      url: https://github.com/microsoft/SkillOpt
      license: MIT
---

# Skill Optimization Review Skill

## Purpose

Improve an existing Hermes skill only when task evidence shows a measurable benefit.

This adapts the SkillOpt pattern of rollout, reflection, patch selection, and validation gating without vendoring the SkillOpt framework into this public-safe repository.

## When to use

- A skill repeatedly fails similar tasks.
- A new skill needs acceptance testing before publication.
- Recent work suggests an existing skill can be simplified or made safer.
- A user asks to optimize, train, evaluate, or tune a Hermes skill.

## Inputs

- Target `SKILL.md` path.
- Sanitized task cases with expected outcomes.
- Optional failure notes or prior run summaries.
- Validation threshold or acceptance criteria.

## Procedure

1. Confirm the target skill exists and read its current procedure, inputs, outputs, and safety section.
2. Prepare a small sanitized eval set split into train, validation, and holdout cases.
3. Run or simulate the current skill on the train cases and record only sanitized outcomes.
4. Use parallel spark subagents for read-only failure analysis, reuse checks, and regression-risk review.
5. Convert repeated failures into minimal candidate edits.
6. Reject edits that add unclear dependencies, expose private runtime data, weaken safety gates, or copy external code.
7. Apply only the smallest candidate patch that improves validation outcomes or fixes a clear safety defect.
8. Run holdout cases after acceptance and record remaining risks.
9. Keep raw trajectories, private prompts, credentials, logs, and model traces outside the public repository.

## Outputs

- Minimal skill patch or a discard decision.
- Sanitized evaluation summary with before/after results.
- Source note when external work influenced the procedure.
- Validation result and remaining risks.

## Safety

Do not publish raw task trajectories, private memory, live runtime state, credentials, logs, or user-identifying examples. Do not vendor SkillOpt or any benchmark data unless the dependency, license, dataset rights, and secret handling have been explicitly approved.

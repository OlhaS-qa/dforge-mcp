# Authoring dForge modules with AI — goals and principles

This document says what `dforge-mcp` and its skills are for, and the rules we hold ourselves to when changing them. [How the authoring flow works](authoring-flow.md) describes the mechanics.

## Goal

Building a dForge module with an AI agent should be a **reproducible process**, not a conversation that happens to end in a module.

- Running the same task twice should give the same module, up to naming.
- Where a decision is genuinely open, a **person** chooses it, from a short, known list of options, and the choice is written down. The model does not settle it by chance.
- The finished module does what the user asked for. That means three things, and the flow checks all three:
  1. **Data and behaviour**: entities, statuses, actions, rules.
  2. **Access**: every kind of user reaches what they need and cannot see or change what they must not.
  3. **Outputs**: the documents, reports, exports and mails the business expects actually come out, with the right data on them.

A module that installs cleanly but cannot print the hire order, or lets the accountant edit HR records, is a failed module even if every file is schema-valid.

## Principles

1. **An error costs more the later it is found.**
   Checks move to the left. Every stage has a check on the previous stage's artifact, and the next stage does not start on an unchecked one. A missing role is cheap to fix in the design document, expensive after install.

2. **Code decides whatever code can decide.**
   Anything that can be generated, normalised or verified by a script is not left to the model: schema conformance, naming, cross-references, the comparison of the security files with the approved design, the existence of every promised output. The model writes content; the tools refuse bad shapes.

3. **Open questions are closed with options and recorded.**
   Intake follows a fixed list of questions, not the agent's feel for what matters. An answer goes into the requirements and is not reopened later. A gap found during design is written as *Gap / Proposal* and resolved before the next stage.

4. **The specification is complete before building starts.**
   Building works from approved documents. If the build has to improvise, the specification had a hole, and the fix goes into the specification, not into a private decision in the middle of Phase 3.

5. **Say what the system produces, not only what it stores.**
   Outputs (printed forms, statutory and management reports, exports, mails) are requirements with their own ids, owners, samples and tests. A sample document is the only trustworthy source of the fields it contains; we ask for one instead of recalling the legal form from memory.

6. **Trust the platform's behaviour, not our guess about it.**
   Every check that encodes a platform fact (for example "triggers do not check Execute", "`printPdf()` does not work in a scheduled job", "export writes the visible non-identity columns") is based on a statement from the core team or on the core source, and says so where it matters. When we are wrong, the check is removed, not softened. When we do not know, we ask, and until we know the check does not exist.

7. **Reports must be honest.**
   A "0 warnings" claim is meaningless unless it comes from an independent check. Run reports must include the output of a second validator that lives outside the tool under test (a plain script that checks every module JSON against the vendored schemas), quoted verbatim. A skipped check is reported as skipped, never as passed.

8. **The user stays in charge of meaning; the tools stay in charge of shape.**
   People confirm what the module is for, who uses it and what it must produce. They are never asked to confirm anything a tool can verify.

9. **Tools refuse; they do not repair silently.**
   A patch tool that would write a file violating the vendored schema writes nothing and explains the new violations. Hand-edited JSON is the exception, which is why `dforge_module_validate` re-runs the same schema pass and the skills say when it must be run.

## What this is not

- It is not a guarantee that the module installs. The platform validates at install; `dforge_module_validate` is a pre-flight that catches the classes of error that are statically decidable.
- It is not a rendering or runtime test. We cannot render a print form, run a report as a given role, or send a mail. The test runner supports the signed-in user only and has no print or report steps, so output checks that need rendering stay manual and are marked as such in the design.
- It is not a replacement for judgement about legal forms. For statutory documents the user supplies the form; the tools check that every datum on it exists as a field and reaches the template.

## How we know it works

We do not measure by feel. We run complete scenarios through the real tools with a delegated "user", then compare runs:

- **First-pass validation result** (errors and warnings by family) and the final result.
- **Iterations**: how many times a stage had to be re-run, and why.
- **Calls and time per phase**.
- **Truth of each finding**: every message from a new check is classified as true, false or unclear. False positives are bugs in the checks and are fixed before they are kept.
- **Defects caught and missed**: compare the built artefacts with the samples field by field.

A change that makes the process longer must show what it caught that would otherwise have shipped.

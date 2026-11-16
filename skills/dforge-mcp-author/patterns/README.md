# Solution patterns

Proven shapes for needs that come up in many modules. A pattern is **not a
module to copy**: it is a set of design rows and file shapes you propose to the
user in 0c/Phase 1-5 (as a Gap/Proposal), then adapt to their domain names.
Load one by URI, only when its trigger matches what the user said.

| Pattern | Use when the user says | URI |
|---|---|---|
| Posted document with a print form | "order", "act", "invoice", "post", "print it", a document that changes other records and is then fixed | `dforge://pattern/posted-document-print` |
| Approval by amount | "up to X no approval, above Y the director" | `dforge://pattern/approval-by-amount` |
| Own-card role | "employee sees only their own records" | `dforge://pattern/own-card-role` |
| Approval status machine | "submit", "approve", "reject", status only changed by actions | `dforge://pattern/status-machine-document` |
| Multi-step approval | "first the manager, then the director", "a reject goes back to the author" | `dforge://pattern/multi-step-approval` |
| Escalation by time | "if nobody approves in N days", "remind", "overdue goes to the head" | `dforge://pattern/escalation-by-time` |
| Excel register / export | "export to Excel", "register", "report for the accountant", "upload to another system" | `dforge://pattern/excel-export` |

Rules for every pattern:

- Every datum on the user's sample must be a field (Outputs check).
- Rows below go into DESIGN.md as written, with the module's own names; the
  `perm:` and `out:` checks then trace them into the built module.
- A pattern says what it was verified against. Anything marked **unverified**
  is a question for the platform owners, not a promise to the user.

Testing note, for every pattern: the test runner acts only as `admin` and has no
print, report or export steps (planned, not built). Role access and outputs are
checked statically (`validate`) and by a `manual:` step; never promise a scenario
that "acts as the employee".

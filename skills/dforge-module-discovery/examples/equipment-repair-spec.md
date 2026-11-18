# Equipment repair requests — specification (example)

Example output of the discovery flow on an invented customer (a small factory).
Origin of facts: customer, proposal accepted, default, open. Statement ids
are shortened; a real spec numbers every statement. The designer's notes for this
case are in `equipment-repair-design-notes.md`.

## Summary
A system in which workers raise repair requests, mechanics take them into work and section heads close them. It keeps the equipment list and spare parts, calculates downtime and cost, tells people about overdue requests, prints the request and the act of work done, and offers three reports. About 50–200 pieces of equipment, up to 30 requests a month, up to 5 people in the repair service.

## 1. Task and organisation
A system for repair requests for the equipment of a small factory.
- Now: a paper log; requests get lost and it is unclear who does what (customer).
- Scale: 50–200 pieces of equipment, up to 30 requests a month, up to 5 people in the repair service (customer).
- Goals: requests do not get lost; it is clear who is responsible; downtime is visible; there is a repair history per machine (customer).

## 2. Starting point
A typical system for tracking equipment maintenance, adapted to the customer's form and rules (proposal accepted).

## 3. Platform decisions
- The people who use the system are its users; nobody is kept in a separate directory (default).
- The supplier of a spare part is a text field (default).
- Spare part stock is kept in this system; there is no other warehouse (customer).

## 4. Users
- U-1 Workers of a shop raise repair requests and see their own until a mechanic takes them into work; they see the equipment list (customer; proposal accepted).
- U-2 Mechanics take requests into work, see all requests of the plant, add work done and parts used, set the deadline, note the work permit number and whether parts are needed (customer).
- U-3 Section heads close requests, see the requests of their section and the reports, and can send a finished request back with a reason (customer; proposal accepted).
- The chief mechanic signs on paper only; no role in the system (customer).

## Access Needs
- Users (U-1) need: raise a request, see own requests, see the equipment list / must not: see or change other people's requests.
- Users (U-2) need: see all requests, work on requests taken into work, use parts / must not: close a request.
- Users (U-3) need: see the requests of their section, close, send back, see reports / must not: change work already recorded by a mechanic.

## 5. Entities
Equipment (name, inventory number, section, criticality, condition); Section (directory, names its head); Request; Work on a request; Part (name, number, stock, minimum stock, price); Part used on a request; Receipt of parts; Preventive schedule.

## 6. Lifecycles
Request: New → In work ⇄ Waiting for parts → Done → Closed; Cancelled. Urgency: emergency / urgent / planned (from the user's form).

## 7. Rules and constraints
- R-1 Only a section head closes a request, and only a Done one (proposal accepted).
- R-2 A request cannot be taken into work without equipment (proposal accepted).
- R-3 A worker may cancel their own New request; a reason is required (proposal accepted).
- R-4 Requests are never deleted, only cancelled (proposal accepted).
- R-5 A section head can send a Done request back to In work with a reason (customer).

## 8. Calculated values
- S-1 Request number like RM-2026-0001 (proposal accepted).
- S-2 Downtime in hours from raising to Done, only when the request says the equipment is stopped (customer).
- S-3 Overdue: emergency or urgent request not closed within 24 hours; also past its deadline (customer).
- S-4 Repair cost: parts (quantity × price) plus hours of work × an hourly rate (customer; the rate is set by the section head).
- S-5 Stock of a part decreases when a mechanic records its use (proposal accepted).

## 9. Documents and files
## Outputs
- O-1 Printed repair request, by the form the customer supplied; signatures on paper (customer).
- O-2 Act of work done: work, parts used, hours, signatures of the mechanic and the section head (customer).
- O-3 List of requests in Excel by month or equipment (customer).
- O-4 Report "Downtime of equipment" (see section 11).
- O-5 Report "Repair history of a machine" (see section 11).
- O-6 Report "Requests by status and overdue" (see section 11).

## 10. Notifications (in the system unless stated)
- N-1 New request → mechanics.
- N-2 Taken into work → the person who raised it.
- N-3 Waiting for parts → section head.
- N-4 Done → section head.
- N-5 Sent back → mechanic, with the reason.
- N-6 Emergency or urgent request not closed in 24 hours → section head, in the system **and by e-mail**.
- Low stock: not needed (customer).

## 11. Reports
- O-4 Downtime of equipment: for the section head, to decide which equipment to repair thoroughly or replace; default period: last month (proposal accepted).
- O-5 Repair history of a machine: for section heads and mechanics, to see what breaks most often; one chosen machine, all time (proposal accepted).
- O-6 Requests by status and overdue: for section heads and mechanics, to decide whom to send where today; current (proposal accepted).
Each report is also an output above.

## 12. Scheduled checks and settings
- Overdue requests are checked every hour; each notice is sent once (proposal accepted).
- The hourly rate for work is a setting changed by the section head; until it is set the cost counts parts only (default).

## 13. Initial data
Sections and equipment from the customer's tables; parts and people entered by hand.

## 14. Out of scope
Nothing was removed or declined during the interview.

## 15. Scenarios
1. Ordinary repair: a worker raises a request, a mechanic takes it into work and records work and parts, completes it, a section head closes it. Expected: closed, downtime calculated, stock reduced, notices received. Checks R-1, S-1, S-2, S-5, N-1, N-4.
2. Waiting for parts and back: the mechanic marks parts needed, the request waits, the head is told, work resumes and completes. Checks N-3.
3. Sent back: the head returns a done request with a reason; the mechanic reworks and completes it again. Checks R-5, N-5.
4. Refusals: a mechanic cannot close a request; a request without equipment cannot be taken into work; a worker cannot cancel without a reason; nobody can delete a request. Checks R-1, R-2, R-3, R-4.

## 16. Where each goal is covered
- Requests do not get lost: sections 5, 6, 10; N-1, N-4.
- It is clear who is responsible: sections 4, 6; R-1, R-2.
- Downtime is visible: S-2, O-4.
- Repair history per machine: O-5.

## 17. Decisions to confirm
| Question | Our proposal | Status |
|---|---|---|
| Value of the hourly rate | set by the section head after launch | open: the customer names the rate |
| Position of the person raising a request | taken from the user's profile | assumption |

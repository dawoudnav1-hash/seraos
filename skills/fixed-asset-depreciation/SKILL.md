---
id: fixed-asset-depreciation
version: 1.0.0
name: Fixed-asset depreciation
description: Computes the period's straight-line depreciation from the fixed-asset register, rolls cost and accumulated depreciation forward by class, and drafts depreciation, capitalization and disposal entries for review.
category: schedules
model: none
triggers:
  - depreciation
  - fixed asset
  - fixed-asset roll-forward
  - capitalize
  - asset disposal
negative_triggers:
  - tax depreciation
  - MACRS
  - section 179
  - lease
  - impairment
  - intangible amortization
inputs:
  period: Close period as YYYY-MM
  register: Fixed-asset register rows with id, class, placed_in_service, cost_cents, salvage_cents, life_months and any disposal (date, proceeds_cents)
  expense_lines: GL expense lines booked in the period, tested against the capitalization policy
  gl_balances: Prior-period closing cost and accumulated depreciation by class, from the GL
  policy: Capitalization threshold in cents, minimum useful life in months, account map by class, materiality in cents
outputs:
  schedule: Per asset, opening accumulated depreciation, period charge, closing accumulated depreciation and net book value
  rollforward: By class, cost (opening + additions - disposals = closing) and accumulated depreciation (opening + charge - disposals = closing)
  draft_entries: Proposed journal entries (depreciation, capitalization reclass, disposal) with a source on every line
success_criteria:
  - Schedule closing accumulated depreciation ties to the register to the cent
  - Roll-forward opening balances tie to the prior-period GL by class
  - Roll-forward closing balances tie to the schedule by class
  - Every draft entry balances and every line cites a register row or GL line
  - No asset is depreciated below its salvage value
failure_conditions:
  - Register cost or accumulated depreciation does not tie to the GL by class
  - An asset lacks cost, in-service date or useful life
  - A disposal lacks a date or proceeds
  - The period is closed
confidence_threshold: 0.7
human_review_threshold:
  confidence_below: 0.9
  when_material: true
tools:
  - fetchSubledger
  - fetchTrialBalance
  - buildWorkbook
---

# Fixed-asset depreciation

## Purpose

Close the fixed-asset area for one period. Produce a per-asset depreciation
schedule, a roll-forward by asset class, and draft entries a reviewer can
approve: the period's depreciation, reclasses for purchases that were expensed
but meet the capitalization policy, and disposals. Every figure is computed from
the register and the GL; nothing is typed in. The skill proposes. It never posts.

## Procedure

1. Confirm the period is open. Load the client's policy from semantic memory:
   capitalization threshold, minimum useful life, account map by class, materiality.
   If the threshold or account map is missing, ask; do not assume a default.
2. Fetch the register (`fetchSubledger`) and the prior-period trial balance
   (`fetchTrialBalance`). These are reads and run in parallel.
3. Tie the register to the GL before computing anything: by class, register cost
   and accumulated depreciation through the prior period must equal the GL
   closing balances to the cent.
4. Test each period expense line against the capitalization policy. A line
   qualifies when its amount is at or above the threshold and its useful life
   exceeds the minimum. Qualifying lines become additions, placed in service on
   the receipt date unless the evidence shows a later in-service date.
5. For every asset, compute depreciation straight-line over cost less salvage:
   months elapsed count from the month after the in-service month through the
   period end, capped at the useful life. Cumulative depreciation is
   `round((cost - salvage) * months / life)`; the period charge is cumulative
   through this period less cumulative through the prior period.
6. For each disposal in the period, take accumulated depreciation through the
   prior month, net book value as cost less that, and gain or loss as proceeds
   less net book value.
7. Build the roll-forward by class for cost and accumulated depreciation.
8. Draft the entries, one line per class or asset, each citing its register row
   or GL line: depreciation (Dr expense, Cr accumulated depreciation),
   capitalization reclass (Dr asset cost, Cr the expense account it was booked
   to), disposal (Dr cash or receivable for proceeds, Dr accumulated
   depreciation, Cr asset cost, Dr loss or Cr gain).
9. Verify: schedule ties to the register, roll-forward ties to the GL and the
   schedule, every entry balances, every line has a source.
10. Build the workbook (`buildWorkbook`) with the schedule, roll-forward and
    entries, and attach it to each draft entry.

## Decision rules

- Straight-line only, over cost less salvage. Salvage defaults to zero only when
  the register says zero; a blank salvage is missing data.
- Depreciation starts the month after the asset is placed in service. An asset
  placed in service in the period is an addition with no charge this period.
- No depreciation in the month of disposal. Accumulated depreciation for the
  disposal is through the prior month.
- Stop at cost less salvage. A fully depreciated asset stays on the register at
  cost with equal accumulated depreciation until it is disposed of.
- Round once, at the cumulative total, so the schedule never drifts from the
  register and the final month lands exactly on the depreciable base.
- Apply the capitalization threshold per unit unless the policy says per
  invoice. If the policy is silent and an invoice holds several units, ask.
- A change in useful life or salvage is a change in estimate: apply it
  prospectively over the remaining life, and only with reviewer approval.
- Material: the period's total entries exceed the client's materiality, or any
  single reclass or disposal does. Material results always go to human review,
  as do results below 0.9 confidence.

## Guardrails

- Propose only. Never post an entry, change the register, or alter a useful
  life, salvage value or in-service date.
- All amounts are integer cents. Every draft line cites a source record.
- Never capitalize a line below the threshold, and never plug a difference to
  make the register tie.
- Never propose into a closed period.
- Out of scope: tax depreciation (MACRS, bonus, section 179), leases, impairment
  and intangible amortization. Route those to their own skills.

## Error handling

- Register does not tie to the GL: stop, report the difference by class with the
  register and GL figures side by side, and escalate. Do not compute a schedule
  on an untied register.
- Missing cost, in-service date or useful life: ask for the document or value
  (clarification), naming the asset.
- Disposal without proceeds: ask. Treat proceeds as zero only when the reviewer
  confirms the asset was scrapped.
- A verification check fails: re-run with the failed checks as feedback, up to
  the graph's attempt limit, then escalate with the failed checks listed.
- An entry that does not balance is a defect, not a judgment call: fail the run.

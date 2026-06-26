# RFCs — explorations and the paths we discarded

An **RFC** here records a *substantial exploration* — something we investigated, possibly
prototyped, and then **decided for or against**. Unlike an [ADR](../adr/) (which states a
decision we keep) an RFC's value is often the **discarded** outcome: the receipts for a wall
we already walked into, so the team doesn't re-walk it.

**When to write an RFC vs an ADR vs a constraint:**

- Use an **ADR** when you are recording a decision you will *maintain* (the sharing pattern,
  the CAP service). Its "Rejected alternatives" section covers the *obvious one-line*
  alternatives to that decision.
- Use an **RFC** when an alternative was a *mini-project of its own* — too big to be a bullet
  in an ADR. The public-endpoint bridge spanned three real options (one was actually built);
  that earns its own doc with a `Discarded` status.
- Use a **[constraint](../constraints.md)** for the durable platform fact that *made* the
  options dead. Constraints don't get superseded; they just stay true.

An RFC's `Status` may be `Draft`, `Accepted` (graduates into an ADR or implementation), or
`Discarded`. A discarded RFC is **not deleted** — it is the record.

| # | Title | Status |
|---|-------|--------|
| [0001](0001-public-anonymous-endpoint.md) | Anonymous public endpoint in front of CPI (APIM / FastAPI / Lambda) | Discarded — obsoleted by [ADR 0005](../adr/0005-shared-delivery-ingest-service.md) |

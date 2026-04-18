# UI: Email Data Intake

Section 8.12 of the [product spec](../index.md) — a modal flow that extracts customer + project data from pasted email text via an LLM. Entry point is a header button (not a management tab); the output is a customer + project record pair.

See [ADR-0015](../../adr/0015-copy-paste-textarea-email-data-intake.md) for the copy/paste rationale and [ADR-0016](../../adr/0016-llm-email-extraction-via-server-proxied-openrouter.md) for the server-side proxy design.

---

## 8.12 Email Data Intake

Entry point: a button in the header, visible only to users with `customer:write` permission.

**Workflow:**

1. **Paste** — the user pastes raw email text into a textarea. The extract action is disabled while the textarea is empty or an extraction is in flight.
2. **Extract** — submitting triggers a call to the extraction API (see [api.md §14.2.6](../api.md#1426-data-extraction)). While the request is in flight, the UI shows a loading indicator and the extract action is disabled.
3. **Review** — on success, the modal presents editable form fields populated from the extraction result: customer name, phone, email, street, zip, city, and project title. Fields that the LLM could not infer are shown empty. The user corrects or completes them before saving.
4. **Match existing customer** — the customer section includes a name search that queries existing customers. The user may select an existing record to avoid creating a duplicate; in that case, only the project is created on save.
5. **Save** — the client creates the customer first (if no existing match was selected), then creates the project referencing that customer's ID. On customer failure, no project is created. Project failure after a new customer was just created does not roll back the customer.
6. **Error feedback** — extraction failure (configuration missing, upstream error, unparseable response) shows a German error message from the API error category. The user may retry or abandon the flow.

Permission: `customer:write`. Users without this permission cannot see the entry point and cannot invoke the operation (server-side authorization is authoritative).

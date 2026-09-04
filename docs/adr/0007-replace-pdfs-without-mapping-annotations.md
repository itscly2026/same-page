# Replace PDFs without mapping annotations

Administrators may explicitly replace a score's PDF after accepting that existing annotations will continue at their original page numbers and normalized coordinates. Each replacement creates a new immutable PDF version and advances the score's current-version pointer; no content comparison, annotation mapping, or offline-edit rejection is performed. The prior PDF remains available for rollback for thirty days, counts against the choir's one-GB quota, and is then deleted, while annotations beyond a shorter replacement's page count remain stored but invisible.


Replacement uploads first become administrator-only candidates, counted against quota and retained for at most 24 hours before expiry. Confirmation publishes a candidate only if the score has not been published or rolled back since preview began. Cancelling removes the candidate; failed or abandoned requests are reclaimed by the retryable storage cleanup queue.

Rollback selects an existing immutable version within its retention window, preserves its original upload number, and starts a new thirty-day window for the version it displaces. Upload numbers never repeat, including after cancellation; gaps are allowed. A separate publication revision detects intervening changes even when rollback returns to the same PDF. Publication and retention changes are atomic; cleanup rechecks current references and expiry when deleting.

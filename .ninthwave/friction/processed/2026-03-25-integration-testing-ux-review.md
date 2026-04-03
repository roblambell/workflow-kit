# Add integration testing coverage and review daemon UX

**Observed:** Need to add integration testing for the daemon in all modes, review the outputs, and consider how to make the UX best-in-class.

**Impact:** Without integration tests, regressions like the remote branch delete warning (M-ORC-7) slip through. Without UX review, the daemon output may not be as clear and useful as it could be.

**Suggestion:**
- Add integration test work items covering: daemon startup/shutdown, worker lifecycle, merge flow, stacking, retry, crash recovery
- Review daemon output in all modes (normal, supervisor, verbose) and identify UX improvements
- Consider adding a real-time TUI dashboard as an alternative to log-line output

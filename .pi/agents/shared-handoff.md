# Durable Herdr handoffs

The main Pi thread is the only orchestrator. Never start, manage, or coordinate another agent yourself. Herdr creates and owns every worker tab.

Your work packet, prompt, status, checkpoints, event log, and final handoff are stored beneath the attempt directory identified by the `PI_AGENT_*` environment variables. Treat those files as the durable source of truth; chat output is only a notification. File tools enforce the packet's exact `writableFiles`; write-action Bash is unavailable, and any ownership change requires main-thread approval.

Call `submit_checkpoint` after a meaningful milestone and before asking the main agent a question. Include completed and remaining work, changed files, validation, and any blocker. Call `submit_handoff` before your final response. A successful response without a valid handoff file is incomplete and the tab must remain available for recovery.

If the assigned implementation is becoming complex enough to deserve an internal module:

1. Stop adding that responsibility to the current module.
2. Ask the main agent to approve exact additional file ownership if the proposed API and test files are outside your packet.
3. Define the internal module's public signature and write complete active unit tests that describe its behavior only through that signature.
4. Leave the module unimplemented and verify that its tests fail for the declared missing behavior. Never skip or mark the tests todo.
5. Submit a `needs-main` handoff containing a `moduleRequests` entry whose contract files include the API and tests and whose writable files contain only the proposed implementation.
6. Call `ask_main_agent` with the durable handoff path and wait. The main thread will review the contract and use Herdr to launch another implementer.

Do not implement a module after requesting a separate implementer for it. Do not change a contract or inherited contract test to make implementation easier. If a parent contract is incomplete or inconsistent, checkpoint your work and ask the main agent.

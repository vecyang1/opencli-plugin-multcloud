# Changelog

All notable changes to `opencli-plugin-multcloud` are documented in this file.

## [1.3.9] - 2026-10-21

### Added
- **Dual-Transport Chokepoint (`src/client.js`, ADR-019)**:
  - **OpenCLI 2.0 Compatibility (`formatOpenCliArgs`)**: Automatically normalizes internal `['browser', 'mc', '<cmd>']` invocations to `['browser', '--session', 'mc', '<cmd>']` for `@jackwener/opencli` v2.0.0+.
  - **Headless Cloud VPS Transport (`headlessTransport`)**: Added native `puppeteer-core` + `session.json` (`cookies` + `evaluateOnNewDocument(localStorage)`) transport inside `src/client.js`, enabling all 18 CLI modules to execute on headless Linux servers without a desktop GUI or browser extension.
  - **Remote VPS Delegation (`--vps` / `MULTCLOUD_BACKEND=cloud`)**: Added `--vps` flag to `bin/multcloud.js` to delegate CLI commands over SSH to a 24/7 headless Cloud VPS session with zero background-tab timer throttling.
  - **Error-Time Remedy Hint**: When the local OpenCLI Browser Bridge is unreachable, `runOpenCli()` prints an actionable hint pointing to `--vps` (`MULTCLOUD_BACKEND=cloud`).

## [1.2.0] - 2026-09-01

### Added & Fixed
- **Torrent / Magnet Content Selection Step (`src/task_builder.js`, ADR-018)**: Waits for either dialog close (HTTP URL) or the `Select Content to Upload` (`button.foot-download`) modal (magnet/torrent) before submitting.
- **Explicit Browser Time Budget & Timer Throttling Probe (`src/client.js`, `src/doctor.js`, ADR-017)**: Forwards caller timeouts and measures in-page timer responsiveness in `multcloud doctor` to detect hidden-tab Chrome timer throttling.
- **Shared Builder Engine for Remote Upload (`src/task_builder.js`, `src/remote_upload.js`, ADR-013)**: Unified `transfer`, `sync`, `backup`, and `remote-upload` onto one widget-detecting builder engine with read-back verification.
- **Hermetic Mutation Coverage & Escaping Gates (`tests/coverage-shape.test.js`, `tests/escaping.test.js`, ADR-015, ADR-016)**: Enforces hermetic tests for every mutation-shaped export and scans template literals for backslash/backtick hazards.

## [1.0.0] - 2026-08-31

### Added
- Initial public release of `opencli-plugin-multcloud`: 12 OpenCLI adapters and standalone `multcloud` / `mc-cli` binary covering `doctor`, `account`, `stats`, `clouds`, `drives`, `explorer`, `tasks`, `transfer`, `sync`, `backup`, `remote-upload`, and `flow`.

# Contributing

Use the Node.js version in [.nvmrc](.nvmrc). Install dependencies and run the verification suite:

```bash
npm ci --ignore-scripts
npm run verify
```

Verification runs TypeScript checking, tests, the production build, and offline diagnostics without Discord credentials. CI checks Node 24 and 26.

- Follow the existing TypeScript style and `.js` relative imports.
- Add regression tests for bug fixes, particularly permissions, persistence, retries, and concurrent interactions.
- Commit `package-lock.json` when changing dependencies.
- Use your own Discord application and test server for live checks; follow [Setup](README.md#setup).
- Describe the problem, change, and verification results in pull requests.

For bug reports, include your Node version, steps to reproduce, expected behavior, and redacted logs. Never include tokens, environment files, databases, or member details. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

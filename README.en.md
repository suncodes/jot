# Jot

[简体中文](README.md) · [Downloads](https://github.com/suncodes/jot/releases) · [Documentation](docs/README.md) · [Issues](https://github.com/suncodes/jot/issues)

Jot is a local-first Windows notebook and AI assistant for capturing ideas, managing Markdown notes and attachments, and working with your own material. Files remain readable outside the application; the search index can be rebuilt.

This is a **0.x preview** for Windows x64. Keep independent backups of important data. See [known limitations](KNOWN_ISSUES.md).

## Features

- Quick idea capture, nested content folders, Markdown editing and preview, properties, pinned files and folders, and navigation to the current file.
- A timeline and skill-based daily reviews, with separate plugins for personal diaries and work reports.
- A general assistant with `@` references, `$` or `/` skill selection, visible tool activity and citations, context usage estimates, compaction status, and reasoning effort selection.
- Local agent, skill, and AI plugin management with dependency checks. Declarative application plugins provide configurable shortcuts and diary actions.
- File tools default to the selected notebook. Explicit absolute paths allow access outside it. Destructive operations and full-file replacement use application confirmation.

## Get started

1. Download the Windows x64 installer or ZIP from [Releases](https://github.com/suncodes/jot/releases). Keep the complete extracted directory when using the ZIP.
2. Select a local folder for your notebook.
3. Configure an OpenAI-compatible `/chat/completions` service, or skip this step to use the notebook without AI.
4. Capture ideas, create notes, or open the assistant. Diary shortcuts are configured under application plugins in settings.

Notebook files and notebook-specific state stay in the selected folder. Global settings default to `%APPDATA%/jot/settings.json` for both installer and ZIP builds. API keys are encrypted using the operating system. AI features send relevant material to your configured model provider; read [PRIVACY.md](PRIVACY.md).

## Development

Use Windows x64, Node.js **24.x**, and pnpm **9.15.4**.

```powershell
cd "app"
pnpm install --frozen-lockfile
pnpm dev
```

```powershell
pnpm typecheck
pnpm test:release
pnpm app:dist
pnpm release:artifacts
```

The [development guide](docs/development.md) explains targeted checks, isolated test data, and packaging. Development `.env` files are optional and are never loaded by packaged builds. Documentation is currently primarily in Chinese.

## Contributing and license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Do not post private notes or credentials in issues.

Jot's original source, documentation, and bundled capability instructions are licensed under [Apache-2.0](LICENSE). Third-party components retain their own terms; see [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# dsh-session-title-ruled

English | [中文](README.md)

Auto-titles [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) sessions with a fixed ruled format:

```
MMDD｜Type｜Name
```

- **MMDD** — the date of the most recent conversation (the latest `user/message` event time, host-local timezone). Continuing a session across midnight moves the stamp to the latest day.
- **Type** — exactly one of eight fixed categories: 研究 / 量化 / 开发 / 配置 / 排障 / 管理 / 创作 / 日常.
- **Name** — produced by one small LLM call that weighs the most recent messages most heavily while synthesizing the whole supplied context. When the topic substantively changes, the type and name follow; the first message never locks the title.

The taxonomy and format come from the author's cross-agent naming convention. The type words are fixed Chinese enum values and are intentionally not translated to the message language.

## Why a plugin

1. dsh exposes no session-rename tool to agents, so "let the model rename the session" has no interface to call.
2. The built-in `dsh-session-title-first-prompt-llm` provider has a hard-coded English "natural-language title" prompt that cannot be configured into a structured format.
3. `ctx.sessionTitle.register()` is the public extension point, and the service allows exactly one provider — this plugin **replaces** (does not stack on) the built-in one.

## Install

> Prerequisite: the `dsh-session-title` service allows only one registered provider. You must disable the built-in `session-title-llm` entry when enabling this plugin, otherwise the plugin's `register()` fails at startup with "already registered".

### 1. Install the package (either way)

```bash
# from GitHub (git spec)
dsh plugin --profile <profile> add zycFrancis/dsh-session-title-ruled

# or a local path
dsh plugin --profile <profile> add /absolute/path/to/dsh-session-title-ruled
```

The Web UI sidebar **Plugins** page and the `plugin_manager` tool work too.

### 2. Append to the profile's `cordis.patch.yml`

```yaml
# disable the built-in natural-language provider (required: one provider max)
- id: session-title-llm
  disabled: true
# optional route: pin a cheap small model; omit to follow each session's main route
- id: session-title-ruled
  config:
    provider: zai-coding-cn
    model: glm-5.3-flash
```

### 3. Restart the profile's host

Desktop / web profiles are owned by their apps; changes apply after restart.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `provider` / `model` | unset | Route for the small title request; pinning a cheap model is recommended. Unset = follow the session's main request route |
| `targetCjkCharacters` | 12 | Target name length (CJK characters) used in the prompt |
| `maxNameCharacters` | 16 | Hard cap on the name (code-point truncation) |
| `maxInputBytes` | 8192 | Byte budget for the framed JSON input; over budget, the most recent messages are kept first |
| `maxOutputTokens` | 512 | Output cap for the title request (headroom after reasoning-effort downgrade) |
| `timeoutMs` | 45000 | Per-request timeout |
| `keepTitlePatterns` | `['^\\d{2}｜']` | Existing titles matching any pattern are never renamed (protects numbered schemes like `01｜MS Research`) |
| `debugLog` | false | Write `/tmp/dsh-session-title-ruled.log` for diagnosis |

## Behavior notes

- `automatic: 'all-prompts'`: every new human message may refresh the title per the latest synthesized topic; the date follows the most recent conversation.
- A manual rename in the UI "pins" the title (source=user) in the `dsh-session-title` service; this plugin yields automatically.
- Reasoning models are resolved to their lowest reasoning effort; empty output retries without an effort, then falls back to the reasoning tail.
- Generation failures only log a warning — the session keeps its deterministic fallback title.
- Titles never enter model input (a `dsh-session-title` guarantee): zero token / KV-cache impact on main requests.
- The implementation imports no cordis / dsh-* runtime packages (no dual-instance hazard with the host); it uses only ctx APIs, Node builtins, and schemastery.

## Troubleshooting

- Search startup logs for `session-title-ruled provider registered`; a conflict raises `already registered` (the built-in provider was not disabled).
- With `debugLog: true`, read `/tmp/dsh-session-title-ruled.log` (generating / accepted / keep / unparseable lines).
- Title not updating: the session may be pinned by a manual rename, the title may match `keepTitlePatterns`, or the route's model may be unavailable.

## Development

```bash
pnpm install
npm test        # pure-logic unit tests (dates, parsing, truncation, numbered-title exception, message selection)
```

- Design notes: [docs/design.md](docs/design.md).
- The repo also carries the author's batch-rename tooling for existing sessions (`scripts/batch-rename/`, not part of the npm package); see its [README](scripts/batch-rename/README.md).

## License

MIT

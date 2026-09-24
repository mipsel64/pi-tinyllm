# pi-tinyllm

[![CI](https://github.com/mipsel64/pi-tinyllm/actions/workflows/ci.yml/badge.svg)](https://github.com/mipsel64/pi-tinyllm/actions/workflows/ci.yml)

A standalone [Pi](https://pi.dev) package that discovers models from a local [TinyLLM](https://github.com/mipsel64/tinyllm) gateway and inherits their metadata from Pi's installed model catalogs.

## Install

Install the published package:

```sh
pi install npm:@mipsel64/pi-tinyllm
```

Earlier versions were published as `pi-tinyllm`, which is now deprecated. To switch, run `pi remove npm:pi-tinyllm` before installing.

Or install the current GitHub version:

```sh
pi install git:github.com/mipsel64/pi-tinyllm
```

Or try a local checkout without installing it:

```sh
pi -e /path/to/pi-tinyllm --list-models tinyllm
```

Install a local checkout for future Pi sessions:

```sh
pi install /path/to/pi-tinyllm
```

## Configure

Set the gateway URL and its bearer token before starting Pi:

```sh
export TINYLLM_BASE_URL=http://127.0.0.1:8080
export TINYLLM_API_KEY=your-gateway-token
pi --list-models tinyllm
```

`TINYLLM_BASE_URL` defaults to `http://127.0.0.1:8080`. Values ending in `/anthropic` or `/v1` are accepted and normalized. When TinyLLM authentication is disabled, explicitly set the token accepted by that gateway (commonly `TINYLLM_API_KEY=tinyllm`); this package does not guess a credential.

You can store both the gateway URL and key through Pi's native `/login` flow instead of keeping them in the environment. Environment configuration is still needed for first-run `--list-models`, because extensions cannot read Pi's credential store before registration. Later native refreshes use the stored values.

Select a discovered public ID without removing its TinyLLM namespace:

```sh
pi --provider tinyllm --model anthropic/claude-sonnet-4-6
```

## Behavior and limitations

- Discovery uses TinyLLM's `/api/v1/models` endpoint, where `configured_models` contains explicit IDs and `providers` identifies every configured provider. Provider descriptors expand from Pi's matching installed catalog, including custom TinyLLM prefixes; a `404` falls back to `/v1/models` for explicit-ID discovery from older servers. Canonical `codex` maps to `openai-codex`, while canonical `openai` prefers `openai-codex` metadata and then `openai`. Expansion describes routable catalog models; it does not probe account-specific upstream entitlements.
- The extension status line shows the active Pi provider, such as `[tinyllm]` or `[openai-codex]`. Generated OpenAI `-fast` IDs are filtered from discovery; run `/fast` on an advertised OpenAI GPT model to toggle request-time fast routing. While enabled, the status line reads `[tinyllm] fast` for a selected TinyLLM model.
- `/fast` is available only while a TinyLLM model sourced from an OpenAI catalog has a native `gpt-*` ID. Other models are left unchanged and produce a warning. The toggle follows the active session branch and is restored on reload or resume.
- Anthropic Messages, OpenAI Responses, and Chat Completions models use TinyLLM's corresponding routes.
- Unknown aliases, unknown models, and models using unsupported wire APIs are omitted rather than assigned guessed metadata.
- Pi owns the persisted model catalog. Failed refreshes retain the last known good catalog, and offline refreshes restore it.
- Pi 0.87.1 performs only a cache refresh after registering an extension provider. This package does one bounded first-run discovery before registration so `--list-models` works with environment configuration. Pi may then restore an older persisted catalog during the same startup; a later native catalog refresh reconciles it. The package does not maintain a second cache.

## Publishing

The package is published as `@mipsel64/pi-tinyllm` by the `mipsel64` npm organization. npm requires the first version to exist before trusted publishing can be configured, so publish it once with `npm login && npm publish --access public`, then add this trusted publisher in the package settings on npmjs.com:

- Organization or user: `mipsel64`
- Repository: `pi-tinyllm`
- Workflow: `release.yml`
- Environment: leave blank
- Allowed action: `npm publish`

Future releases are tokenless and include npm provenance:

```sh
npm version patch
git push origin main --follow-tags
```

## Development

```sh
npm test
```

Requires Node.js 22.19 or newer. Pi supplies the peer packages at runtime.

## License

MIT

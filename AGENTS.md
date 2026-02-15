# CLAUDE.md

This file provides guidance when working with code in this repository.

## What This Is

A SillyTavern third-party extension ("Image Generation Clone") that adds AI-driven image generation and image reimagine/edit flows to SillyTavern's chat interface. It generates descriptive prompts via LLM, dispatches image creation to either SillyTavern's built-in `/sd` slash command or OpenRouter's image API, and can edit existing images with prompt + optional reference image via OpenRouter.

## Development

There is no build step, linter, or test suite. The extension is plain ES module JavaScript loaded directly by SillyTavern at runtime. To develop:

1. Symlink or place this repo into SillyTavern's `public/scripts/extensions/third-party/image_generation/` directory
2. Enable the extension in SillyTavern's UI
3. Reload SillyTavern to pick up changes

The SillyTavern host source is available at `/home/pop/projects/source_code/sillytavern/SillyTavern_Dev/` for reference.

## Architecture

**Single-file extension**: All logic lives in `index.js` (~1400 lines). The manifest (`manifest.json`) tells ST to load `index.js` and `style.css`. Settings UI is in `settings.html`, loaded at runtime via AJAX.

### Key Flows

**Prompt generation pipeline** (`generatePromptWithLLM` → engine-specific functions):
- Three engine modes: `raw` (recommended — injects prompt via `setExtensionPrompt` + `generateQuietPrompt`), `quiet_only` (traditional quiet prompt), `quiet_then_raw` (quiet with raw fallback)
- Raw mode builds context from recent chat messages, processes it through templates, and routes through ST's full generation pipeline for aggregator API compatibility
- All generated prompts pass through `processReply()` which sanitizes text for image generation (strips non-visual chars, normalizes to comma-delimited keywords)

**Image generation dispatch** (`generateImage`):
1. LLM generates descriptive prompt → `buildFinalPrompt` prepends user's prefix
2. Review popup lets user edit prompt, pick backend (Default SD / OpenRouter), toggle "as background"
3. Default backend: executes `/sd raw=true "<prompt>"` via ST's slash command system
4. OpenRouter backend: POSTs to `/api/openrouter/image/generate` with aspect ratio derived from SD settings

**Image edit dispatch** (`editImage`):
1. Opens edit popup to collect edit prompt, OpenRouter model, base image source (chat/upload), optional reference image source (chat/upload), and "as background"
2. Normalizes/validates image type + size, resolves images to data URLs
3. Calls `/api/openrouter/image/edit` with prompt + base image (+ optional reference image)
4. Saves edited output into chat media and optionally applies it as background

**UI injection**: The extension injects a wand button into ST's chat area (`#sd_wand_container` or send form fallbacks). A Popper.js-positioned dropdown shows generation modes plus a "Reimagine / Edit an image" action. Right-click shows a context menu popup. Image control overlays also inject "Set as Background" and "Reimagine / Edit Image" buttons.

### ST Integration Points

- **Imports from ST core**: `getContext()`, `extension_settings`, `generateQuietPrompt`, `eventSource`/`event_types`, `getRequestHeaders`, `saveBase64AsFile`, `secret_state`
- **Extension prompt injection**: Uses `context.setExtensionPrompt()` with key `igc_raw_inject` or `igc_quiet_inject` to inject prompts as user-role messages (workaround for Claude's "must end with user message" constraint)
- **Slash command**: Registers `/imgclone` (alias `/igc`) with generation modes, free-text prompt support, and `--edit` entry point for the reimagine/edit flow
- **Event listeners**: `CHAT_CHANGED`, `CHARACTER_MESSAGE_RENDERED`, `USER_MESSAGE_RENDERED`, `APP_READY` — used to re-inject UI buttons
- **Background setting**: Emits `FORCE_SET_BACKGROUND` event; also injects per-image controls for "Set as Background" and "Reimagine / Edit Image"

### Settings

Stored in `extension_settings.image_generation`. All values are validated/normalized on load with `normalizeMode`, `normalizePromptEngineMode`, etc. Settings UI elements use `igc_` prefix for IDs.

### CSS Conventions

All custom classes use `igc-` prefix. Uses ST theme variables (`--SmartThemeBlurTintColor`, `--SmartThemeBorderColor`, `--SmartThemeQuoteColor`). File upload inputs in the edit popup are hidden (`display: none !important`) and replaced with an explicit button+filename UI because SillyTavern's global CSS (`input[type="file"] { display: none }`) hides all native file inputs, breaking uploads in Firefox.

## Conventions

- Console logging uses `[IGC]` prefix
- jQuery is used throughout (provided by ST globally)
- `toastr` is used for user notifications (provided by ST globally)
- Mode constants match ST's built-in SD extension mode numbers exactly (CHARACTER=0, USER=1, SCENARIO=2, etc.)
- The extension deliberately resets `backend` to `"default"` after each generation — OpenRouter must be re-selected each time

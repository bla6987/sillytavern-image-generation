import { Popper } from '../../../../lib.js';
import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt, generateRaw } from '../../../../script.js';
import { eventSource, event_types } from '../../../../script.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { saveBase64AsFile } from '../../../utils.js';
import { secret_state, SECRET_KEYS } from '../../../secrets.js';
import { humanizedDateTime, getMessageTimeStamp } from '../../../RossAscends-mods.js';

const extensionName = 'image_generation';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const modeDropdownId = 'igc_dropdown';
const modeDropdownButtonSelector = '#image_gen_clone_button';
let slashCommandsRegistered = false;
let modeDropdownPopper = null;
let modeDropdownCloseHandlerBound = false;

// Match ST default visible generation modes.
const generationMode = {
    CHARACTER: 0,
    USER: 1,
    SCENARIO: 2,
    RAW_LAST: 3,
    NOW: 4,
    FACE: 5,
    BACKGROUND: 7,
};

const orderedModes = [
    generationMode.CHARACTER,
    generationMode.FACE,
    generationMode.USER,
    generationMode.SCENARIO,
    generationMode.NOW,
    generationMode.RAW_LAST,
    generationMode.BACKGROUND,
];

const validModes = new Set(orderedModes);

const promptEngineMode = {
    RAW: 'raw',
    QUIET_THEN_RAW: 'quiet_then_raw',
    QUIET_ONLY: 'quiet_only',
};

const validPromptEngineModes = new Set(Object.values(promptEngineMode));

const rawContextMode = {
    TEMPLATE_ONLY: 'template_only',
    RECENT_CONTEXT: 'recent_context',
    FULL_CONTEXT: 'full_context',
};

const validRawContextModes = new Set(Object.values(rawContextMode));

const backendType = { DEFAULT: 'default', OPENROUTER: 'openrouter' };
const validBackends = new Set(Object.values(backendType));

const openRouterAspectRatios = {
    '16:9': 16 / 9,
    '1:1': 1,
    '21:9': 21 / 9,
    '2:3': 2 / 3,
    '3:2': 3 / 2,
    '4:5': 4 / 5,
    '5:4': 5 / 4,
    '9:16': 9 / 16,
    '9:21': 9 / 21,
};

function getClosestAspectRatio(width, height) {
    const ratio = width / height;
    let closest = '1:1';
    let minDiff = Infinity;
    for (const [key, value] of Object.entries(openRouterAspectRatios)) {
        const diff = Math.abs(ratio - value);
        if (diff < minDiff) {
            minDiff = diff;
            closest = key;
        }
    }
    return closest;
}

function getSDSettingsAspectRatio() {
    const sdSettings = extension_settings?.sd;
    const width = Number(sdSettings?.width);
    const height = Number(sdSettings?.height);
    if (width > 0 && height > 0) {
        return getClosestAspectRatio(width, height);
    }
    return '1:1';
}

const RAW_CONTEXT_TOTAL_CHAR_LIMIT = 6000;

const defaultSettings = {
    mode: generationMode.CHARACTER,
    prefix: 'best quality, absurdres, aesthetic,',
    prompt_engine_mode: promptEngineMode.RAW,
    raw_context_mode: rawContextMode.RECENT_CONTEXT,
    raw_context_messages: 4,
    raw_context_chars_per_message: 400,
    raw_response_length: 220,
    backend: backendType.DEFAULT,
    openrouter_model: '',
};

// Exact ST default templates for visible modes.
const promptTemplates = {
    [generationMode.CHARACTER]: 'In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'full body portrait,\'',
    [generationMode.FACE]: 'In the next response I want you to provide only a detailed comma-delimited list of keywords and phrases which describe {{char}}. The list must include all of the following items in this order: name, species and race, gender, age, facial features and expressions, occupation, hair and hair accessories (if any), what they are wearing on their upper body (if anything). Do not describe anything below their neck. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'close up facial portrait,\'',
    [generationMode.USER]: 'Ignore previous instructions and provide a detailed description of {{user}}\'s physical appearance from the perspective of {{char}} in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: name, species and race, gender, age, clothing, occupation, physical features and appearances. Do not include descriptions of non-visual qualities such as personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'full body portrait,\'. Ignore the rest of the story when crafting this description. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.',
    [generationMode.SCENARIO]: 'Ignore previous instructions and provide a detailed description for all of the following: a brief recap of recent events in the story, {{char}}\'s appearance, and {{char}}\'s surroundings. Do not reply as {{char}} while writing this description.',
    [generationMode.NOW]: `Ignore previous instructions. Your next response must be formatted as a single comma-delimited list of concise keywords.  The list will describe of the visual details included in the last chat message.

    Only mention characters by using pronouns ('he','his','she','her','it','its') or neutral nouns ('male', 'the man', 'female', 'the woman').

    Ignore non-visible things such as feelings, personality traits, thoughts, and spoken dialog.

    Add keywords in this precise order:
    a keyword to describe the location of the scene,
    a keyword to mention how many characters of each gender or type are present in the scene (minimum of two characters:
    {{user}} and {{char}}, example: '2 men ' or '1 man 1 woman ', '1 man 3 robots'),

    keywords to describe the relative physical positioning of the characters to each other (if a commonly known term for the positioning is known use it instead of describing the positioning in detail) + 'POV',

    a single keyword or phrase to describe the primary act taking place in the last chat message,

    keywords to describe {{char}}'s physical appearance and facial expression,
    keywords to describe {{char}}'s actions,
    keywords to describe {{user}}'s physical appearance and actions.

    If character actions involve direct physical interaction with another character, mention specifically which body parts interacting and how.

    A correctly formatted example response would be:
    '(location),(character list by gender),(primary action), (relative character position) POV, (character 1's description and actions), (character 2's description and actions)'`,
    [generationMode.RAW_LAST]: 'Ignore previous instructions and provide ONLY the last chat message string back to me verbatim. Do not write anything after the string. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.',
    [generationMode.BACKGROUND]: 'Ignore previous instructions and provide a detailed description of {{char}}\'s surroundings in the form of a comma-delimited list of keywords and phrases. The list must include all of the following items in this order: location, time of day, weather, lighting, and any other relevant details. Do not include descriptions of characters and non-visual qualities such as names, personality, movements, scents, mental traits, or anything which could not be seen in a still photograph. Do not write in full sentences. Prefix your description with the phrase \'background,\'. Ignore the rest of the story when crafting this description. Do not reply as {{char}} when writing this description, and do not attempt to continue the story.',
};

const modeDisplayNames = {
    [generationMode.CHARACTER]: 'Yourself',
    [generationMode.FACE]: 'Your Face',
    [generationMode.USER]: 'Me',
    [generationMode.SCENARIO]: 'The Whole Story',
    [generationMode.NOW]: 'The Last Message',
    [generationMode.RAW_LAST]: 'Raw Last Message',
    [generationMode.BACKGROUND]: 'Background',
};

// Strict default ST trigger words.
const triggerWords = {
    [generationMode.CHARACTER]: ['you'],
    [generationMode.USER]: ['me'],
    [generationMode.SCENARIO]: ['scene'],
    [generationMode.RAW_LAST]: ['raw_last'],
    [generationMode.NOW]: ['last'],
    [generationMode.FACE]: ['face'],
    [generationMode.BACKGROUND]: ['background'],
};

function saveSettings() {
    saveSettingsDebounced();
}

function getSettings() {
    return extension_settings[extensionName];
}

function normalizeMode(mode) {
    return validModes.has(mode) ? mode : generationMode.CHARACTER;
}

function normalizePromptEngineMode(mode) {
    return validPromptEngineModes.has(mode) ? mode : promptEngineMode.RAW;
}

function normalizeRawContextMode(mode) {
    return validRawContextModes.has(mode) ? mode : rawContextMode.RECENT_CONTEXT;
}

function normalizeBackend(backend) {
    return validBackends.has(backend) ? backend : backendType.DEFAULT;
}

function clampNumber(value, fallback, min, max) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }
    const rounded = Math.round(numericValue);
    return Math.min(max, Math.max(min, rounded));
}

function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    Object.assign(extension_settings[extensionName], {
        ...defaultSettings,
        ...extension_settings[extensionName],
    });

    const settings = getSettings();
    const mode = Number(settings.mode);
    let changed = false;

    if (!Number.isInteger(mode) || !validModes.has(mode)) {
        settings.mode = generationMode.CHARACTER;
        changed = true;
    } else {
        settings.mode = mode;
    }

    if (typeof settings.prefix !== 'string') {
        settings.prefix = defaultSettings.prefix;
        changed = true;
    }

    const normalizedPromptEngineMode = normalizePromptEngineMode(settings.prompt_engine_mode);
    if (settings.prompt_engine_mode !== normalizedPromptEngineMode) {
        settings.prompt_engine_mode = normalizedPromptEngineMode;
        changed = true;
    }

    const normalizedRawContextMode = normalizeRawContextMode(settings.raw_context_mode);
    if (settings.raw_context_mode !== normalizedRawContextMode) {
        settings.raw_context_mode = normalizedRawContextMode;
        changed = true;
    }

    const normalizedRawContextMessages = clampNumber(settings.raw_context_messages, defaultSettings.raw_context_messages, 1, 10);
    if (settings.raw_context_messages !== normalizedRawContextMessages) {
        settings.raw_context_messages = normalizedRawContextMessages;
        changed = true;
    }

    const normalizedRawContextCharsPerMessage = clampNumber(settings.raw_context_chars_per_message, defaultSettings.raw_context_chars_per_message, 100, 1000);
    if (settings.raw_context_chars_per_message !== normalizedRawContextCharsPerMessage) {
        settings.raw_context_chars_per_message = normalizedRawContextCharsPerMessage;
        changed = true;
    }

    const normalizedRawResponseLength = clampNumber(settings.raw_response_length, defaultSettings.raw_response_length, 64, 512);
    if (settings.raw_response_length !== normalizedRawResponseLength) {
        settings.raw_response_length = normalizedRawResponseLength;
        changed = true;
    }

    const normalizedBackend = normalizeBackend(settings.backend);
    if (settings.backend !== normalizedBackend) {
        settings.backend = normalizedBackend;
        changed = true;
    }

    if (typeof settings.openrouter_model !== 'string') {
        settings.openrouter_model = defaultSettings.openrouter_model;
        changed = true;
    }

    if (changed) {
        saveSettingsDebounced();
    }
}

function updateRawContextSettingsVisibility() {
    const rawContextModeValue = String($('#igc_raw_context_mode').val() || rawContextMode.RECENT_CONTEXT);
    const showContextLimits = rawContextModeValue !== rawContextMode.TEMPLATE_ONLY;
    $('#igc_raw_context_messages_row').toggleClass('igc-hidden', !showContextLimits);
    $('#igc_raw_context_chars_row').toggleClass('igc-hidden', !showContextLimits);
}

function updateUIFromSettings() {
    const settings = getSettings();
    $('#igc_mode').val(settings.mode);
    $('#igc_prefix').val(settings.prefix);
    $('#igc_prompt_engine_mode').val(settings.prompt_engine_mode);
    $('#igc_raw_context_mode').val(settings.raw_context_mode);
    $('#igc_raw_context_messages').val(settings.raw_context_messages);
    $('#igc_raw_context_chars_per_message').val(settings.raw_context_chars_per_message);
    $('#igc_raw_response_length').val(settings.raw_response_length);
    updateRawContextSettingsVisibility();
}

function bindUIEvents() {
    $('#igc_mode').on('change', function () {
        getSettings().mode = normalizeMode(parseInt($(this).val(), 10));
        saveSettings();
    });

    $('#igc_prefix').on('change', function () {
        getSettings().prefix = String($(this).val() || '');
        saveSettings();
    });

    $('#igc_prompt_engine_mode').on('change', function () {
        getSettings().prompt_engine_mode = normalizePromptEngineMode(String($(this).val() || promptEngineMode.RAW));
        saveSettings();
    });

    $('#igc_raw_context_mode').on('change', function () {
        getSettings().raw_context_mode = normalizeRawContextMode(String($(this).val() || rawContextMode.RECENT_CONTEXT));
        updateRawContextSettingsVisibility();
        saveSettings();
    });

    $('#igc_raw_context_messages').on('change', function () {
        getSettings().raw_context_messages = clampNumber($(this).val(), defaultSettings.raw_context_messages, 1, 10);
        $(this).val(getSettings().raw_context_messages);
        saveSettings();
    });

    $('#igc_raw_context_chars_per_message').on('change', function () {
        getSettings().raw_context_chars_per_message = clampNumber($(this).val(), defaultSettings.raw_context_chars_per_message, 100, 1000);
        $(this).val(getSettings().raw_context_chars_per_message);
        saveSettings();
    });

    $('#igc_raw_response_length').on('change', function () {
        getSettings().raw_response_length = clampNumber($(this).val(), defaultSettings.raw_response_length, 64, 512);
        $(this).val(getSettings().raw_response_length);
        saveSettings();
    });

    $('#igc_generate_button').on('click', function () {
        generateImage();
    });
}

function processTemplate(template) {
    const context = getContext();
    const charName = context.name2 || 'Character';
    const userName = context.name1 || 'User';

    return template
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{user\}\}/gi, userName)
        .trim();
}

/**
 * Sanitizes generated prompt for image generation.
 * Mirrors ST's stable-diffusion processReply behavior.
 */
function processReply(str) {
    if (!str) {
        return '';
    }

    str = str.replaceAll('"', '');
    str = str.replaceAll('“', '');
    str = str.replaceAll('\n', ', ');
    str = str.normalize('NFD');
    str = str.replace(/[^a-zA-Z0-9.,:_(){}<>[\]/\-'|#]+/g, ' ');
    str = str.replace(/\s+/g, ' ');
    str = str.trim();

    str = str
        .split(',')
        .map(x => x.trim())
        .filter(x => x)
        .join(', ');

    return str;
}

async function callQuietPrompt(quietPrompt) {
    try {
        return await generateQuietPrompt({ quietPrompt });
    } catch {
        // Compatibility fallback for older API signatures.
        return await generateQuietPrompt(quietPrompt, false, false);
    }
}

function getTemplateByMode(mode) {
    const template = promptTemplates[mode];
    if (!template) {
        throw new Error(`Unknown mode: ${mode}`);
    }
    return template;
}

function truncateWithEllipsis(text, maxLength) {
    if (text.length <= maxLength) {
        return text;
    }
    if (maxLength <= 3) {
        return text.slice(0, maxLength);
    }
    return `${text.slice(0, maxLength - 3).trimEnd()}...`;
}

function sanitizeContextText(value, maxLength = null) {
    if (typeof value !== 'string') {
        return '';
    }
    const collapsed = value.replace(/\s+/g, ' ').trim();
    if (!collapsed) {
        return '';
    }
    if (typeof maxLength === 'number' && maxLength > 0) {
        return truncateWithEllipsis(collapsed, maxLength);
    }
    return collapsed;
}

function getChatMessageText(message) {
    if (!message || typeof message !== 'object') {
        return '';
    }

    if (typeof message.mes === 'string') {
        return message.mes;
    }

    if (typeof message.message === 'string') {
        return message.message;
    }

    if (typeof message.content === 'string') {
        return message.content;
    }

    return '';
}

function getChatMessageSpeaker(message, context) {
    const nameCandidate = sanitizeContextText(message?.name ?? message?.original_name);
    if (nameCandidate) {
        return nameCandidate;
    }
    if (message?.is_user) {
        return sanitizeContextText(context?.name1 || 'User');
    }
    return sanitizeContextText(context?.name2 || 'Character');
}

function collectContextEntries({
    maxMessages,
    maxCharsPerMessage,
    totalCharLimit = RAW_CONTEXT_TOTAL_CHAR_LIMIT,
}) {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];

    if (!chat.length) {
        return [];
    }

    const entries = [];
    let totalChars = 0;

    for (let idx = chat.length - 1; idx >= 0; idx--) {
        if (entries.length >= maxMessages) {
            break;
        }

        const message = chat[idx];
        if (!message || message.is_system) {
            continue;
        }

        const text = sanitizeContextText(getChatMessageText(message), maxCharsPerMessage);
        if (!text) {
            continue;
        }

        const speaker = getChatMessageSpeaker(message, context) || 'Character';
        const entry = `${speaker}: ${text}`;
        if (entry.length > totalCharLimit && entries.length === 0) {
            entries.unshift(truncateWithEllipsis(entry, totalCharLimit));
            break;
        }

        if (totalChars + entry.length > totalCharLimit) {
            break;
        }

        entries.unshift(entry);
        totalChars += entry.length;
    }

    return entries;
}

function buildContextBlock(rawContextModeSetting, settings) {
    if (rawContextModeSetting === rawContextMode.TEMPLATE_ONLY) {
        return '';
    }

    const maxMessages = rawContextModeSetting === rawContextMode.FULL_CONTEXT
        ? Number.MAX_SAFE_INTEGER
        : settings.raw_context_messages;
    const entries = collectContextEntries({
        maxMessages,
        maxCharsPerMessage: settings.raw_context_chars_per_message,
        totalCharLimit: RAW_CONTEXT_TOTAL_CHAR_LIMIT,
    });

    if (!entries.length) {
        return '';
    }

    const header = rawContextModeSetting === rawContextMode.FULL_CONTEXT
        ? 'Full chat context:'
        : 'Recent chat context:';
    return `${header}\n${entries.join('\n')}`;
}

function buildRawPromptInput(mode, customPrompt = null) {
    const settings = getSettings();
    const template = customPrompt ? processTemplate(customPrompt) : processTemplate(getTemplateByMode(mode));
    const normalizedContextMode = normalizeRawContextMode(settings.raw_context_mode);
    const contextBlock = buildContextBlock(normalizedContextMode, settings);

    if (!contextBlock) {
        return template;
    }

    return `${template}\n\nUse the context below only as visual scene reference.\n${contextBlock}`;
}

function processGeneratedPrompt(rawResponse, source) {
    const processed = processReply(rawResponse);
    if (!processed) {
        throw new Error(`Prompt generation failed (${source}): no text returned.`);
    }
    return processed;
}

async function generatePromptWithQuiet(mode, customPrompt = null) {
    const quietPrompt = customPrompt ? processTemplate(customPrompt) : processTemplate(getTemplateByMode(mode));
    console.debug(`[IGC] Prompt generation engine=quiet inputLength=${quietPrompt.length}`);
    const response = await callQuietPrompt(quietPrompt);
    const processed = processGeneratedPrompt(response, 'quiet');
    console.debug(`[IGC] Prompt generation engine=quiet outputLength=${processed.length}`);
    return processed;
}

async function generatePromptWithRaw(mode, customPrompt = null) {
    const settings = getSettings();
    const rawPrompt = buildRawPromptInput(mode, customPrompt);
    console.debug(`[IGC] Prompt generation engine=raw contextMode=${settings.raw_context_mode} inputLength=${rawPrompt.length}`);
    const response = await generateRaw({
        prompt: rawPrompt,
        responseLength: settings.raw_response_length,
        trimNames: true,
    });
    const processed = processGeneratedPrompt(response, 'raw');
    console.debug(`[IGC] Prompt generation engine=raw contextMode=${settings.raw_context_mode} outputLength=${processed.length}`);
    return processed;
}

async function generatePromptWithLLM(mode, customPrompt = null) {
    const settings = getSettings();
    const engineMode = normalizePromptEngineMode(settings.prompt_engine_mode);

    if (engineMode === promptEngineMode.QUIET_ONLY) {
        const result = await generatePromptWithQuiet(mode, customPrompt);
        console.debug(`[IGC] Prompt generation complete engine=${engineMode} fallbackUsed=false`);
        return result;
    }

    if (engineMode === promptEngineMode.QUIET_THEN_RAW) {
        try {
            const result = await generatePromptWithQuiet(mode, customPrompt);
            console.debug(`[IGC] Prompt generation complete engine=${engineMode} fallbackUsed=false`);
            return result;
        } catch (error) {
            console.warn(`[IGC] Quiet prompt failed, retrying with raw mode: ${error?.message || error}`);
            const result = await generatePromptWithRaw(mode, customPrompt);
            console.debug(`[IGC] Prompt generation complete engine=${engineMode} fallbackUsed=true`);
            return result;
        }
    }

    const result = await generatePromptWithRaw(mode, customPrompt);
    console.debug(`[IGC] Prompt generation complete engine=${engineMode} fallbackUsed=false`);
    return result;
}

function buildFinalPrompt(generatedPrompt) {
    const settings = getSettings();
    const parts = [];
    const prefix = String(settings.prefix || '').trim();

    if (prefix) {
        parts.push(prefix);
    }

    parts.push(generatedPrompt.trim());
    return parts.join(', ');
}

let cachedOpenRouterModels = null;

async function fetchOpenRouterModels(forceRefresh = false) {
    if (cachedOpenRouterModels && !forceRefresh) {
        return cachedOpenRouterModels;
    }

    const result = await fetch('/api/openrouter/models/image', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
    });

    if (result.ok) {
        cachedOpenRouterModels = await result.json();
        return cachedOpenRouterModels;
    }

    return [];
}

async function showReviewPopup(prompt) {
    const context = getContext();
    const popupFn = context?.callGenericPopup;
    const popupTypeInput = context?.POPUP_TYPE?.INPUT;

    if (typeof popupFn !== 'function' || popupTypeInput === undefined) {
        return { prompt, backend: backendType.DEFAULT, model: '' };
    }

    const settings = getSettings();
    let selectedBackend = normalizeBackend(settings.backend);
    let selectedModel = settings.openrouter_model || '';

    const $content = $('<div class="igc-review-controls"></div>');

    // Backend row
    const $backendRow = $('<div class="igc-review-row"></div>');
    const $backendSelect = $('<select class="igc-review-select"></select>');
    $backendSelect.append('<option value="default">Default (SD)</option>');
    $backendSelect.append('<option value="openrouter">OpenRouter</option>');
    $backendSelect.val(selectedBackend);
    $backendRow.append('<label>Backend:</label>').append($backendSelect);
    $content.append($backendRow);

    // As background checkbox row
    const $bgRow = $('<div class="igc-review-row"></div>');
    const $bgCheckbox = $('<input type="checkbox" id="igc_as_background" />');
    $bgRow.append($bgCheckbox).append('<label for="igc_as_background">As background</label>');
    $content.append($bgRow);

    // OpenRouter settings container
    const $orSettings = $('<div class="igc-or-settings"></div>');

    // Model row
    const $modelRow = $('<div class="igc-review-row"></div>');
    const $modelSelect = $('<select class="igc-review-select igc-model-select"></select>');
    const $refreshBtn = $('<button class="igc-refresh-btn menu_button" title="Refresh models"><i class="fa-solid fa-arrows-rotate"></i></button>');
    $modelRow.append('<label>Model:</label>').append($modelSelect).append($refreshBtn);
    $orSettings.append($modelRow);

    $content.append($orSettings);

    function updateORVisibility() {
        $orSettings.toggle(selectedBackend === backendType.OPENROUTER);
    }
    updateORVisibility();

    async function loadModels(forceRefresh = false) {
        $modelSelect.empty().append('<option value="">Loading...</option>').prop('disabled', true);
        $refreshBtn.prop('disabled', true);
        try {
            const models = await fetchOpenRouterModels(forceRefresh);
            $modelSelect.empty();
            if (models.length === 0) {
                $modelSelect.append('<option value="">No models available</option>');
            } else {
                for (const model of models) {
                    $modelSelect.append(`<option value="${model.value}">${model.text}</option>`);
                }
                if (selectedModel && models.some(m => m.value === selectedModel)) {
                    $modelSelect.val(selectedModel);
                } else if (models.length > 0) {
                    selectedModel = models[0].value;
                    $modelSelect.val(selectedModel);
                }
            }
        } catch (e) {
            $modelSelect.empty().append('<option value="">Failed to load models</option>');
            console.error('[IGC] Failed to load OpenRouter models:', e);
        }
        $modelSelect.prop('disabled', false);
        $refreshBtn.prop('disabled', false);
    }

    $backendSelect.on('change', function () {
        selectedBackend = normalizeBackend($(this).val());
        updateORVisibility();
        if (selectedBackend === backendType.OPENROUTER) {
            loadModels();
        }
    });

    $modelSelect.on('change', function () {
        selectedModel = String($(this).val() || '');
    });

    $refreshBtn.on('click', function () {
        loadModels(true);
    });

    if (selectedBackend === backendType.OPENROUTER) {
        loadModels();
    }

    const result = await popupFn($content, popupTypeInput, prompt, {
        rows: 8, okButton: 'Generate', cancelButton: 'Cancel', wide: true,
    });

    if (result === null || result === undefined || result === false) {
        throw new Error('Generation aborted by user.');
    }

    // Remember model but always reset backend to default
    settings.openrouter_model = selectedModel;
    settings.backend = backendType.DEFAULT;
    saveSettings();

    return {
        prompt: String(result),
        backend: selectedBackend,
        model: selectedModel,
        asBackground: $bgCheckbox.prop('checked'),
    };
}

async function generateOpenRouterImage(prompt, model, aspectRatio) {
    if (!secret_state[SECRET_KEYS.OPENROUTER]) {
        throw new Error('OpenRouter API key not set. Configure it in SillyTavern API settings.');
    }

    if (!model) {
        throw new Error('No OpenRouter model selected.');
    }

    const result = await fetch('/api/openrouter/image/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            model: model,
            prompt: prompt,
            aspect_ratio: aspectRatio,
        }),
    });

    if (result.ok) {
        const data = await result.json();
        return { format: 'jpg', data: data.image };
    }

    const text = await result.text();
    throw new Error(text);
}

async function saveAndDisplayImage(imageData, prompt) {
    const context = getContext();
    const characterName = context.name2 || 'Unknown';
    const filename = `${characterName}_${humanizedDateTime()}`;
    const imagePath = await saveBase64AsFile(imageData.data, characterName, filename, imageData.format);

    const message = {
        name: characterName,
        is_user: false,
        is_system: false,
        send_date: getMessageTimeStamp(),
        mes: prompt,
        extra: {
            media: [{
                url: imagePath,
                type: 'image',
                title: prompt,
                source: 'generated',
            }],
            media_display: 'gallery',
            media_index: 0,
            inline_image: false,
        },
    };

    context.chat.push(message);
    const messageId = context.chat.length - 1;
    await eventSource.emit(event_types.MESSAGE_RECEIVED, messageId, 'extension');
    context.addOneMessage(message);
    await eventSource.emit(event_types.CHARACTER_MESSAGE_RENDERED, messageId, 'extension');
    await context.saveChat();

    return imagePath;
}

async function executeSTImageGeneration(prompt) {
    try {
        const { executeSlashCommandsWithOptions } = await import('../../../slash-commands.js');
        const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        const result = await executeSlashCommandsWithOptions(`/sd raw=true "${escapedPrompt}"`, {
            handleParserErrors: false,
            handleExecutionErrors: false,
        });

        if (!result || result.isError || result.isAborted) {
            const reason = result?.errorMessage || result?.abortReason || 'No image URL returned from /sd command.';
            throw new Error(reason);
        }

        const imagePath = typeof result.pipe === 'string'
            ? result.pipe.trim()
            : String(result.pipe ?? '').trim();
        if (!imagePath) {
            throw new Error('No image URL returned from /sd command.');
        }

        return imagePath;
    } catch (error) {
        throw new Error(`Failed to execute /sd command: ${error.message}`);
    }
}

async function applyGeneratedBackground(imagePath) {
    const normalizedPath = String(imagePath ?? '').trim();
    if (!normalizedPath) {
        throw new Error('No generated image path available for background.');
    }

    const cssUrl = `url("${encodeURI(normalizedPath)}")`;
    await eventSource.emit(event_types.FORCE_SET_BACKGROUND, { url: cssUrl, path: normalizedPath });
}

function injectSetBackgroundButtons() {
    $('.mes_img_container .mes_img_controls').each(function () {
        const $controls = $(this);
        if ($controls.find('.igc_set_background').length > 0) {
            return;
        }
        const $bgButton = $('<div title="Set as Background" class="right_menu_button fa-lg fa-solid fa-panorama igc_set_background"></div>');
        const $deleteBtn = $controls.find('.mes_media_delete');
        if ($deleteBtn.length > 0) {
            $deleteBtn.before($bgButton);
        } else {
            $controls.append($bgButton);
        }
    });
}

async function generateImage(overrideMode = null, customPrompt = null) {
    const settings = getSettings();
    const requestedMode = overrideMode !== null ? overrideMode : settings.mode;
    const mode = normalizeMode(Number(requestedMode));

    const $button = $('#igc_generate_button');
    const originalHtml = $button.html();
    $button.prop('disabled', true).html('<span class="igc-loading"></span> Generating...');

    try {
        const generatedPrompt = await generatePromptWithLLM(mode, customPrompt);
        const finalPrompt = buildFinalPrompt(generatedPrompt);
        const reviewResult = await showReviewPopup(finalPrompt);

        const applyAsBackground = mode === generationMode.BACKGROUND || reviewResult.asBackground;

        if (reviewResult.backend === backendType.OPENROUTER) {
            const aspectRatio = getSDSettingsAspectRatio();
            const imageData = await generateOpenRouterImage(reviewResult.prompt, reviewResult.model, aspectRatio);
            const savedImagePath = await saveAndDisplayImage(imageData, reviewResult.prompt);

            if (applyAsBackground) {
                try {
                    await applyGeneratedBackground(savedImagePath);
                    toastr.success('Image generated and set as background!');
                } catch (bgError) {
                    console.warn('[IGC] Failed to auto-apply generated background:', bgError);
                    toastr.warning('Image generated, but setting background failed.');
                }
            } else {
                toastr.success('Image generated successfully!');
            }
        } else {
            const imagePath = await executeSTImageGeneration(reviewResult.prompt);

            if (applyAsBackground) {
                let backgroundApplied = true;
                try {
                    await applyGeneratedBackground(imagePath);
                } catch (error) {
                    backgroundApplied = false;
                    console.warn('[IGC] Failed to auto-apply generated background:', error);
                    toastr.warning('Image generated, but setting background failed.');
                }

                if (backgroundApplied) {
                    toastr.success('Image generated and set as background!');
                } else {
                    toastr.success('Image generated successfully!');
                }
            } else {
                toastr.success('Image generated successfully!');
            }
        }
    } catch (error) {
        const message = String(error?.message || 'Unknown error');
        if (/aborted by user|canceled|cancelled/i.test(message)) {
            toastr.warning('Image generation canceled.');
        } else {
            toastr.error(`Generation failed: ${message}`);
        }
    } finally {
        $button.prop('disabled', false).html(originalHtml);
    }
}

function destroyModeDropdownPopper() {
    if (modeDropdownPopper && typeof modeDropdownPopper.destroy === 'function') {
        modeDropdownPopper.destroy();
    }
    modeDropdownPopper = null;
}

function hideModeDropdown() {
    const $dropdown = $(`#${modeDropdownId}`);
    if (!$dropdown.length) {
        return;
    }

    $dropdown.hide();
    destroyModeDropdownPopper();
}

function ensureModeDropdown() {
    let $dropdown = $(`#${modeDropdownId}`);
    if ($dropdown.length) {
        return $dropdown;
    }

    $dropdown = $('<div></div>')
        .attr('id', modeDropdownId)
        .addClass('igc-dropdown');

    const $list = $('<ul class="list-group"></ul>');
    const $title = $('<span class="igc-dropdown-title">Send me a picture of:</span>');
    $list.append($title);

    for (const mode of orderedModes) {
        const displayName = modeDisplayNames[mode] || `Mode ${mode}`;
        const $item = $('<li></li>')
            .addClass('list-group-item igc-dropdown-item')
            .attr('data-mode', mode)
            .text(displayName);
        $list.append($item);
    }

    $dropdown.append($list).hide();
    $dropdown.on('click', '.igc-dropdown-item', function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideModeDropdown();
        const selectedMode = Number($(this).attr('data-mode'));
        generateImage(selectedMode);
    });

    $(document.body).append($dropdown);
    return $dropdown;
}

function bindModeDropdownCloseHandler() {
    if (modeDropdownCloseHandlerBound) {
        return;
    }

    modeDropdownCloseHandlerBound = true;
    $(document).on('click touchend', function (e) {
        const $dropdown = $(`#${modeDropdownId}`);
        if (!$dropdown.length || !$dropdown.is(':visible')) {
            return;
        }

        const $target = $(e.target);
        if ($target.closest(`#${modeDropdownId}`).length || $target.closest(modeDropdownButtonSelector).length) {
            return;
        }

        hideModeDropdown();
    });

    $(window).on('resize', function () {
        const $dropdown = $(`#${modeDropdownId}`);
        if (!$dropdown.length || !$dropdown.is(':visible')) {
            return;
        }

        if (modeDropdownPopper && typeof modeDropdownPopper.update === 'function') {
            modeDropdownPopper.update();
        }
    });
}

function showModeDropdown($button) {
    if (!$button?.length) {
        return;
    }

    const $dropdown = ensureModeDropdown();
    bindModeDropdownCloseHandler();

    if ($dropdown.is(':visible')) {
        hideModeDropdown();
        return;
    }

    destroyModeDropdownPopper();
    if (Popper?.createPopper) {
        modeDropdownPopper = Popper.createPopper($button.get(0), $dropdown.get(0), {
            placement: 'top',
        });
    } else {
        const offset = $button.offset();
        if (offset) {
            $dropdown.css({
                left: `${offset.left}px`,
                top: `${Math.max(8, offset.top - 12)}px`,
            });
        }
    }

    $dropdown.show();
    if (modeDropdownPopper && typeof modeDropdownPopper.update === 'function') {
        modeDropdownPopper.update();
    }
}

function createChatButton() {
    if ($('#image_gen_clone_button').length > 0) {
        return true;
    }

    const $menuContainer = $('#sd_wand_container');
    if ($menuContainer.length > 0) {
        const $menuButton = $(`
            <div id="image_gen_clone_button" class="list-group-item flex-container flexGap5" title="Send me a picture of...">
                <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton"></div>
                <span>Generate Image (Clone)</span>
            </div>
        `);

        const $stopButton = $('#sd_stop_gen');
        if ($stopButton.length > 0) {
            $stopButton.before($menuButton);
        } else {
            $menuContainer.append($menuButton);
        }

        ensureModeDropdown();
        bindModeDropdownCloseHandler();

        $menuButton.on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            showModeDropdown($(this));
        });

        $menuButton.on('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            hideModeDropdown();
            showModePopup(e.pageX, e.pageY);
        });

        return true;
    }

    const containerSelectors = [
        '#leftSendForm',
        '#rightSendForm',
        '#send_form',
        '.send_form',
        '#form_sheld',
        '#sheld',
    ];

    let $container = null;
    for (const selector of containerSelectors) {
        const $el = $(selector);
        if ($el.length > 0) {
            $container = $el;
            break;
        }
    }

    if (!$container) {
        return false;
    }

    const $button = $(`
        <div id="image_gen_clone_button" class="mes_button interactable" tabindex="0" title="Send me a picture of...">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
        </div>
    `);

    const insertionSelectors = [
        '#send_but',
        '#option_regenerate',
        '#option_continue',
        '#options_button',
        '.options-content',
    ];

    let inserted = false;
    for (const selector of insertionSelectors) {
        const $target = $(selector);
        if ($target.length > 0) {
            $target.before($button);
            inserted = true;
            break;
        }
    }

    if (!inserted) {
        $container.append($button);
    }

    $button.on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideModeDropdown();
        generateImage();
    });

    $button.on('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        hideModeDropdown();
        showModePopup(e.pageX, e.pageY);
    });

    return true;
}

function showModePopup(x, y) {
    $('.igc-mode-popup').remove();
    const $popup = $('<div class="igc-mode-popup"></div>');

    for (const mode of orderedModes) {
        const displayName = modeDisplayNames[mode] || `Mode ${mode}`;
        const $item = $(`<div class="igc-mode-popup-item" data-mode="${mode}">${displayName}</div>`);
        $item.on('click', function () {
            const selectedMode = Number($(this).data('mode'));
            generateImage(selectedMode);
            $popup.remove();
        });
        $popup.append($item);
    }

    $popup.css({
        left: `${x}px`,
        top: `${y - $popup.outerHeight() - 10}px`,
    });

    $('body').append($popup);
    $(document).one('click', function () {
        $popup.remove();
    });
}

function parseMode(modeInput) {
    if (typeof modeInput === 'number') {
        return normalizeMode(modeInput);
    }

    if (typeof modeInput !== 'string') {
        return generationMode.CHARACTER;
    }

    const input = modeInput.trim().toLowerCase();
    for (const mode of orderedModes) {
        if (triggerWords[mode].includes(input)) {
            return mode;
        }
    }

    return generationMode.CHARACTER;
}

function isKnownModeKeyword(input) {
    const normalized = String(input).trim().toLowerCase();
    return Object.values(triggerWords).some(words => words.includes(normalized));
}

function getModeEnumList() {
    return orderedModes.flatMap(mode => triggerWords[mode]);
}

function normalizeSlashArg(unnamedArgs) {
    if (Array.isArray(unnamedArgs)) {
        return unnamedArgs.map(x => String(x ?? '')).join(' ').trim();
    }
    if (unnamedArgs === undefined || unnamedArgs === null) {
        return '';
    }
    return String(unnamedArgs).trim();
}

function registerSlashCommands() {
    if (slashCommandsRegistered) {
        return;
    }

    try {
        const context = getContext();
        const {
            SlashCommandParser,
            SlashCommand,
            SlashCommandArgument,
            SlashCommandNamedArgument,
            ARGUMENT_TYPE,
            registerSlashCommand,
        } = context;

        const commandHelp = 'Generate an image using default SillyTavern image-generation modes. Supported mode values: you, face, me, scene, last, raw_last, background. Free text is sent as a custom prompt to the AI.';
        const commandCallback = async (namedArgs, unnamedArg) => {
            const namedMode = namedArgs?.mode;
            const argText = normalizeSlashArg(unnamedArg);

            if (namedMode) {
                await generateImage(parseMode(namedMode), argText || null);
            } else if (argText && isKnownModeKeyword(argText)) {
                await generateImage(parseMode(argText));
            } else if (argText) {
                await generateImage(normalizeMode(getSettings().mode), argText);
            } else {
                await generateImage(normalizeMode(getSettings().mode));
            }
            return '';
        };

        if (SlashCommandParser && SlashCommand) {
            const commandProps = {
                name: 'imgclone',
                callback: commandCallback,
                aliases: ['igc'],
                helpString: commandHelp,
            };

            if (SlashCommandNamedArgument && ARGUMENT_TYPE) {
                commandProps.namedArgumentList = [
                    SlashCommandNamedArgument.fromProps({
                        name: 'mode',
                        description: `Generation mode: ${getModeEnumList().join(', ')}`,
                        typeList: [ARGUMENT_TYPE.STRING],
                    }),
                ];
            }

            if (SlashCommandArgument && ARGUMENT_TYPE) {
                commandProps.unnamedArgumentList = [
                    SlashCommandArgument.fromProps({
                        description: `Generation mode trigger (${getModeEnumList().join(', ')})`,
                        typeList: [ARGUMENT_TYPE.STRING],
                        isRequired: false,
                    }),
                ];
            }

            SlashCommandParser.addCommandObject(SlashCommand.fromProps(commandProps));
            slashCommandsRegistered = true;
            return;
        }

        // Legacy fallback for older ST versions exposing registerSlashCommand in context.
        if (typeof registerSlashCommand === 'function') {
            registerSlashCommand('imgclone', commandCallback, ['igc'], commandHelp);
            slashCommandsRegistered = true;
            return;
        }

        console.warn('[IGC] Slash command API unavailable; command registration skipped.');
    } catch (error) {
        console.error('[IGC] Error registering slash commands:', error);
    }
}

jQuery(async function () {
    loadSettings();
    registerSlashCommands();

    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        updateUIFromSettings();
        bindUIEvents();
    } catch (error) {
        console.error('[IGC] Failed to load settings UI:', error);
    }

    function tryCreateButton(attempts = 0) {
        if (attempts >= 10) {
            console.error('[IGC] Failed to create button after 10 attempts');
            return;
        }
        if (!createChatButton()) {
            setTimeout(() => tryCreateButton(attempts + 1), 1000);
        }
    }
    tryCreateButton();
    setTimeout(injectSetBackgroundButtons, 1000);

    eventSource.on(event_types.CHAT_CHANGED, function () {
        hideModeDropdown();
        setTimeout(createChatButton, 500);
        setTimeout(injectSetBackgroundButtons, 500);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function () {
        setTimeout(createChatButton, 100);
        setTimeout(injectSetBackgroundButtons, 100);
    });

    eventSource.on(event_types.USER_MESSAGE_RENDERED, function () {
        setTimeout(injectSetBackgroundButtons, 100);
    });

    eventSource.on(event_types.APP_READY, function () {
        hideModeDropdown();
        registerSlashCommands();
        setTimeout(createChatButton, 500);
        setTimeout(injectSetBackgroundButtons, 500);
    });

    $(document).on('click', '.igc_set_background', async function (e) {
        e.preventDefault();
        e.stopPropagation();

        const $container = $(this).closest('.mes_img_container');
        const $img = $container.find('img.mes_img');
        const imageSrc = $img.attr('src');

        if (!imageSrc) {
            toastr.warning('No image source found.');
            return;
        }

        try {
            await applyGeneratedBackground(imageSrc);
            toastr.success('Background set successfully!');
        } catch (error) {
            console.error('[IGC] Failed to set background:', error);
            toastr.error('Failed to set background.');
        }
    });
});

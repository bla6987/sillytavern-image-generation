import { getContext, extension_settings } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';
import { eventSource, event_types } from '../../../../script.js';
import { saveSettingsDebounced } from '../../../../script.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';

const extensionName = 'image_generation';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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

const defaultSettings = {
    mode: generationMode.CHARACTER,
    prefix: 'best quality, absurdres, aesthetic,',
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

    if (changed) {
        saveSettingsDebounced();
    }
}

function updateUIFromSettings() {
    const settings = getSettings();
    $('#igc_mode').val(settings.mode);
    $('#igc_prefix').val(settings.prefix);
}

function bindUIEvents() {
    $('#igc_mode').on('change', function () {
        getSettings().mode = normalizeMode(parseInt($(this).val()));
        saveSettings();
    });

    $('#igc_prefix').on('change', function () {
        getSettings().prefix = String($(this).val() || '');
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

async function generatePromptWithLLM(mode) {
    const template = promptTemplates[mode];

    if (!template) {
        throw new Error(`Unknown mode: ${mode}`);
    }

    const quietPrompt = processTemplate(template);
    const response = await callQuietPrompt(quietPrompt);
    const processed = processReply(response);

    if (!processed) {
        throw new Error('Prompt generation produced no text');
    }

    return processed;
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

async function executeSTImageGeneration(prompt) {
    try {
        const { executeSlashCommandsWithOptions } = await import('../../../slash-commands.js');
        const escapedPrompt = prompt.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
        await executeSlashCommandsWithOptions(`/sd raw=true "${escapedPrompt}"`);
    } catch (error) {
        throw new Error(`Failed to execute /sd command: ${error.message}`);
    }
}

async function generateImage(overrideMode = null) {
    const settings = getSettings();
    const requestedMode = overrideMode !== null ? overrideMode : settings.mode;
    const mode = normalizeMode(Number(requestedMode));

    const $button = $('#igc_generate_button');
    const originalHtml = $button.html();
    $button.prop('disabled', true).html('<span class="igc-loading"></span> Generating...');

    try {
        const generatedPrompt = await generatePromptWithLLM(mode);
        const finalPrompt = buildFinalPrompt(generatedPrompt);
        await executeSTImageGeneration(finalPrompt);
        toastr.success('Image generated successfully!');
    } catch (error) {
        toastr.error(`Generation failed: ${error.message}`);
    } finally {
        $button.prop('disabled', false).html(originalHtml);
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

        $menuButton.on('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            generateImage();
        });

        $menuButton.on('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
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
        generateImage();
    });

    $button.on('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
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

function getModeEnumList() {
    return orderedModes.flatMap(mode => triggerWords[mode]);
}

function registerSlashCommands() {
    try {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'imgclone',
            callback: async (namedArgs, unnamedArg) => {
                // Accept /imgclone, /imgclone mode=you, and /imgclone you.
                const modeInput = namedArgs?.mode ?? unnamedArg;
                const mode = modeInput !== undefined && String(modeInput).trim().length > 0
                    ? parseMode(String(modeInput))
                    : normalizeMode(getSettings().mode);
                await generateImage(mode);
                return 'Image generation started';
            },
            aliases: ['igc'],
            namedArgumentList: [
                SlashCommandNamedArgument.fromProps({
                    name: 'mode',
                    description: 'Generation mode: you, face, me, scene, last, raw_last, background',
                    typeList: [ARGUMENT_TYPE.STRING],
                }),
            ],
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'Generation mode trigger (you, face, me, scene, last, raw_last, background)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
            helpString: 'Generate an image using default SillyTavern image-generation modes. Supported mode values: you, face, me, scene, last, raw_last, background.',
        }));
    } catch (error) {
        console.error('[IGC] Error registering slash commands:', error);
    }
}

jQuery(async function () {
    loadSettings();

    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    updateUIFromSettings();
    bindUIEvents();

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

    registerSlashCommands();

    eventSource.on(event_types.CHAT_CHANGED, function () {
        setTimeout(createChatButton, 500);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, function () {
        setTimeout(createChatButton, 100);
    });

    eventSource.on(event_types.APP_READY, function () {
        setTimeout(createChatButton, 500);
    });
});

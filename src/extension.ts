import * as vscode from 'vscode';
import * as path from 'path';
import micromatch from 'micromatch';

// --- CONSTANTS: Factory Defaults ---
const FACTORY_DEFAULT_IGNORES = [
    // Source Control
    '**/.git/**', '**/.gitignore', '**/.gitattributes',
    
    // Dependencies & Locks
    '**/node_modules/**', '**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/bun.lockb', '**/bun.lock',
    
    // Build / Dist
    '**/dist/electron/**', '**/dist/capacitor/**', '**/build/**', '**/coverage/**', '**/.docker-build-context',
    
    // Python
    '**/__pycache__/**', '**/*.pyc', '**/*.pyo', '**/.venv/**',
    
    // Env & Logs
    '**/.DS_Store', '**/.env', '**/*.log',
    
    // Media / Binary
    '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.svg',
    '**/*.ico', '**/*.icns', '**/*.mp4', '**/*.mov', '**/*.avi', '**/*.pdf',
    '**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.eot',
    
    // Mobile
    '**/android/**', '**/ios/**',
    
    // Custom Project Specifics
    '**/images/**', '**/projects/**', '**/thoughts/**', '**/runtime/**',
    '**/*transpiled.mjs', '**/sip-0.21.2.js',
    "**/public/lib/**", "**/playwright-profile/**", "**/client/public/lib/**",

    // Output Files (Loop Prevention)
    '**/*-context.md', 'code-context.md', 'context.md'
].join('\n');

// --- INTERFACES ---
interface Profile {
    name: string;
    includes: string;
    ignores: string; 
    intro: string;
    alwaysAppendIncludes: boolean;
}

interface AppState {
    activeProfile: string;
    profiles: { [key: string]: Profile };
    defaultIgnores: string; 
}

interface GenerationOptions {
    includes: string;
    ignores: string;
    intro: string;
    alwaysAppendIncludes: boolean;
    defaultIgnores: string; 
}

// --- DEFAULTS ---
const DEFAULT_PROFILE: Profile = {
    name: 'Default',
    includes: '',
    ignores: '', 
    intro: '',
    alwaysAppendIncludes: false
};

const DEFAULT_STATE: AppState = {
    activeProfile: 'Default',
    profiles: { 'Default': DEFAULT_PROFILE },
    defaultIgnores: FACTORY_DEFAULT_IGNORES
};

let globalState: AppState = DEFAULT_STATE;

// ─── IGNORE / KEEP HELPERS (mirroring CLI logic) ──────────────────────────────

/**
 * Parse a newline-separated ignore string into separate arrays.
 * Lines starting with '!' are KEEP patterns (un-ignore).
 * Lines starting with '#' or empty lines are skipped.
 */
function parseIgnores(userIgnoreStr: string, defaultIgnoreStr: string) {
    const toLines = (s: string) =>
        s.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));

    const userLines   = toLines(userIgnoreStr);
    const defaultLines = toLines(defaultIgnoreStr);

    // '!' prefix → keep (un-ignore); strip the '!' for matching
    const userKeeps       = userLines.filter(s => s.startsWith('!')).map(s => s.slice(1));
    const userIgnoresOnly = userLines.filter(s => !s.startsWith('!'));

    // allIgnores = defaults + user ignores (keeps are NOT in here)
    const allIgnores = [...defaultLines, ...userIgnoresOnly];

    return { allIgnores, userKeeps, defaultLines, userIgnoresOnly };
}

/**
 * Check whether a path matches any of the supplied IGNORE patterns.
 * Tests both bare relPath and relPath+'/' so that directory globs like
 * `**\/node_modules\/**` match the directory entry itself (no trailing slash).
 */
function isMatch(relPath: string, patterns: string[]): boolean {
    if (patterns.length === 0) return false;
    const opts = { dot: true };
    return (
        micromatch.isMatch(relPath, patterns, opts) ||
        micromatch.isMatch(relPath + '/', patterns, opts)
    );
}

/**
 * Check whether a path matches any of the supplied KEEP patterns.
 *
 * Keep patterns written as bare filenames (e.g. `Transcoder.js`, no slashes)
 * must use `matchBase: true` so they match against the basename of any
 * nested path (e.g. `transcoding/Transcoder.js`).
 *
 * Patterns that already contain slashes or globs are matched normally.
 */
function isMatchKeep(relPath: string, keepPatterns: string[]): boolean {
    if (keepPatterns.length === 0) return false;
    const opts    = { dot: true };
    const baseopts = { dot: true, matchBase: true };
    return keepPatterns.some(pattern => {
        // Bare filename (no path separators, no glob **) → matchBase
        if (!pattern.includes('/') && !pattern.startsWith('**')) {
            return micromatch.isMatch(relPath, pattern, baseopts);
        }
        return (
            micromatch.isMatch(relPath, pattern, opts) ||
            micromatch.isMatch(relPath + '/', pattern, opts)
        );
    });
}

/**
 * Determine whether we should force-traverse an otherwise-ignored directory
 * because a keep pattern requires it.  Mirrors CLI `shouldForceTraversal()`.
 *
 * Rules:
 *  A) Global wildcard keep (e.g. `**\/AgentView.js`) → must enter almost any folder.
 *  B) Specific-path keep (e.g. `framework/src/core/**`) → enter only if the
 *     current folder is a parent of that keep path.
 *
 * DEFAULT-ignored directories (node_modules, .git, …) are NEVER force-traversed
 * by global wildcards — only by explicit child keeps.
 */
function shouldForceTraversal(
    relPath: string,
    keepPatterns: string[],
    isDefaultIgnored: boolean
): boolean {
    if (keepPatterns.length === 0) return false;

    return keepPatterns.some(pattern => {
        // Case A: Global wildcard  (e.g. **/AgentView.js  or  *.js)
        if (pattern.startsWith('**') || !pattern.includes('/')) {
            // Never force-traverse DEFAULT safety barriers (node_modules, .git, …)
            return !isDefaultIgnored;
        }

        // Case B: Specific path  (e.g. framework/src/client/core/**)
        const normalised = pattern.replace(/^\.\//, '');
        return normalised.startsWith(relPath + '/');
    });
}

// ─── ACTIVATE ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext) {
    
    // 1. LOAD STATE
    const saved = context.globalState.get<AppState>('contextGenState');
    if (saved) { 
        globalState = saved; 
        if (!globalState.defaultIgnores) {
            globalState.defaultIgnores = FACTORY_DEFAULT_IGNORES;
        }
    } else {
        globalState = DEFAULT_STATE;
    }

    // 2. COMMAND: Configure (UI)
    context.subscriptions.push(
        vscode.commands.registerCommand('context-generator.configure', () => {
            const panel = vscode.window.createWebviewPanel(
                'contextGenConfig', 
                'Context Generator Settings', 
                vscode.ViewColumn.One, 
                { enableScripts: true, retainContextWhenHidden: true }
            );

            const updateUI = () => { panel.webview.html = getWebviewContent(globalState); };
            updateUI();

            panel.webview.onDidReceiveMessage(async (msg) => {
                switch (msg.type) {
                    case 'save':
                        updateProfile(msg.profileName, msg.data);
                        globalState.defaultIgnores = msg.data.defaultIgnores;
                        await context.globalState.update('contextGenState', globalState);
                        vscode.window.showInformationMessage(`Settings Saved!`);
                        break;
                    
                    case 'switchProfile':
                        if (globalState.profiles[msg.profileName]) {
                            globalState.activeProfile = msg.profileName;
                            await context.globalState.update('contextGenState', globalState);
                            updateUI();
                        }
                        break;

                    case 'resetDefaults':
                        globalState.defaultIgnores = FACTORY_DEFAULT_IGNORES;
                        await context.globalState.update('contextGenState', globalState);
                        updateUI();
                        vscode.window.showInformationMessage("Global Defaults reset to Factory Settings.");
                        break;

                    case 'requestCreateProfile': {
                        const newName = await vscode.window.showInputBox({
                            placeHolder: "Enter profile name",
                            prompt: "Create a new configuration profile"
                        });
                        if (newName) {
                            if (globalState.profiles[newName]) {
                                vscode.window.showErrorMessage(`Profile "${newName}" already exists.`);
                            } else {
                                globalState.profiles[newName] = { ...DEFAULT_PROFILE, name: newName };
                                globalState.activeProfile = newName;
                                await context.globalState.update('contextGenState', globalState);
                                updateUI();
                                vscode.window.showInformationMessage(`Profile "${newName}" Created!`);
                            }
                        }
                        break;
                    }

                    case 'requestDeleteProfile': {
                        const selection = await vscode.window.showWarningMessage(
                            `Delete profile "${msg.profileName}"?`,
                            { modal: true },
                            "Delete"
                        );
                        if (selection === "Delete") {
                            if (msg.profileName !== 'Default' && globalState.profiles[msg.profileName]) {
                                delete globalState.profiles[msg.profileName];
                                globalState.activeProfile = 'Default';
                                await context.globalState.update('contextGenState', globalState);
                                updateUI();
                                vscode.window.showInformationMessage(`Profile "${msg.profileName}" Deleted.`);
                            } else {
                                vscode.window.showErrorMessage("Cannot delete Default profile.");
                            }
                        }
                        break;
                    }

                    case 'generateFromSettings': {
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (!workspaceFolders) {
                            vscode.window.showErrorMessage("No workspace open.");
                            return;
                        }
                        
                        updateProfile(msg.profileName, msg.data);
                        globalState.defaultIgnores = msg.data.defaultIgnores;
                        await context.globalState.update('contextGenState', globalState);

                        const overrideOptions: GenerationOptions = {
                            includes: msg.data.includes,
                            ignores: msg.data.ignores,
                            intro: msg.data.intro,
                            alwaysAppendIncludes: msg.data.alwaysAppendIncludes,
                            defaultIgnores: msg.data.defaultIgnores
                        };

                        vscode.commands.executeCommand(
                            'context-generator.generateFolder',
                            workspaceFolders[0].uri,
                            [],
                            overrideOptions
                        ); 
                        break;
                    }
                }
            });
        })
    );

    // 3. COMMAND: Open Files
    context.subscriptions.push(
        vscode.commands.registerCommand('context-generator.generateOpenFiles', async () => {
            const activeProfile = globalState.profiles[globalState.activeProfile];
            await generateContextForTabs(activeProfile, globalState.defaultIgnores);
        })
    );

    // 4. COMMAND: Selected Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('context-generator.generateFolder', async (
            uri: vscode.Uri,
            allUris?: vscode.Uri[],
            optionsOverride?: GenerationOptions
        ) => {
            const targets = allUris && allUris.length > 0 ? allUris : (uri ? [uri] : []);
            if (targets.length === 0) return;

            const options: GenerationOptions = optionsOverride ?? { 
                ...globalState.profiles[globalState.activeProfile], 
                defaultIgnores: globalState.defaultIgnores 
            };
            const isFromSettingsBtn = !!optionsOverride;

            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Generating Context...",
                cancellable: true
            }, async (progress, token) => {
                
                let combinedResult = options.intro ? `${options.intro}\n\n` : '';
                const workspaceRoot = vscode.workspace.workspaceFolders
                    ? vscode.workspace.workspaceFolders[0].uri
                    : targets[0];

                const { allIgnores, userKeeps } = parseIgnores(options.ignores, options.defaultIgnores);

                // A. GENERATE TARGETS
                for (const target of targets) {
                    const stat = await vscode.workspace.fs.stat(target);

                    if (stat.type === vscode.FileType.Directory) {
                        const effectiveIncludes = isFromSettingsBtn ? options.includes : ''; 
                        combinedResult += await generateFolderStructure(
                            target, options.ignores, options.defaultIgnores, effectiveIncludes, token, workspaceRoot
                        );
                    } else if (stat.type === vscode.FileType.File) {
                        const relPath = path.relative(workspaceRoot.fsPath, target.fsPath).split(path.sep).join('/');
                        const ignored = isMatch(relPath, allIgnores);
                        const kept   = userKeeps.length > 0 && isMatchKeep(relPath, userKeeps);

                        if (!ignored || kept) {
                            const doc = await vscode.workspace.openTextDocument(target);
                            combinedResult += `### ${path.basename(target.fsPath)}\n\`\`\`\n${doc.getText()}\n\`\`\`\n\n`;
                        }
                    }
                }

                // B. GENERATE "ALWAYS APPEND"
                if (options.alwaysAppendIncludes && !isFromSettingsBtn && options.includes.trim().length > 0) {
                    const appendResult = await generateFolderStructure(
                        workspaceRoot, options.ignores, options.defaultIgnores,
                        options.includes, token, workspaceRoot
                    );
                    if (appendResult) {
                        combinedResult += `\n\n--- Appended Global Includes ---\n\n`;
                        combinedResult += appendResult;
                    }
                }
                
                await showResult(combinedResult);
            });
        })
    );
}

// ─── LOGIC HELPERS ────────────────────────────────────────────────────────────

function updateProfile(name: string, data: any) {
    if (globalState.profiles[name]) {
        globalState.profiles[name] = {
            name,
            includes:            data.includes,
            ignores:             data.ignores,
            intro:               data.intro,
            alwaysAppendIncludes: data.alwaysAppendIncludes
        };
    }
}

async function generateContextForTabs(profile: Profile, defaultIgnoresStr: string) {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
    const { allIgnores, userKeeps } = parseIgnores(profile.ignores, defaultIgnoresStr);

    let content = profile.intro ? profile.intro + "\n\n" : "";
    content += "# Open Files Context\n\n";
    
    let count = 0;
    for (const tab of tabs) {
        if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file') {
            const uri     = tab.input.uri;
            const relPath = vscode.workspace.asRelativePath(uri, false);

            const ignored = isMatch(relPath, allIgnores);
            const kept    = userKeeps.length > 0 && isMatchKeep(relPath, userKeeps);

            if (ignored && !kept) continue;

            const doc = await vscode.workspace.openTextDocument(uri);
            content += `### ${path.basename(uri.fsPath)}\n\`\`\`\n${doc.getText()}\n\`\`\`\n\n`;
            count++;
        }
    }

    if (profile.alwaysAppendIncludes && profile.includes.trim().length > 0) {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders) {
            const tokenSource = new vscode.CancellationTokenSource();
            const appendResult = await generateFolderStructure(
                workspaceFolders[0].uri, profile.ignores, defaultIgnoresStr,
                profile.includes, tokenSource.token, workspaceFolders[0].uri
            );
            if (appendResult) {
                content += `\n\n--- Appended Global Includes ---\n\n${appendResult}`;
            }
        }
    }
    
    if (count === 0 && (!profile.alwaysAppendIncludes || profile.includes.trim().length === 0)) {
        vscode.window.showWarningMessage("No matching open files found.");
        return;
    }
    await showResult(content);
}

async function generateFolderStructure(
    rootDir: vscode.Uri, 
    userIgnoreStr: string,
    defaultIgnoreStr: string,
    includeStr: string, 
    token: vscode.CancellationToken,
    workspaceRoot: vscode.Uri
): Promise<string> {
    
    const includePatterns = includeStr
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0 && !s.startsWith('#'));

    const { allIgnores, userKeeps, defaultLines } = parseIgnores(userIgnoreStr, defaultIgnoreStr);

    // Returns [subtree, subFileContent] — empty strings if nothing was included.
    // This mirrors the CLI's approach: a directory only appears in the tree
    // if recursion actually produced output (prevents phantom empty dirs).
    async function walk(dir: vscode.Uri, depth: number): Promise<[string, string]> {
        if (token.isCancellationRequested) return ['', ''];
        
        let entries: [string, vscode.FileType][];
        try {
            entries = await vscode.workspace.fs.readDirectory(dir);
        } catch {
            return ['', ''];
        }

        // Dirs first, then files; alphabetical within each group
        entries.sort((a, b) =>
            a[1] === b[1]
                ? a[0].localeCompare(b[0])
                : a[1] === vscode.FileType.Directory ? -1 : 1
        );

        let localTree    = '';
        let localContent = '';

        for (const [name, type] of entries) {
            const fullUri = vscode.Uri.joinPath(dir, name);
            const relPath = path
                .relative(workspaceRoot.fsPath, fullUri.fsPath)
                .split(path.sep)
                .join('/');

            if (type === vscode.FileType.Directory) {
                // ── 1. Is this dir matched by any ignore pattern? ──────────────
                const ignoredByDefault = isMatch(relPath, defaultLines);
                const ignoredByUser    = isMatch(relPath, allIgnores); // includes defaults

                // ── 2. Is it explicitly kept? ──────────────────────────────────
                const keptExplicitly = userKeeps.length > 0 && isMatchKeep(relPath, userKeeps);

                // ── 3. Decide whether to enter ────────────────────────────────
                let shouldEnter: boolean;

                if (!ignoredByUser) {
                    shouldEnter = true;
                } else if (keptExplicitly) {
                    shouldEnter = true;
                } else {
                    // Ignored. A keep-pattern may force traversal, but DEFAULT
                    // safety barriers (node_modules, .git…) only yield to explicit
                    // child keeps — never to global bare-filename keeps.
                    shouldEnter = shouldForceTraversal(relPath, userKeeps, ignoredByDefault);
                }

                // ── 4. Include-pattern gate (optimization) ────────────────────
                if (shouldEnter && includePatterns.length > 0) {
                    const isDirectMatch = isMatch(relPath, includePatterns);
                    const isAncestor    = includePatterns.some(p => p.startsWith(relPath + '/'));
                    const isInside      = includePatterns.some(p => {
                        const base = p.replace(/\/\*\*$/, '').replace(/\/\*$/, '');
                        return relPath.startsWith(base + '/') || relPath === base;
                    });

                    if (!isDirectMatch && !isAncestor && !isInside) {
                        shouldEnter = false;
                    }
                }

                if (!shouldEnter) continue;

                // ── 5. Recurse first; only add to tree if content exists ───────
                // (Mirrors CLI: `if (subTree || subFileContents) { tree += dir }`)
                const [subTree, subContent] = await walk(fullUri, depth + 1);
                if (subTree || subContent) {
                    localTree += `${"│   ".repeat(depth)}├── ${name}/\n`;
                    localTree += subTree;
                    localContent += subContent;
                }

            } else if (type === vscode.FileType.File) {

                // ── 1. Safety + ignore check ───────────────────────────────────
                const ignored = isMatch(relPath, allIgnores);
                // Use isMatchKeep so bare filenames (e.g. 'Transcoder.js') match
                // against nested paths like 'transcoding/Transcoder.js'
                const kept    = userKeeps.length > 0 && isMatchKeep(relPath, userKeeps);

                if (ignored && !kept) continue;

                // ── 2. Include-pattern gate ────────────────────────────────────
                if (includePatterns.length > 0 && !isMatch(relPath, includePatterns)) {
                    continue;
                }

                localTree += `${"│   ".repeat(depth)}├── ${name}\n`;
                
                try {
                    const data = await vscode.workspace.fs.readFile(fullUri);
                    if (data.indexOf(0) !== -1) {
                        localContent += `\n### ${relPath}\n(Binary file skipped)\n`;
                    } else {
                        const text = new TextDecoder().decode(data);
                        const ext  = path.extname(name).slice(1).toLowerCase();
                        localContent += `\n### ${relPath}\n\`\`\`${ext || 'text'}\n${text}\n\`\`\`\n`;
                    }
                } catch {
                    localContent += `\n### ${relPath}\n(Error reading file)\n`;
                }
            }
        }

        return [localTree, localContent];
    }

    const [rootTree, rootContent] = await walk(rootDir, 0);
    
    if (rootContent.trim().length > 0) {
        return rootTree + "\n" + rootContent;
    }
    return "";
}

async function showResult(content: string) {
    const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
    await vscode.window.showTextDocument(doc);
}

// ─── UI GENERATOR ─────────────────────────────────────────────────────────────

function getWebviewContent(state: AppState): string {
    const active = state.profiles[state.activeProfile];
    const profileOptions = Object.keys(state.profiles).map(name => 
        `<option value="${name}" ${name === state.activeProfile ? 'selected' : ''}>${name}</option>`
    ).join('');

    const escapeHtml = (unsafe: string) =>
        unsafe
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");

    return `<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <style>
            body { font-family: sans-serif; padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
            
            .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 15px; }
            .tab { padding: 8px 15px; cursor: pointer; border-bottom: 2px solid transparent; font-weight: bold; opacity: 0.7; }
            .tab:hover { opacity: 1; }
            .tab.active { border-bottom-color: var(--vscode-focusBorder); opacity: 1; }
            .tab-content { display: none; }
            .tab-content.active { display: block; }

            .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 15px; margin-bottom: 20px; }
            .profile-controls { display: flex; gap: 10px; align-items: center; }
            select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 5px; }
            button { padding: 8px 12px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; }
            button:hover { background: var(--vscode-button-hoverBackground); }
            button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
            button.danger { background: #d32f2f; color: white; margin-top: 10px; }
            
            label { font-weight: bold; display: block; margin-top: 15px; font-size: 12px; }
            textarea { width: 100%; height: 100px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); font-family: monospace; margin-top: 5px; box-sizing: border-box; }
            .hint { font-size: 11px; opacity: 0.7; margin-bottom: 5px; }
            .checkbox-container { margin-top: 15px; display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: bold; }
        </style>
    </head>
    <body>
        <div class="header">
            <h2>Context Settings</h2>
            <div class="profile-controls">
                <select id="profileSelect">${profileOptions}</select>
                <button id="addProfileBtn" class="secondary" title="New Profile">+</button>
                <button id="delProfileBtn" class="secondary" title="Delete Profile" ${state.activeProfile === 'Default' ? 'disabled' : ''}>🗑️</button>
            </div>
        </div>

        <div class="tabs">
            <div class="tab active" data-tab="config">Configuration</div>
            <div class="tab" data-tab="defaults">Global Defaults</div>
        </div>

        <div id="config" class="tab-content active">
            <label>Include Patterns</label>
            <div class="hint">Glob patterns to include (e.g. <code>src/**</code>). One per line.</div>
            <textarea id="includes">${escapeHtml(active.includes)}</textarea>

            <div class="checkbox-container">
                <input type="checkbox" id="alwaysAppend" ${active.alwaysAppendIncludes ? 'checked' : ''}>
                <label for="alwaysAppend" style="margin:0; font-weight:normal;">Always append these includes to Open Files / Folder selections</label>
            </div>

            <label>User Ignore Patterns</label>
            <div class="hint">Additional patterns to ignore. Prefix with <code>!</code> to force-keep (un-ignore). One per line.</div>
            <textarea id="ignores" style="height: 120px;">${escapeHtml(active.ignores)}</textarea>

            <label>Intro Text</label>
            <textarea id="intro" style="height:60px">${escapeHtml(active.intro)}</textarea>

            <div style="display:flex; gap:10px; margin-top:20px;">
                <button id="saveBtn" style="flex:1;">💾 Save Settings</button>
                <button id="genBtn" style="flex:1;">⚡ Generate From Settings</button>
            </div>
        </div>

        <div id="defaults" class="tab-content">
            <label>Global Default Ignores</label>
            <div class="hint">These are applied to ALL profiles. You can edit them here.</div>
            <textarea id="defaultIgnores" style="height: 350px;">${escapeHtml(state.defaultIgnores)}</textarea>
            <button id="resetBtn" class="danger">Reset to Factory Defaults</button>
        </div>

        <script>
            const vscode = acquireVsCodeApi();
            
            // TABS LOGIC
            document.querySelectorAll('.tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
                    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                    tab.classList.add('active');
                    document.getElementById(tab.dataset.tab).classList.add('active');
                });
            });

            const profileSelect  = document.getElementById('profileSelect');
            const includes       = document.getElementById('includes');
            const ignores        = document.getElementById('ignores');
            const intro          = document.getElementById('intro');
            const alwaysAppend   = document.getElementById('alwaysAppend');
            const defaultIgnores = document.getElementById('defaultIgnores');

            const getData = () => ({ 
                includes:             includes.value, 
                ignores:              ignores.value, 
                intro:                intro.value,
                alwaysAppendIncludes: alwaysAppend.checked,
                defaultIgnores:       defaultIgnores.value
            });

            document.getElementById('saveBtn').addEventListener('click', () => {
                vscode.postMessage({ type: 'save', profileName: profileSelect.value, data: getData() });
            });

            profileSelect.addEventListener('change', () => {
                vscode.postMessage({ type: 'switchProfile', profileName: profileSelect.value });
            });

            document.getElementById('addProfileBtn').addEventListener('click', () => {
                vscode.postMessage({ type: 'requestCreateProfile' });
            });

            document.getElementById('delProfileBtn').addEventListener('click', () => {
                vscode.postMessage({ type: 'requestDeleteProfile', profileName: profileSelect.value });
            });

            document.getElementById('genBtn').addEventListener('click', () => {
                vscode.postMessage({ 
                    type: 'generateFromSettings', 
                    profileName: profileSelect.value, 
                    data: getData() 
                });
            });

            document.getElementById('resetBtn').addEventListener('click', () => {
                if (confirm("Are you sure you want to reset Global Defaults to factory settings?")) {
                    vscode.postMessage({ type: 'resetDefaults' });
                }
            });
        </script>
    </body>
    </html>`;
}

export function deactivate() {}
// @ts-check
// Onboarding wizard webview. The extension owns the state and sends all of it after every
// change; this script renders it and sends the user's choices back. All text from Azure DevOps
// is inserted with textContent, never as HTML.
(function () {
    const vscode = acquireVsCodeApi();
    const app = /** @type {HTMLElement} */ (document.getElementById('app'));
    const logo = app.dataset.logo || '';
    const version = app.dataset.version || '';

    /** @type {any} */
    let state = null;
    /** UI-only state that survives re-renders. */
    const ui = { showTenantInput: false, showOrgInput: false, teamFilter: '' };

    const FEATURES = [
        ['checklist', 'Work items', 'Browse, create and edit work items in the sidebar or a full editor.'],
        ['project', 'Kanban boards', 'Drag cards across columns on your team board.'],
        ['calendar', 'Sprints and backlogs', 'See the current sprint, capacity and backlog levels.'],
        ['search', 'Queries and search', 'Run saved queries and search work items.'],
        ['git-branch', 'Git integration', 'Create branches from work items and link commits.'],
        ['zap', 'Quick open', 'Jump to any work item with Ctrl+Shift+O.']
    ];

    const send = (/** @type {any} */ message) => vscode.postMessage(message);

    /**
     * Sets one of the attributes this page uses. Attribute names are fixed here, so data can
     * never become an event handler or a script URL; unknown names are ignored.
     * @param {HTMLElement} el
     * @param {string} name
     * @param {string} value
     */
    function setAttribute(el, name, value) {
        switch (name) {
            case 'id': el.setAttribute('id', value); break;
            case 'type': el.setAttribute('type', value); break;
            case 'for': el.setAttribute('for', value); break;
            case 'role': el.setAttribute('role', value); break;
            case 'title': el.setAttribute('title', value); break;
            case 'alt': el.setAttribute('alt', value); break;
            case 'width': el.setAttribute('width', value); break;
            case 'height': el.setAttribute('height', value); break;
            case 'placeholder': el.setAttribute('placeholder', value); break;
            case 'autocomplete': el.setAttribute('autocomplete', value); break;
            case 'spellcheck': el.setAttribute('spellcheck', value); break;
            case 'disabled': el.setAttribute('disabled', ''); break;
            case 'selected': el.setAttribute('selected', ''); break;
            case 'aria-hidden': el.setAttribute('aria-hidden', value); break;
            case 'aria-label': el.setAttribute('aria-label', value); break;
            case 'aria-pressed': el.setAttribute('aria-pressed', value); break;
            case 'data-keep': el.setAttribute('data-keep', ''); break;
            case 'src':
            case 'href':
                // Only the extension's own files and https links.
                if (/^(https:|vscode-webview:|vscode-resource:|file:)/i.test(value)) {
                    el.setAttribute(name === 'src' ? 'src' : 'href', value);
                }
                break;
        }
    }

    /**
     * Small DOM builder. Attributes starting with "on" become listeners; children may be
     * strings (inserted as text), nodes, arrays or falsy values (skipped).
     * @param {string} tag
     * @param {Record<string, any>} [attrs]
     * @param {...any} children
     * @returns {HTMLElement}
     */
    function h(tag, attrs, ...children) {
        const el = document.createElement(tag);
        for (const [key, value] of Object.entries(attrs || {})) {
            if (value === undefined || value === null || value === false) {
                continue;
            }
            if (key.startsWith('on') && typeof value === 'function') {
                el.addEventListener(key.slice(2).toLowerCase(), value);
            } else if (key === 'className') {
                el.className = value;
            } else if (key === 'value') {
                /** @type {any} */ (el).value = value;
            } else if (key === 'checked') {
                /** @type {any} */ (el).checked = !!value;
            } else {
                setAttribute(el, key, value === true ? '' : String(value));
            }
        }
        const add = (/** @type {any} */ child) => {
            if (child === undefined || child === null || child === false) {
                return;
            }
            if (Array.isArray(child)) {
                child.forEach(add);
            } else if (child instanceof Node) {
                el.appendChild(child);
            } else {
                el.appendChild(document.createTextNode(String(child)));
            }
        };
        children.forEach(add);
        return el;
    }

    const icon = (/** @type {string} */ name, extra = '') => h('span', { className: `codicon codicon-${name} ${extra}`.trim(), 'aria-hidden': 'true' });
    const spinner = (/** @type {string} */ text) => h('div', { className: 'loading', role: 'status' }, icon('loading', 'codicon-modifier-spin'), h('span', {}, text));

    function button(/** @type {string} */ label, /** @type {() => void} */ onClick, opts = {}) {
        const { kind = 'primary', iconName, disabled, id } = /** @type {any} */ (opts);
        return h('button', { className: `button ${kind}`, onClick, disabled, id, type: 'button' }, iconName ? icon(iconName) : null, h('span', {}, label));
    }

    function linkButton(/** @type {string} */ label, /** @type {() => void} */ onClick, id) {
        return h('button', { className: 'link', onClick, type: 'button', id }, label);
    }

    function errorBanner() {
        if (!state.error) {
            return null;
        }
        return h('div', { className: 'banner error', role: 'alert' }, icon('error'), h('span', {}, state.error));
    }

    // -----------------------------------------------------------------------------------------
    // Steps
    // -----------------------------------------------------------------------------------------

    function header(/** @type {string} */ title, /** @type {string} */ subtitle) {
        return h('header', { className: 'hero' },
            h('img', { src: logo, alt: '', className: 'logo', width: 56, height: 56 }),
            h('div', {},
                h('h1', {}, title),
                h('p', { className: 'subtitle' }, subtitle)));
    }

    function renderWelcome() {
        return [
            header('Welcome to ADO Boards', 'The extension is installed. Connect it to Azure DevOps to bring your work items, boards and sprints into VS Code.'),
            h('section', { className: 'features', 'aria-label': 'Features' },
                FEATURES.map(([name, title, text]) =>
                    h('div', { className: 'feature' }, icon(name), h('div', {}, h('h3', {}, title), h('p', {}, text))))),
            h('section', { className: 'auth' },
                h('h2', {}, 'How do you sign in to Azure DevOps?'),
                errorBanner(),
                h('div', { className: 'choices' },
                    h('button', { className: 'choice', type: 'button', id: 'auth-microsoft', onClick: () => send({ type: 'chooseAuth', method: 'microsoft' }) },
                        icon('azure'),
                        h('span', { className: 'choice-text' },
                            h('span', { className: 'choice-title' }, 'Microsoft account ', h('span', { className: 'badge' }, 'Recommended')),
                            h('span', { className: 'choice-desc' }, 'Work or school account through Microsoft Entra ID, including your organization’s single sign-on (SAML). Opens your browser.'))),
                    h('button', { className: 'choice', type: 'button', id: 'auth-pat', onClick: () => send({ type: 'chooseAuth', method: 'pat' }) },
                        icon('key'),
                        h('span', { className: 'choice-text' },
                            h('span', { className: 'choice-title' }, 'Personal access token'),
                            h('span', { className: 'choice-desc' }, 'Paste a token you created in Azure DevOps. Use this for Azure DevOps Server, or if your organization blocks sign-in from VS Code.'))))),
            h('footer', { className: 'footer' },
                linkButton('Skip setup', () => send({ type: 'dismiss' }), 'skip'),
                h('span', { className: 'muted' }, 'You can come back with “Azure DevOps: Get Started”.'),
                version ? h('span', { className: 'muted version' }, `v${version}`) : null)
        ];
    }

    function renderSigningIn() {
        return [
            header('Signing you in', 'Finish signing in with your Microsoft account in the browser window that opened.'),
            spinner('Waiting for sign-in…'),
            h('div', { className: 'actions' }, button('Cancel', () => send({ type: 'back' }), { kind: 'secondary' }))
        ];
    }

    function renderPat() {
        const busy = state.loading === 'organizations';
        const submit = () => {
            const pat = /** @type {HTMLInputElement} */ (document.getElementById('pat')).value;
            const orgInput = /** @type {HTMLInputElement | null} */ (document.getElementById('pat-org'));
            send({ type: 'submitPat', pat, organizationUrl: orgInput ? orgInput.value : undefined });
        };
        const onEnter = (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { submit(); } };
        return [
            header('Sign in with a personal access token', 'We only need the token. We’ll find your organizations with it.'),
            errorBanner(),
            h('div', { className: 'field' },
                h('label', { for: 'pat' }, 'Personal access token'),
                h('input', { id: 'pat', type: 'password', autocomplete: 'off', spellcheck: 'false', 'data-keep': '', onKeydown: onEnter, disabled: busy }),
                h('p', { className: 'hint' },
                    'Needs the Work Items (Read & write), Project and Team (Read) and Code (Read) scopes. Choose “All accessible organizations” so we can list them. ',
                    h('a', { href: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate' }, 'How to create a token'))),
            state.patNeedsOrganization
                ? h('div', { className: 'field' },
                    h('label', { for: 'pat-org' }, 'Organization URL'),
                    h('input', { id: 'pat-org', type: 'url', placeholder: 'https://dev.azure.com/your-organization', value: state.patOrganizationHint || '', 'data-keep': '', onKeydown: onEnter, disabled: busy }))
                : null,
            h('p', { className: 'hint' }, icon('lock'), ' The token is kept in VS Code’s secret storage, not in your settings.'),
            busy ? spinner('Checking the token…') : null,
            h('div', { className: 'actions' },
                button('Continue', submit, { iconName: 'arrow-right', disabled: busy, id: 'pat-continue' }),
                button('Back', () => send({ type: 'back' }), { kind: 'secondary' }))
        ];
    }

    function select(/** @type {string} */ id, /** @type {any[]} */ options, /** @type {string|undefined} */ selected, /** @type {(v: string) => void} */ onChange, disabled) {
        return h('select', { id, onChange: (/** @type {Event} */ e) => onChange(/** @type {HTMLSelectElement} */ (e.target).value), disabled },
            selected ? null : h('option', { value: '', selected: true, disabled: true }, 'Select…'),
            options.map(o => h('option', { value: o.value, selected: o.value === selected ? true : undefined }, o.label)));
    }

    function inlineInput(/** @type {string} */ id, /** @type {string} */ placeholder, /** @type {string} */ action, /** @type {(v: string) => void} */ onSubmit) {
        const submit = () => onSubmit(/** @type {HTMLInputElement} */ (document.getElementById(id)).value);
        return h('div', { className: 'inline-input' },
            h('input', { id, type: 'text', placeholder, 'data-keep': '', spellcheck: 'false', onKeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') { submit(); } } }),
            button(action, submit, { kind: 'secondary' }));
    }

    function note(/** @type {string|undefined} */ text) {
        return text ? h('p', { className: 'hint' }, icon('info'), ' ', text) : null;
    }

    function renderTenant() {
        if (state.authMethod !== 'microsoft') {
            return null;
        }
        const options = state.tenants.map((/** @type {any} */ t) => ({
            value: t.id,
            label: `${t.name}${t.domain && t.domain !== t.name ? ` (${t.domain})` : ''}${t.isHome ? ' — home directory' : ''}`
        }));
        return h('div', { className: 'field' },
            h('label', { for: 'tenant' }, icon('organization'), ' Directory (tenant)'),
            select('tenant', options, state.tenantId, v => send({ type: 'selectTenant', tenantId: v }), !!state.loading),
            h('div', { className: 'field-links' },
                state.loading === 'tenants' ? spinner('Looking for your other directories…') : null,
                state.canFindTenants && state.loading !== 'tenants' ? linkButton('Find my other directories', () => send({ type: 'findTenants' }), 'find-tenants') : null,
                linkButton(ui.showTenantInput ? 'Hide' : 'Enter a tenant ID or domain', () => { ui.showTenantInput = !ui.showTenantInput; render(); })),
            ui.showTenantInput ? inlineInput('tenant-input', 'contoso.onmicrosoft.com or tenant ID', 'Use', v => send({ type: 'addTenant', value: v })) : null);
    }

    function renderOrganization() {
        const loading = state.loading === 'organizations';
        return h('div', { className: 'field' },
            h('label', { for: 'organization' }, icon('globe'), ' Organization'),
            loading ? spinner('Finding your organizations…')
                : state.organizations.length
                    ? select('organization', state.organizations.map((/** @type {any} */ o) => ({ value: o.url, label: `${o.name}  ·  ${o.url}` })),
                        state.organizationUrl, v => send({ type: 'selectOrganization', url: v }), !!state.loading)
                    : null,
            loading ? null : note(state.organizationNote),
            loading ? null : h('div', { className: 'field-links' },
                linkButton(ui.showOrgInput ? 'Hide' : 'Enter an organization URL', () => { ui.showOrgInput = !ui.showOrgInput; render(); })),
            ui.showOrgInput && !loading ? inlineInput('org-input', 'https://dev.azure.com/your-organization', 'Use', v => send({ type: 'addOrganization', url: v })) : null);
    }

    function renderProject() {
        if (!state.organizationUrl || state.loading === 'organizations') {
            return null;
        }
        const loading = state.loading === 'projects';
        return h('div', { className: 'field' },
            h('label', { for: 'project' }, icon('project'), ' Project'),
            loading ? spinner('Loading projects…')
                : state.projects.length
                    ? select('project', state.projects.map((/** @type {any} */ p) => ({ value: p.id, label: p.name })), state.projectId,
                        v => send({ type: 'selectProject', projectId: v }), !!state.loading)
                    : null,
            loading ? null : note(state.projectNote));
    }

    function sendTeams(/** @type {string[]} */ ids, /** @type {string|undefined} */ primary) {
        send({ type: 'setTeams', teamIds: ids, primaryTeamId: primary });
    }

    function renderTeams() {
        if (!state.projectId || state.loading === 'projects' || state.loading === 'organizations') {
            return null;
        }
        if (state.loading === 'teams') {
            return h('div', { className: 'field' }, h('span', { className: 'label' }, icon('people'), ' Teams'), spinner('Finding your teams…'));
        }
        const filter = ui.teamFilter.trim().toLowerCase();
        const visible = state.teams.filter((/** @type {any} */ t) => !filter || t.name.toLowerCase().includes(filter));
        const selected = new Set(state.selectedTeamIds);
        const list = h('div', { className: 'teams', role: 'group', 'aria-label': 'Teams' },
            visible.map((/** @type {any} */ t) => {
                const isSelected = selected.has(t.id);
                const isPrimary = state.primaryTeamId === t.id;
                const checkboxId = `team-${t.id}`;
                return h('div', { className: `team${isSelected ? ' selected' : ''}` },
                    h('input', {
                        type: 'checkbox', id: checkboxId, checked: isSelected,
                        onChange: (/** @type {Event} */ e) => {
                            const checked = /** @type {HTMLInputElement} */ (e.target).checked;
                            const ids = state.teams.map((/** @type {any} */ x) => x.id).filter((/** @type {string} */ id) => id === t.id ? checked : selected.has(id));
                            sendTeams(ids, state.primaryTeamId);
                        }
                    }),
                    h('label', { for: checkboxId, className: 'team-name' },
                        t.name,
                        t.isMember ? h('span', { className: 'badge' }, 'Member') : null,
                        t.isDefault ? h('span', { className: 'badge subtle' }, 'Default') : null,
                        t.description ? h('span', { className: 'team-desc' }, t.description) : null),
                    isSelected && selected.size > 1
                        ? h('button', {
                            type: 'button', className: `primary-toggle${isPrimary ? ' on' : ''}`,
                            title: isPrimary ? 'Primary team: used for boards, backlogs and sprints' : 'Make this the primary team',
                            'aria-pressed': isPrimary ? 'true' : 'false',
                            onClick: () => sendTeams(state.selectedTeamIds, t.id)
                        }, icon(isPrimary ? 'star-full' : 'star-empty'), h('span', {}, isPrimary ? 'Primary' : 'Make primary'))
                        : null);
            }));
        return h('div', { className: 'field' },
            h('span', { className: 'label' }, icon('people'), ' Teams'),
            note(state.teamsNote),
            state.teams.length > 8
                ? h('input', {
                    id: 'team-filter', type: 'search', placeholder: 'Filter teams', 'data-keep': '', value: ui.teamFilter,
                    onInput: (/** @type {Event} */ e) => { ui.teamFilter = /** @type {HTMLInputElement} */ (e.target).value; render(); }
                })
                : null,
            state.teams.length ? list : null,
            selected.size > 1 ? h('p', { className: 'hint' }, 'Boards, backlogs and sprints open for the primary team.') : null);
    }

    function renderReview() {
        const ready = !state.loading && state.organizationUrl && state.projectId;
        return [
            header('Check your settings', 'We filled these in for you. Change anything that isn’t right, or just continue.'),
            h('div', { className: 'account' },
                icon(state.authMethod === 'pat' ? 'key' : 'account'),
                h('span', {}, state.authMethod === 'pat' ? 'Using a personal access token' : `Signed in as ${state.account || 'your Microsoft account'}`),
                linkButton('Use a different sign-in', () => send({ type: 'back' }))),
            errorBanner(),
            h('div', { className: 'form' }, renderTenant(), renderOrganization(), renderProject(), renderTeams()),
            h('div', { className: 'actions' },
                button('Looks good to me', () => send({ type: 'finish' }), { iconName: 'check', disabled: !ready, id: 'finish' }),
                linkButton('Skip setup', () => send({ type: 'dismiss' })))
        ];
    }

    function renderSaving() {
        return [header('Connecting', 'Saving your settings and connecting to Azure DevOps.'), spinner('Connecting…')];
    }

    function renderDone() {
        const org = state.organizations.find((/** @type {any} */ o) => o.url === state.organizationUrl);
        const project = state.projects.find((/** @type {any} */ p) => p.id === state.projectId);
        const teams = state.teams.filter((/** @type {any} */ t) => state.selectedTeamIds.includes(t.id));
        const primary = teams.find((/** @type {any} */ t) => t.id === state.primaryTeamId);
        const run = (/** @type {string} */ command) => send({ type: 'runCommand', command });
        return [
            h('header', { className: 'hero done' },
                h('span', { className: 'done-icon' }, icon('pass-filled')),
                h('div', {}, h('h1', {}, 'You’re all set'), h('p', { className: 'subtitle' }, 'ADO Boards is connected. Your views in the Azure DevOps sidebar are loading now.'))),
            h('dl', { className: 'summary' },
                h('dt', {}, 'Organization'), h('dd', {}, org ? org.name : state.organizationUrl),
                h('dt', {}, 'Project'), h('dd', {}, project ? project.name : ''),
                teams.length ? [h('dt', {}, teams.length > 1 ? 'Teams' : 'Team'),
                    h('dd', {}, teams.map((/** @type {any} */ t) => t.name).join(', '), primary && teams.length > 1 ? ` (primary: ${primary.name})` : '')] : null),
            h('div', { className: 'actions' },
                button('Open board', () => run('azureDevOps.openBoardPanel'), { iconName: 'project', id: 'open-board' }),
                button('Open work items', () => run('azureDevOps.openWorkItemsPanel'), { kind: 'secondary', iconName: 'checklist' }),
                button('Show sidebar', () => run('workbench.view.extension.azure-devops'), { kind: 'secondary', iconName: 'layout-sidebar-left' }),
                linkButton('Close', () => run('close'))),
            h('p', { className: 'hint' }, 'Change these later with “Azure DevOps: Get Started”, or the Select Project and Select Team commands.')
        ];
    }

    // -----------------------------------------------------------------------------------------
    // Render loop
    // -----------------------------------------------------------------------------------------

    function render() {
        if (!state) {
            return;
        }
        // Keep typed values and focus across re-renders.
        const kept = new Map();
        app.querySelectorAll('[data-keep]').forEach(el => kept.set(el.id, /** @type {HTMLInputElement} */ (el).value));
        const active = /** @type {HTMLElement | null} */ (document.activeElement);
        const activeId = active && active.id ? active.id : undefined;
        const selection = active instanceof HTMLInputElement && active.type !== 'checkbox'
            ? [active.selectionStart, active.selectionEnd] : undefined;

        const views = new Map([
            ['welcome', renderWelcome], ['signingIn', renderSigningIn], ['pat', renderPat],
            ['review', renderReview], ['saving', renderSaving], ['done', renderDone]
        ]);
        const step = views.has(state.step) ? state.step : 'welcome';
        const view = views.get(step) || renderWelcome;
        app.replaceChildren(h('div', { className: `step step-${step}` }, view()));

        kept.forEach((value, id) => {
            const el = /** @type {HTMLInputElement | null} */ (document.getElementById(id));
            if (el && value) {
                el.value = value;
            }
        });
        const toFocus = activeId ? document.getElementById(activeId) : null;
        if (toFocus && !(/** @type {any} */ (toFocus).disabled)) {
            toFocus.focus();
            if (selection && toFocus instanceof HTMLInputElement) {
                try { toFocus.setSelectionRange(selection[0], selection[1]); } catch { /* not a text input */ }
            }
        } else if (state.step === 'pat') {
            const pat = document.getElementById('pat');
            if (pat && !(/** @type {any} */ (pat).disabled)) { pat.focus(); }
        }
    }

    let lastStep = '';
    window.addEventListener('message', event => {
        // Only the extension (through the VS Code webview host, same origin) sends messages.
        if (event.origin !== window.origin && !String(event.origin).startsWith('vscode-webview://')) {
            return;
        }
        const message = event.data;
        if (message && message.type === 'state') {
            state = message.state;
            if (state.step !== lastStep) {
                // A new step starts clean.
                ui.showTenantInput = false;
                ui.showOrgInput = false;
                ui.teamFilter = '';
                lastStep = state.step;
                app.replaceChildren();
            }
            render();
        }
    });

    send({ type: 'ready' });
})();

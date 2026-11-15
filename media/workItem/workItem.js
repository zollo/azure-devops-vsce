// Work item panel script. Loaded with a nonce; the extension passes data in #work-item-data.
const WORK_ITEM_DATA = JSON.parse(document.getElementById('work-item-data').textContent);
// Handlers used only in markup this script builds (tag suggestions)
allowWebviewHandlers(['selectTag', 'removeTag', 'handleTagInput', 'handleTagKeydown', 'showTagSuggestions', 'hideTagSuggestions']);
const vscode = acquireVsCodeApi();
// Record which item this tab shows, so VS Code can reopen it after a window reload
vscode.setState(Object.assign({}, vscode.getState() || {}, { workItemId: WORK_ITEM_DATA.workItemId }));
console.log('WorkItem panel script loaded');

function showDescriptionEditor() {
    const display = document.getElementById('descriptionDisplay');
    const container = document.getElementById('descriptionEditorContainer');

    // Guard: prevent selection-change from hiding the editor while we're opening it
    descriptionEditorOpening = true;

    // Load current content from display into editor
    const currentHtml = display.innerHTML;
    if (currentHtml && !currentHtml.includes('Click to add description')) {
        descriptionQuill.setContents([]);
        descriptionQuill.clipboard.dangerouslyPasteHTML(0, currentHtml);
    }

    display.style.display = 'none';
    container.classList.add('show');
    // Explicitly show the toolbar
    if (descToolbarEl) descToolbarEl.style.display = 'block';
    setTimeout(() => {
        descriptionQuill.focus();
        descriptionEditorOpening = false;
    }, 150);
}

function hideDescriptionEditor() {
    const html = editorHtml(descriptionQuill);
    const text = descriptionQuill.getText().trim();
    const display = document.getElementById('descriptionDisplay');
    const container = document.getElementById('descriptionEditorContainer');

    container.classList.remove('show');
    setTimeout(() => {
        // Check if editor is actually empty by checking text content
        if (!text || text.length === 0) {
            display.innerHTML = '<span style="color: var(--vscode-input-placeholderForeground);">Click to add description...</span>';
        } else {
            display.innerHTML = html;
        }
        display.style.display = 'block';
    }, 300);

    // Only save if user actually edited the description
    if (descriptionDirty) {
        const title = document.getElementById('title').value;
        const acceptanceCriteria = acceptanceCriteriaQuill ? editorHtml(acceptanceCriteriaQuill) : '';
        vscode.postMessage({ command: 'save', data: { title, description: html, acceptanceCriteria } });
        descriptionDirty = false;
    }
}

function showAcceptanceCriteriaEditor() {
    const display = document.getElementById('acceptanceCriteriaDisplay');
    const container = document.getElementById('acceptanceCriteriaEditorContainer');

    // Guard: prevent selection-change from hiding the editor while we're opening it
    acceptanceCriteriaEditorOpening = true;

    // Load current content from display into editor
    const currentHtml = display.innerHTML;
    if (currentHtml && !currentHtml.includes('Click to add acceptance criteria')) {
        acceptanceCriteriaQuill.setContents([]);
        acceptanceCriteriaQuill.clipboard.dangerouslyPasteHTML(0, currentHtml);
    }

    display.style.display = 'none';
    container.classList.add('show');
    // Explicitly show the toolbar
    if (acToolbarEl) acToolbarEl.style.display = 'block';
    setTimeout(() => {
        acceptanceCriteriaQuill.focus();
        acceptanceCriteriaEditorOpening = false;
    }, 150);
}

function hideAcceptanceCriteriaEditor() {
    const html = editorHtml(acceptanceCriteriaQuill);
    const text = acceptanceCriteriaQuill.getText().trim();
    const display = document.getElementById('acceptanceCriteriaDisplay');
    const container = document.getElementById('acceptanceCriteriaEditorContainer');

    container.classList.remove('show');
    setTimeout(() => {
        // Check if editor is actually empty by checking text content
        if (!text || text.length === 0) {
            display.innerHTML = '<span style="color: var(--vscode-input-placeholderForeground);">Click to add acceptance criteria...</span>';
        } else {
            display.innerHTML = html;
        }
        display.style.display = 'block';
    }, 300);

    // Only save if user actually edited the acceptance criteria
    if (acceptanceCriteriaDirty) {
        const title = document.getElementById('title').value;
        const description = descriptionQuill ? editorHtml(descriptionQuill) : '';
        vscode.postMessage({ command: 'save', data: { title, description, acceptanceCriteria: html } });
        acceptanceCriteriaDirty = false;
    }
}

function toggleMenu(event) {
    event.stopPropagation();
    const menu = document.getElementById('menuDropdown');
    const open = menu.style.display === 'none';
    menu.style.display = open ? 'block' : 'none';
    const button = document.getElementById('menuButton');
    if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
        const first = menu.querySelector('[role="menuitem"]');
        if (first) first.focus();
    }
}

// Arrow keys move through the open menu; Escape closes it and returns to the menu button
document.addEventListener('keydown', function(event) {
    const menu = document.getElementById('menuDropdown');
    if (!menu || menu.style.display === 'none' || !menu.contains(event.target)) return;
    const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
    const index = items.indexOf(event.target);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        items[(index + step + items.length) % items.length].focus();
    } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        hideMenu();
        const button = document.getElementById('menuButton');
        if (button && event.key === 'Escape') button.focus();
    }
});

function menuOpenInBrowser() {
    openInBrowser();
    hideMenu();
}

function menuRefresh() {
    refresh();
    hideMenu();
}

function hideMenu() {
    document.getElementById('menuDropdown').style.display = 'none';
    const button = document.getElementById('menuButton');
    if (button) button.setAttribute('aria-expanded', 'false');
}

document.addEventListener('click', function() {
    hideMenu();
});

function saveTitleOnBlur() {
    const title = document.getElementById('title').value;
    const description = descriptionQuill ? editorHtml(descriptionQuill) : '';
    const acceptanceCriteria = acceptanceCriteriaQuill ? editorHtml(acceptanceCriteriaQuill) : '';
    vscode.postMessage({ command: 'save', data: { title, description, acceptanceCriteria } });
}

function saveWorkItem() {
    const title = document.getElementById('title').value;
    const description = descriptionQuill ? editorHtml(descriptionQuill) : '';
    const acceptanceCriteria = acceptanceCriteriaQuill ? editorHtml(acceptanceCriteriaQuill) : '';
    vscode.postMessage({ command: 'save', data: { title, description, acceptanceCriteria } });
}

function changeState(state) {
    vscode.postMessage({ command: 'changeState', state });
}

let quill;
/**
 * The editor's content as standard HTML for Azure DevOps. Quill 2's own markup (root.innerHTML)
 * writes bullet lists as <ol data-list="bullet">, so use getSemanticHTML, which also turns every
 * space into &nbsp; in 2.0.x; put those back so text still wraps.
 */
function editorHtml(editor) {
    return editor.getSemanticHTML().replace(/&nbsp;/g, ' ');
}

let descriptionQuill;
let acceptanceCriteriaQuill;
let editQuills = {};
let descriptionDirty = false;
let acceptanceCriteriaDirty = false;
let descriptionEditorOpening = false;
let acceptanceCriteriaEditorOpening = false;
let descToolbarEl = null;
let acToolbarEl = null;

function initQuill() {
    try {
        console.log('Starting Quill initialization...');
        // Initialize description editor
        console.log('Initializing description editor...');
        descriptionQuill = new Quill('#descriptionEditor', {
        theme: 'snow',
        placeholder: 'Add a clear description...',
        modules: {
            toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ color: [] }, { background: [] }],
                [{ align: [] }],
                [{ list: 'ordered'}, { list: 'bullet' }, { indent: '-1'}, { indent: '+1' }],
                ['blockquote', 'code-block'],
                ['link'],
                ['clean']
            ]
        }
    });
    console.log('Description editor created');

    // Set initial content using Quill's API to avoid Delta model crash
    const descriptionContent = WORK_ITEM_DATA.description;
    if (descriptionContent) {
        descriptionQuill.clipboard.dangerouslyPasteHTML(0, descriptionContent);
    }

    // Track user edits to description (only 'user' source means the user typed)
    descriptionQuill.on('text-change', function(delta, oldDelta, source) {
        if (source === 'user') {
            descriptionDirty = true;
        }
    });

    // Hide toolbar after Quill finishes rendering
    setTimeout(() => {
        const descContainer = document.querySelector('#descriptionEditor');
        descToolbarEl = descContainer ? descContainer.previousElementSibling : null;
        if (descToolbarEl && descToolbarEl.classList.contains('ql-toolbar')) {
            descToolbarEl.style.display = 'none';

            descriptionQuill.on('selection-change', function(range) {
                // Skip if editor is in the process of opening
                if (descriptionEditorOpening) return;
                if (!range && descToolbarEl) {
                    descToolbarEl.style.display = 'none';
                    hideDescriptionEditor();
                } else if (range && descToolbarEl) {
                    descToolbarEl.style.display = 'block';
                }
            });
        }
    }, 100);

    // Initialize acceptance criteria editor
    console.log('Initializing acceptance criteria editor...');
    acceptanceCriteriaQuill = new Quill('#acceptanceCriteriaEditor', {
        theme: 'snow',
        placeholder: 'Add acceptance criteria...',
        modules: {
            toolbar: [
                [{ header: [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ color: [] }, { background: [] }],
                [{ align: [] }],
                [{ list: 'ordered'}, { list: 'bullet' }, { indent: '-1'}, { indent: '+1' }],
                ['blockquote', 'code-block'],
                ['link'],
                ['clean']
            ]
        }
    });
    console.log('Acceptance criteria editor created');

    // Set initial acceptance criteria content using Quill's API
    const acceptanceCriteriaContent = WORK_ITEM_DATA.acceptanceCriteria;
    if (acceptanceCriteriaContent) {
        acceptanceCriteriaQuill.clipboard.dangerouslyPasteHTML(0, acceptanceCriteriaContent);
    }

    // Track user edits to acceptance criteria
    acceptanceCriteriaQuill.on('text-change', function(delta, oldDelta, source) {
        if (source === 'user') {
            acceptanceCriteriaDirty = true;
        }
    });

    // Hide acceptance criteria toolbar initially
    setTimeout(() => {
        const acContainer = document.querySelector('#acceptanceCriteriaEditor');
        acToolbarEl = acContainer ? acContainer.previousElementSibling : null;
        if (acToolbarEl && acToolbarEl.classList.contains('ql-toolbar')) {
            acToolbarEl.style.display = 'none';

            acceptanceCriteriaQuill.on('selection-change', function(range) {
                // Skip if editor is in the process of opening
                if (acceptanceCriteriaEditorOpening) return;
                if (!range && acToolbarEl) {
                    acToolbarEl.style.display = 'none';
                    hideAcceptanceCriteriaEditor();
                } else if (range && acToolbarEl) {
                    acToolbarEl.style.display = 'block';
                }
            });
        }
    }, 100);

    // Initialize comment editor (always show toolbar)
    console.log('Initializing comment editor...');
    quill = new Quill('#commentEditor', {
        theme: 'snow',
        placeholder: 'Write a comment... (supports rich text formatting)',
        modules: {
            toolbar: {
                container: [
                    [{ header: [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ color: [] }, { background: [] }],
                    [{ align: [] }],
                    [{ list: 'ordered'}, { list: 'bullet' }, { indent: '-1'}, { indent: '+1' }],
                    ['blockquote', 'code-block'],
                    ['link', 'image'],
                    ['clean']
                ],
                handlers: {
                    image: imageHandler
                }
            }
        }
    });

    // Hide comment toolbar initially, show on focus
    console.log('Comment editor initialized');
    setTimeout(() => {
        const commentContainer = document.querySelector('#commentEditor');
        const commentToolbar = commentContainer ? commentContainer.previousElementSibling : null;
        const addCommentBtn = document.getElementById('addCommentBtn');
        
        if (commentToolbar && commentToolbar.classList.contains('ql-toolbar')) {
            commentToolbar.style.display = 'none';
            commentToolbar.style.transition = 'all 0.3s ease';
            
            quill.on('selection-change', function(range) {
                if (range) {
                    commentToolbar.style.display = 'block';
                    if (addCommentBtn) {
                        addCommentBtn.style.display = 'block';
                        setTimeout(() => addCommentBtn.classList.add('show'), 10);
                    }
                } else {
                    commentToolbar.style.display = 'none';
                    if (addCommentBtn) {
                        addCommentBtn.classList.remove('show');
                        setTimeout(() => addCommentBtn.style.display = 'none', 300);
                    }
                }
            });
        }
    }, 100);
} catch (error) {
    console.error('Error initializing Quill:', error);
    console.error('Error details:', error.message, error.stack);
}
    }

function imageHandler() {
    const input = document.createElement('input');
    input.setAttribute('type', 'file');
    input.setAttribute('accept', 'image/*');
    input.click();

    input.onchange = () => {
        const file = input.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => {
                vscode.postMessage({ 
                    command: 'uploadImage', 
                    imageData: e.target.result 
                });
            };
            reader.readAsDataURL(file);
        }
    };
}

window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'imageUploaded') {
        const range = quill.getSelection(true);
        quill.insertEmbed(range.index, 'image', message.url);
    }
});

function editComment(commentId) {
    const commentDiv = document.getElementById('comment-' + commentId);
    const editDiv = document.getElementById('edit-' + commentId);
    commentDiv.style.display = 'none';
    editDiv.style.display = 'block';
    
    if (!editQuills[commentId]) {
        editQuills[commentId] = new Quill('#editor-' + commentId, {
            theme: 'snow',
            modules: {
                toolbar: [
                    [{ header: [1, 2, 3, false] }],
                    ['bold', 'italic', 'underline', 'strike'],
                    [{ color: [] }, { background: [] }],
                    [{ align: [] }],
                    [{ list: 'ordered'}, { list: 'bullet' }, { indent: '-1'}, { indent: '+1' }],
                    ['blockquote', 'code-block'],
                    ['link', 'image'],
                    ['clean']
                ]
            }
        });
        editQuills[commentId].clipboard.dangerouslyPasteHTML(0, commentDiv.innerHTML);
    }
}

function saveEdit(commentId) {
    const editor = editQuills[commentId];
    if (!editor) return;
    
    const html = editorHtml(editor);
    const text = editor.getText().trim();
    
    if (text) {
        vscode.postMessage({ command: 'updateComment', commentId: commentId, comment: html });
    }
}

function cancelEdit(commentId) {
    const commentDiv = document.getElementById('comment-' + commentId);
    const editDiv = document.getElementById('edit-' + commentId);
    
    commentDiv.style.display = 'block';
    editDiv.style.display = 'none';
}

function deleteComment(commentId) {
    vscode.postMessage({ command: 'deleteComment', commentId: commentId });
}

function addComment() {
    if (!quill) return;
    let html = editorHtml(quill);
    const text = quill.getText().trim();
    
    // Remove base64 images (they cause 500 errors)
    html = html.replace(/<img[^>]+src="data:image[^>]+>/gi, '<p>[Image removed - use attachment upload instead]</p>');
    
    if (text) {
        vscode.postMessage({ command: 'addComment', comment: html });
        quill.setContents([]);
    }
}

// Initialize Quill after page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQuill);
} else {
    initQuill();
}

function refresh() {
    vscode.postMessage({ command: 'refresh' });
}

function openInBrowser() {
    vscode.postMessage({ command: 'openInBrowser' });
}

function assignToMe() {
    vscode.postMessage({ command: 'assignToMe' });
}

function scrollToState() {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const section = document.getElementById('stateSection');
    section.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
    // Move focus with the scroll so keyboard users land on the state buttons
    const current = section.querySelector('.state-option.active') || section.querySelector('.state-option');
    if (current) current.focus({ preventScroll: true });
}

function openLinkedItem(id) {
    vscode.postMessage({ command: 'openLinkedItem', id });
}

function updateAssignee() {
    console.log('updateAssignee called');
    const select = document.getElementById('assigneeSelect');
    console.log('Assignee select element:', select);
    console.log('Selected value:', select.value);
    vscode.postMessage({ command: 'assignTo', uniqueName: select.value });
}

function updatePriority(priority) {
    console.log('updatePriority called:', priority);
    document.querySelectorAll('.priority-btn').forEach(btn => {
        const on = btn.classList.contains('p' + priority);
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    vscode.postMessage({ command: 'updateField', field: 'Microsoft.VSTS.Common.Priority', value: priority });
}

function updateEffort() {
    console.log('updateEffort called');
    const input = document.getElementById('effortInput');
    const value = input.value ? parseFloat(input.value) : null;
    console.log('Effort value:', value);
    // Try both field names for story points
    vscode.postMessage({ command: 'updateField', field: 'Microsoft.VSTS.Scheduling.StoryPoints', value: value });
}

function toggleIterationDropdown() {
    const list = document.getElementById('iterationDropdownList');
    const wrapper = document.getElementById('iterationDropdownWrapper');
    const isOpen = list.classList.contains('open-left') || list.classList.contains('open-right');

    // Close any other open dropdowns first
    document.querySelectorAll('.iteration-dropdown-list.open-left, .iteration-dropdown-list.open-right').forEach(el => {
        el.classList.remove('open-left', 'open-right');
    });

    if (!isOpen) {
        // Calculate available space on left and right
        const rect = wrapper.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const spaceOnRight = viewportWidth - rect.right;
        const spaceOnLeft = rect.left;
        const dropdownWidth = 350; // min-width of dropdown

        // Open to the side with more space, preferring left if both are insufficient
        if (spaceOnLeft >= dropdownWidth || spaceOnLeft > spaceOnRight) {
            list.classList.add('open-left');
        } else {
            list.classList.add('open-right');
        }
    }
}

function selectIteration(path, name) {
    console.log('[WorkItemPanel - WebView] selectIteration called with path:', path, 'name:', name);
    const btn = document.getElementById('iterationDropdownBtn');
    const list = document.getElementById('iterationDropdownList');
    btn.textContent = name;
    list.classList.remove('open-left', 'open-right');
    // Update selected state
    list.querySelectorAll('.iteration-dropdown-item').forEach(item => item.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    console.log('[WorkItemPanel - WebView] Sending updateField message with path:', path);
    vscode.postMessage({ command: 'updateField', field: 'System.IterationPath', value: path || null });
}

function selectIterationFromData(element) {
    const path = element.dataset.path;
    const name = element.dataset.name;
    console.log('[WorkItemPanel - WebView] selectIterationFromData called with path:', path, 'name:', name);
    const btn = document.getElementById('iterationDropdownBtn');
    const list = document.getElementById('iterationDropdownList');
    btn.textContent = name;
    list.classList.remove('open-left', 'open-right');
    // Update selected state
    list.querySelectorAll('.iteration-dropdown-item').forEach(item => item.classList.remove('selected'));
    element.classList.add('selected');
    console.log('[WorkItemPanel - WebView] Sending updateField message with path:', path);
    vscode.postMessage({ command: 'updateField', field: 'System.IterationPath', value: path || null });
}

function toggleAreaDropdown() {
    const list = document.getElementById('areaDropdownList');
    const wrapper = document.getElementById('areaDropdownWrapper');
    const isOpen = list.classList.contains('open-left') || list.classList.contains('open-right');

    // Close any other open dropdowns first
    document.querySelectorAll('.iteration-dropdown-list.open-left, .iteration-dropdown-list.open-right, .area-dropdown-list.open-left, .area-dropdown-list.open-right').forEach(el => {
        el.classList.remove('open-left', 'open-right');
    });

    if (!isOpen) {
        // Calculate available space on left and right
        const rect = wrapper.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const spaceOnRight = viewportWidth - rect.right;
        const spaceOnLeft = rect.left;
        const dropdownWidth = 300; // min-width of dropdown

        // Open to the side with more space, preferring left if both are insufficient
        if (spaceOnLeft >= dropdownWidth || spaceOnLeft > spaceOnRight) {
            list.classList.add('open-left');
        } else {
            list.classList.add('open-right');
        }
    }
}

function selectArea(path) {
    console.log('[WorkItemPanel - WebView] selectArea called with path:', path);
    const btn = document.getElementById('areaDropdownBtn');
    const list = document.getElementById('areaDropdownList');
    // Display only the last segment (e.g., "DevOps" instead of "Experian Verifications\DevOps")
    const displayName = path.split('\\').pop() || path;
    btn.textContent = displayName;
    list.classList.remove('open-left', 'open-right');
    // Update selected state
    list.querySelectorAll('.area-dropdown-item').forEach(item => item.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    console.log('[WorkItemPanel - WebView] Sending updateField message with path:', path);
    vscode.postMessage({ command: 'updateField', field: 'System.AreaPath', value: path });
}

function selectAreaFromData(element) {
    const path = element.dataset.path;
    const name = element.dataset.name;
    console.log('[WorkItemPanel - WebView] selectAreaFromData called with path:', path, 'name:', name);
    const btn = document.getElementById('areaDropdownBtn');
    const list = document.getElementById('areaDropdownList');
    btn.textContent = name;
    list.classList.remove('open-left', 'open-right');
    // Update selected state
    list.querySelectorAll('.area-dropdown-item').forEach(item => item.classList.remove('selected'));
    element.classList.add('selected');
    console.log('[WorkItemPanel - WebView] Sending updateField message with path:', path);
    vscode.postMessage({ command: 'updateField', field: 'System.AreaPath', value: path });
}

function toggleAssigneeDropdown() {
    const list = document.getElementById('assigneeDropdownList');
    const wrapper = document.getElementById('assigneeDropdownWrapper');
    const isOpen = list.classList.contains('open-left') || list.classList.contains('open-right');

    // Close any other open dropdowns first
    document.querySelectorAll('.iteration-dropdown-list.open-left, .iteration-dropdown-list.open-right, .area-dropdown-list.open-left, .area-dropdown-list.open-right, .assignee-dropdown-list.open-left, .assignee-dropdown-list.open-right').forEach(el => {
        el.classList.remove('open-left', 'open-right');
    });

    if (!isOpen) {
        // Calculate available space on left and right
        const rect = wrapper.getBoundingClientRect();
        const viewportWidth = window.innerWidth;
        const spaceOnRight = viewportWidth - rect.right;
        const spaceOnLeft = rect.left;
        const dropdownWidth = 250; // min-width of dropdown

        // Open to the side with more space, preferring left if both are insufficient
        if (spaceOnLeft >= dropdownWidth || spaceOnLeft > spaceOnRight) {
            list.classList.add('open-left');
        } else {
            list.classList.add('open-right');
        }
    }
}

function selectAssignee(uniqueName, displayName) {
    const btn = document.getElementById('assigneeDropdownBtn');
    const list = document.getElementById('assigneeDropdownList');
    btn.textContent = displayName;
    list.classList.remove('open-left', 'open-right');
    // Update selected state
    list.querySelectorAll('.assignee-dropdown-item').forEach(item => item.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
    vscode.postMessage({ command: 'assignTo', uniqueName: uniqueName || '' });
}

// Close dropdowns when clicking outside
document.addEventListener('click', function(e) {
    const iterationWrapper = document.getElementById('iterationDropdownWrapper');
    const areaWrapper = document.getElementById('areaDropdownWrapper');
    const assigneeWrapper = document.getElementById('assigneeDropdownWrapper');

    if (iterationWrapper && !iterationWrapper.contains(e.target)) {
        const list = document.getElementById('iterationDropdownList');
        list.classList.remove('open-left', 'open-right');
    }

    if (areaWrapper && !areaWrapper.contains(e.target)) {
        const list = document.getElementById('areaDropdownList');
        list.classList.remove('open-left', 'open-right');
    }

    if (assigneeWrapper && !assigneeWrapper.contains(e.target)) {
        const list = document.getElementById('assigneeDropdownList');
        list.classList.remove('open-left', 'open-right');
    }
});

function uploadAttachment() {
    vscode.postMessage({ command: 'uploadAttachment' });
}

function downloadAttachment(url, name) {
    vscode.postMessage({ command: 'downloadAttachment', url, name });
}

function deleteAttachment(url) {
    vscode.postMessage({ command: 'deleteAttachment', url });
}

// Tag Management
const existingTags = WORK_ITEM_DATA.existingTags;
let currentTags = WORK_ITEM_DATA.currentTags;
let selectedSuggestionIndex = -1;

function getCurrentTagsString() {
    return currentTags.join('; ');
}

function updateTagsBackend() {
    const tagsString = getCurrentTagsString();
    vscode.postMessage({ command: 'updateTags', tags: tagsString });
}

function removeTag(tagName) {
    currentTags = currentTags.filter(t => t !== tagName);
    renderTags();
    updateTagsBackend();
}

function addTag(tagName) {
    const trimmed = tagName.trim();
    if (trimmed && !currentTags.includes(trimmed)) {
        currentTags.push(trimmed);
        renderTags();
        updateTagsBackend();
    }
}

function renderTags() {
    const display = document.getElementById('tagsDisplay');
    const input = document.getElementById('tagInput');
    const currentValue = input.value;

    display.innerHTML = currentTags.map(tag =>
        `<span class="tag-chip-editable">${escapeHtml(tag)}<button class="tag-remove" data-click="removeTag" data-click-args='[${jsArg(tag)}]'>×</button></span>`
    ).join('') + `<input type="text" class="tag-input" id="tagInput" placeholder="Add tag..." data-input="handleTagInput" data-keydown="handleTagKeydown" data-keydown-args='[{"$ref": "event"}]' data-focus="showTagSuggestions" data-blur="hideTagSuggestions">`;

    // Connect the new elements now, before focusing, rather than when the page notices them
    bindWebviewHandlers(display);
    const newInput = document.getElementById('tagInput');
    newInput.value = currentValue;
    newInput.focus();
}

function handleTagInput() {
    const input = document.getElementById('tagInput');
    const query = input.value.toLowerCase();
    const suggestions = document.getElementById('tagSuggestions');

    if (!query) {
        suggestions.innerHTML = existingTags.slice(0, 10).map(tag =>
            `<div class="tag-suggestion-item" data-mousedown="selectTag" data-mousedown-args='[${jsArg(tag)}]'>${escapeHtml(tag)}</div>`
        ).join('');
    } else {
        const filtered = existingTags.filter(tag =>
            tag.toLowerCase().includes(query) && !currentTags.includes(tag)
        );

        if (filtered.length > 0) {
            suggestions.innerHTML = filtered.slice(0, 10).map(tag =>
                `<div class="tag-suggestion-item" data-mousedown="selectTag" data-mousedown-args='[${jsArg(tag)}]'>${escapeHtml(tag)}</div>`
            ).join('');
        } else if (query.length > 0) {
            suggestions.innerHTML = `<div class="tag-suggestion-item" data-mousedown="selectTag" data-mousedown-args='[${jsArg(query)}]'>Create: ${escapeHtml(query)}</div>`;
        } else {
            suggestions.innerHTML = '';
        }
    }

    selectedSuggestionIndex = -1;
    updateSelectedSuggestion();
    suggestions.classList.add('show');
}

function handleTagKeydown(event) {
    const input = document.getElementById('tagInput');
    const suggestions = document.getElementById('tagSuggestions');
    const items = suggestions.querySelectorAll('.tag-suggestion-item');

    if (event.key === 'Enter') {
        event.preventDefault();
        if (selectedSuggestionIndex >= 0 && items[selectedSuggestionIndex]) {
            const tagText = items[selectedSuggestionIndex].textContent;
            const tag = tagText.startsWith('Create: ') ? tagText.substring(8) : tagText;
            addTag(tag);
            input.value = '';
            handleTagInput();
        } else if (input.value.trim()) {
            addTag(input.value.trim());
            input.value = '';
            handleTagInput();
        }
    } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (selectedSuggestionIndex < items.length - 1) {
            selectedSuggestionIndex++;
            updateSelectedSuggestion();
        }
    } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (selectedSuggestionIndex > 0) {
            selectedSuggestionIndex--;
            updateSelectedSuggestion();
        }
    } else if (event.key === 'Escape') {
        suggestions.classList.remove('show');
    } else if (event.key === 'Backspace' && !input.value && currentTags.length > 0) {
        currentTags.pop();
        renderTags();
        updateTagsBackend();
    }
}

function updateSelectedSuggestion() {
    const items = document.querySelectorAll('.tag-suggestion-item');
    items.forEach((item, index) => {
        if (index === selectedSuggestionIndex) {
            item.classList.add('selected');
        } else {
            item.classList.remove('selected');
        }
    });
}

function selectTag(tagName) {
    addTag(tagName);
    const input = document.getElementById('tagInput');
    input.value = '';
    handleTagInput();
}

function showTagSuggestions() {
    handleTagInput();
}

function hideTagSuggestions() {
    setTimeout(() => {
        document.getElementById('tagSuggestions').classList.remove('show');
    }, 200);
}

function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Encode a value as a JSON string literal for an argument list, e.g. data-click="f" data-click-args='[${jsArg(x)}]'.
function jsArg(text) {
    return escapeHtml(JSON.stringify(String(text ?? '')));
}

// Board webview script. Loaded with a nonce; the extension passes data in #board-data.
const BOARD_DATA = JSON.parse(document.getElementById('board-data').textContent);

/** Escape in the search box clears it. */
function handleSearchKeydown(event, input) {
    if (event.key === 'Escape') {
        input.value = '';
        applyFilters();
    }
}
const vscode = acquireVsCodeApi();
const availableBoards = BOARD_DATA.availableBoards;
let draggedCard = null;
let originalColumn = null;
let selectedCard = null;
let keyboardMoveMode = false;
let contextMenuWorkItemId = null;

// Avatar color utility - generates consistent colors based on display name
function getAvatarColor(displayName) {
    if (!displayName || displayName === 'Unassigned') {
        return { bg: 'rgba(139, 139, 139, 0.3)', fg: '#8b8b8b' };
    }

    // Hash the display name to get a consistent number
    let hash = 0;
    for (let i = 0; i < displayName.length; i++) {
        hash = displayName.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Predefined pleasant color palette
    const colors = [
        { bg: 'rgba(34, 197, 94, 0.3)', fg: '#22c55e' },   // Green
        { bg: 'rgba(59, 130, 246, 0.3)', fg: '#3b82f6' },  // Blue
        { bg: 'rgba(168, 85, 247, 0.3)', fg: '#a855f7' },  // Purple
        { bg: 'rgba(236, 72, 153, 0.3)', fg: '#ec4899' },  // Pink
        { bg: 'rgba(251, 146, 60, 0.3)', fg: '#fb923c' },  // Orange
        { bg: 'rgba(14, 165, 233, 0.3)', fg: '#0ea5e9' },  // Cyan
        { bg: 'rgba(244, 63, 94, 0.3)', fg: '#f43f5e' },   // Red
        { bg: 'rgba(234, 179, 8, 0.3)', fg: '#eab308' },   // Yellow
        { bg: 'rgba(20, 184, 166, 0.3)', fg: '#14b8a6' },  // Teal
        { bg: 'rgba(139, 92, 246, 0.3)', fg: '#8b5cf6' },  // Violet
    ];

    const index = Math.abs(hash) % colors.length;
    return colors[index];
}

// Apply avatar colors after DOM is loaded
function applyAvatarColors() {
    document.querySelectorAll('.card-avatar').forEach(avatar => {
        // Check if it's a main card avatar or a checklist avatar
        const card = avatar.closest('.card');
        const checklistItem = avatar.closest('.checklist-item');

        let displayName = '';
        if (card) {
            displayName = card.getAttribute('data-assignee-name');
        } else if (checklistItem) {
            displayName = checklistItem.getAttribute('data-assignee-name');
        }

        if (!avatar.classList.contains('unassigned') && displayName) {
            const color = getAvatarColor(displayName);
            avatar.style.background = color.bg;
            avatar.style.color = color.fg;
        }
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    document.addEventListener('keydown', handleGlobalKeydown);
    document.addEventListener('click', hideContextMenu);
    applyAvatarColors();
});

// Keyboard Navigation
function handleGlobalKeydown(event) {
    // Ignore if typing in input
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
    }

    switch (event.key) {
        case '?':
            toggleKeyboardHelp();
            break;
        case 'r':
        case 'R':
            if (!event.ctrlKey && !event.metaKey) {
                refresh();
            }
            break;
        case 'Escape':
            if (keyboardMoveMode) {
                cancelKeyboardMove();
            }
            hideContextMenu();
            break;
        case 'm':
        case 'M':
            if (selectedCard && !keyboardMoveMode) {
                startKeyboardMove();
            }
            break;
        case 'Enter':
            if (keyboardMoveMode) {
                confirmKeyboardMove();
            } else if (selectedCard) {
                openWorkItem(parseInt(selectedCard.dataset.id));
            }
            break;
        case 'ArrowUp':
            event.preventDefault();
            navigateCards(-1);
            break;
        case 'ArrowDown':
            event.preventDefault();
            navigateCards(1);
            break;
        case 'ArrowLeft':
            event.preventDefault();
            if (keyboardMoveMode) {
                moveCardToColumn(-1);
            } else {
                navigateColumns(-1);
            }
            break;
        case 'ArrowRight':
            event.preventDefault();
            if (keyboardMoveMode) {
                moveCardToColumn(1);
            } else {
                navigateColumns(1);
            }
            break;
    }
}

function selectCard(card) {
    if (selectedCard) {
        selectedCard.classList.remove('selected');
    }
    selectedCard = card;
    if (card) {
        card.classList.add('selected');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

function navigateCards(direction) {
    const cards = Array.from(document.querySelectorAll('.card'));
    if (cards.length === 0) return;

    if (!selectedCard) {
        selectCard(cards[0]);
        return;
    }

    const currentIndex = cards.indexOf(selectedCard);
    const newIndex = Math.max(0, Math.min(cards.length - 1, currentIndex + direction));
    selectCard(cards[newIndex]);
}

function navigateColumns(direction) {
    const columns = Array.from(document.querySelectorAll('.column:not(.collapsed)'));
    if (columns.length === 0) return;

    let currentColIndex = 0;
    if (selectedCard) {
        const currentColumn = selectedCard.closest('.column');
        currentColIndex = columns.indexOf(currentColumn);
    }

    const newColIndex = Math.max(0, Math.min(columns.length - 1, currentColIndex + direction));
    const targetColumn = columns[newColIndex];
    const cards = targetColumn.querySelectorAll('.card');

    if (cards.length > 0) {
        selectCard(cards[0]);
    } else {
        // Focus empty column
        columns.forEach(c => c.classList.remove('keyboard-focus'));
        targetColumn.classList.add('keyboard-focus');
    }
}

function startKeyboardMove() {
    if (!selectedCard) return;
    keyboardMoveMode = true;
    selectedCard.classList.add('keyboard-moving');
    showToast('Move mode: Use ← → to move, Enter to confirm, Esc to cancel', 'info');
}

function cancelKeyboardMove() {
    keyboardMoveMode = false;
    if (selectedCard) {
        selectedCard.classList.remove('keyboard-moving');
    }
    showToast('Move cancelled', 'info');
}

function moveCardToColumn(direction) {
    if (!selectedCard) return;

    const columns = Array.from(document.querySelectorAll('.column:not(.collapsed)'));
    const currentColumn = selectedCard.closest('.column');
    const currentColIndex = columns.indexOf(currentColumn);
    const newColIndex = Math.max(0, Math.min(columns.length - 1, currentColIndex + direction));

    if (newColIndex === currentColIndex) return;

    const targetColumn = columns[newColIndex];
    const limit = parseInt(targetColumn.dataset.limit) || 0;

    if (limit > 0) {
        // Only count visible cards (not filtered out)
        const currentCount = targetColumn.querySelectorAll('.card:not(.filtered-out)').length;

        // Debug logging
        const allCards = targetColumn.querySelectorAll('.card').length;
        const filteredCards = targetColumn.querySelectorAll('.card.filtered-out').length;
        console.log('[WIP Check] Column:', targetColumn.dataset.column,
            'Limit:', limit,
            'Visible cards:', currentCount,
            'Total cards:', allCards,
            'Filtered cards:', filteredCards);

        if (currentCount >= limit) {
            showToast('WIP limit reached for ' + targetColumn.dataset.column + ' (' + currentCount + '/' + limit + ')', 'error');
            return;
        }
    }

    // Move the card visually
    const columnBody = targetColumn.querySelector('.column-body');
    const placeholder = columnBody.querySelector('.drop-placeholder');
    columnBody.insertBefore(selectedCard, placeholder);

    // Remove empty state message if present
    const emptyMessage = columnBody.querySelector('.empty-column');
    if (emptyMessage) {
        emptyMessage.remove();
    }

    updateColumnCounts();
}

function confirmKeyboardMove() {
    if (!selectedCard || !keyboardMoveMode) return;

    const column = selectedCard.closest('.column');
    const workItemId = parseInt(selectedCard.dataset.id);
    const targetColumn = column.dataset.column;

    // Look up the correct state based on the work item type
    const workItemType = selectedCard.dataset.type;
    let targetState = column.dataset.state; // fallback

    try {
        const stateMappings = JSON.parse(column.dataset.stateMappings || '{}');
        if (stateMappings[workItemType]) {
            targetState = stateMappings[workItemType];
        }
    } catch (e) {
        console.error('Failed to parse state mappings:', e);
    }

    vscode.postMessage({
        command: 'moveWorkItem',
        workItemId: workItemId,
        targetColumn: targetColumn,
        targetState: targetState
    });

    keyboardMoveMode = false;
    selectedCard.classList.remove('keyboard-moving');
}

// Context Menu
function showContextMenu(event, workItemId) {
    event.preventDefault();
    event.stopPropagation();

    contextMenuWorkItemId = workItemId;
    const menu = document.getElementById('contextMenu');

    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';
    menu.classList.add('show');

    // Adjust if menu goes off screen
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
        menu.style.left = (event.pageX - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
        menu.style.top = (event.pageY - rect.height) + 'px';
    }
}

function hideContextMenu() {
    document.getElementById('contextMenu').classList.remove('show');
    contextMenuWorkItemId = null;
}

function contextMenuAction(action, value) {
    hideContextMenu();
    if (!contextMenuWorkItemId) return;

    switch (action) {
        case 'open':
            vscode.postMessage({ command: 'openWorkItem', workItemId: contextMenuWorkItemId });
            break;
        case 'openBrowser':
            vscode.postMessage({ command: 'openWorkItemInBrowser', workItemId: contextMenuWorkItemId });
            break;
        case 'assignToMe':
            vscode.postMessage({ command: 'assignToMe', workItemId: contextMenuWorkItemId });
            break;
        case 'changeState':
            vscode.postMessage({ command: 'changeState', workItemId: contextMenuWorkItemId, state: value });
            break;
        case 'addComment':
            vscode.postMessage({ command: 'addComment', workItemId: contextMenuWorkItemId });
            break;
        case 'createBranch':
            vscode.postMessage({ command: 'createBranch', workItemId: contextMenuWorkItemId });
            break;
        case 'copyId':
            vscode.postMessage({ command: 'copyId', workItemId: contextMenuWorkItemId });
            break;
        case 'copyUrl':
            vscode.postMessage({ command: 'copyUrl', workItemId: contextMenuWorkItemId });
            break;
    }
}

// Board Dropdown
function toggleBoardDropdown() {
    document.getElementById('boardDropdown').classList.toggle('show');
}

function switchBoard(boardId, boardName) {
    document.getElementById('boardDropdown').classList.remove('show');
    vscode.postMessage({ command: 'switchBoard', boardId, boardName });
}

// Column Collapse
function toggleColumn(column) {
    column.classList.toggle('collapsed');
    const btn = column.querySelector('.collapse-btn');
    btn.textContent = column.classList.contains('collapsed') ? '▶' : '◀';
}

// Keyboard Help
function toggleKeyboardHelp() {
    document.getElementById('keyboardHelp').classList.toggle('show');
}

// Drag and Drop
function handleDragStart(event, workItemId) {
    // Use currentTarget to get the card element, not a child element
    draggedCard = event.currentTarget;
    const column = draggedCard.closest('.column');
    if (column) {
        originalColumn = column.dataset.column;
    }
    draggedCard.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', workItemId);
}

function handleDragEnd(event) {
    if (event.currentTarget) {
        event.currentTarget.classList.remove('dragging');
    }
    document.querySelectorAll('.column').forEach(col => {
        col.classList.remove('drag-over');
    });
    draggedCard = null;
    originalColumn = null;
}

function handleDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const column = event.target.closest('.column');
    if (column && !column.classList.contains('collapsed')) {
        column.classList.add('drag-over');
    }
}

function handleDragLeave(event) {
    const column = event.target.closest('.column');
    if (column && !column.contains(event.relatedTarget)) {
        column.classList.remove('drag-over');
    }
}

function handleDrop(event) {
    event.preventDefault();
    const column = event.target.closest('.column');
    if (!column || !draggedCard || column.classList.contains('collapsed')) return;

    column.classList.remove('drag-over');

    const workItemId = parseInt(event.dataTransfer.getData('text/plain'));
    const targetColumn = column.dataset.column;

    // Look up the correct state based on the work item type being dragged
    const workItemType = draggedCard.dataset.type;
    let targetState = column.dataset.state; // fallback

    console.log('[Drag] Work item type:', workItemType);
    console.log('[Drag] Target column:', targetColumn);
    console.log('[Drag] Fallback state:', targetState);

    try {
        const stateMappings = JSON.parse(column.dataset.stateMappings || '{}');
        console.log('[Drag] State mappings for column:', stateMappings);

        if (stateMappings[workItemType]) {
            targetState = stateMappings[workItemType];
            console.log('[Drag] Found state for type:', targetState);
        } else {
            console.warn('[Drag] No state mapping found for type:', workItemType, '- using fallback:', targetState);
            console.log('[Drag] Available types in mapping:', Object.keys(stateMappings));
        }
    } catch (e) {
        console.error('[Drag] Failed to parse state mappings:', e);
    }

    console.log('[Drag] Final target state:', targetState);

    if (originalColumn === targetColumn) {
        return;
    }

    const limit = parseInt(column.dataset.limit) || 0;
    if (limit > 0) {
        // Count visible cards in target column (not filtered out), excluding the card being dragged
        const cardsInColumn = column.querySelectorAll('.card:not(.filtered-out)');
        let currentCount = 0;
        cardsInColumn.forEach(card => {
            // Don't count the dragged card if it's already in this column
            if (card !== draggedCard) {
                currentCount++;
            }
        });

        console.log('[WIP Check - Keyboard] Column:', targetColumn,
            'Limit:', limit,
            'Visible cards (excluding dragged):', currentCount);

        if (currentCount >= limit) {
            showToast('WIP limit reached for ' + targetColumn + ' (' + currentCount + '/' + limit + ')', 'error');
            return;
        }
    }

    const columnBody = column.querySelector('.column-body');
    const placeholder = columnBody.querySelector('.drop-placeholder');
    columnBody.insertBefore(draggedCard, placeholder);
    draggedCard.classList.remove('dragging');

    // Remove empty state message if present
    const emptyMessage = columnBody.querySelector('.empty-column');
    if (emptyMessage) {
        emptyMessage.remove();
    }

    // IMMEDIATELY update the card's state indicator for instant visual feedback
    if (targetState && draggedCard) {
        // Update the data-state attribute
        draggedCard.dataset.state = targetState;

        // Update the status label text
        const statusLabel = draggedCard.querySelector('.status-label');
        if (statusLabel) {
            statusLabel.textContent = targetState;
        }

        // Update the status dot class based on the new state
        const statusDot = draggedCard.querySelector('.status-dot');
        if (statusDot) {
            const stateLower = targetState.toLowerCase();
            let newStateClass = 'todo';
            if (stateLower.includes('done') || stateLower.includes('closed')) {
                newStateClass = 'done';
            } else if (stateLower.includes('active') || stateLower.includes('doing') || stateLower.includes('progress')) {
                newStateClass = 'doing';
            }

            // Remove all state classes and add the new one
            statusDot.classList.remove('done', 'doing', 'todo');
            statusDot.classList.add(newStateClass);
        }
    }

    updateColumnCounts();

    vscode.postMessage({
        command: 'moveWorkItem',
        workItemId: workItemId,
        targetColumn: targetColumn,
        targetState: targetState
    });
}

function updateColumnCounts() {
    document.querySelectorAll('.column').forEach(column => {
        const count = column.querySelectorAll('.card').length;
        const limit = parseInt(column.dataset.limit) || 0;
        const badge = column.querySelector('.wip-badge');

        badge.textContent = limit > 0 ? count + '/' + limit : count;
        badge.classList.remove('warning', 'danger');

        if (limit > 0) {
            if (count >= limit) {
                badge.classList.add('danger');
            } else if (count >= limit * 0.8) {
                badge.classList.add('warning');
            }
        }
    });
}

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;
    switch (message.command) {
        case 'moveSuccess':
            showToast(message.message, 'success');
            break;
        case 'moveFailed':
            showToast(message.message, 'error');
            vscode.postMessage({ command: 'refresh' });
            break;
    }
});

// Card actions
function openWorkItem(workItemId) {
    // Add pulse animation to the clicked card
    const card = document.querySelector('.card[data-id="' + workItemId + '"]');
    if (card) {
        card.classList.add('clicking');
        setTimeout(function() {
            card.classList.remove('clicking');
        }, 200);
    }

    // Open the work item detail
    vscode.postMessage({ command: 'openWorkItem', workItemId: workItemId });
}

function editCardTitle(titleElement, workItemId) {
    const currentTitle = titleElement.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'card-title-editable';
    input.value = currentTitle;

    titleElement.replaceWith(input);
    input.focus();
    input.select();

    function saveTitle() {
        const newTitle = input.value.trim();
        if (newTitle && newTitle !== currentTitle) {
            vscode.postMessage({
                command: 'updateWorkItemTitle',
                workItemId: workItemId,
                title: newTitle
            });
            const span = document.createElement('span');
            span.className = 'card-title';
            span.textContent = newTitle;
            span.ondblclick = (e) => { e.stopPropagation(); editCardTitle(span, workItemId); };
            input.replaceWith(span);
        } else {
            const span = document.createElement('span');
            span.className = 'card-title';
            span.textContent = currentTitle;
            span.ondblclick = (e) => { e.stopPropagation(); editCardTitle(span, workItemId); };
            input.replaceWith(span);
        }
    }

    input.addEventListener('blur', saveTitle);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveTitle();
        } else if (e.key === 'Escape') {
            const span = document.createElement('span');
            span.className = 'card-title';
            span.textContent = currentTitle;
            span.ondblclick = (ev) => { ev.stopPropagation(); editCardTitle(span, workItemId); };
            input.replaceWith(span);
        }
    });
}

// Card Menu Functions
let currentCardMenuWorkItemId = null;

function showCardMenu(event, workItemId) {
    const menu = document.getElementById('cardMenu');
    currentCardMenuWorkItemId = workItemId;

    menu.style.left = event.pageX + 'px';
    menu.style.top = event.pageY + 'px';
    menu.classList.add('show');

    setTimeout(() => {
        document.addEventListener('click', hideCardMenu);
    }, 10);
}

function hideCardMenu() {
    const menu = document.getElementById('cardMenu');
    menu.classList.remove('show');
    document.removeEventListener('click', hideCardMenu);
}

function cardMenuAction(action) {
    hideCardMenu();
    const workItemId = currentCardMenuWorkItemId;

    switch(action) {
        case 'open':
            openWorkItem(workItemId);
            break;
        case 'editTitle': {
            const card = document.querySelector(`.card[data-id="${workItemId}"]`);
            const titleElement = card.querySelector('.card-title');
            editCardTitle(titleElement, workItemId);
            break;
        }
        case 'moveToColumn':
            vscode.postMessage({ command: 'moveToColumn', workItemId: workItemId });
            break;
        case 'moveToIteration':
            vscode.postMessage({ command: 'moveToIteration', workItemId: workItemId });
            break;
        case 'addTask':
            vscode.postMessage({ command: 'addChildWorkItem', workItemId: workItemId, workItemType: 'Task' });
            break;
        case 'addTest':
            vscode.postMessage({ command: 'addChildWorkItem', workItemId: workItemId, workItemType: 'Test Case' });
            break;
        case 'createBranch':
            vscode.postMessage({ command: 'createBranch', workItemId: workItemId });
            break;
        case 'delete':
            vscode.postMessage({ command: 'confirmDeleteWorkItem', workItemId: workItemId });
            break;
    }
}

// Assignee Editor
function changeCardAssignee(workItemId, currentAssignee) {
    vscode.postMessage({ command: 'changeAssignee', workItemId: workItemId, currentAssignee: currentAssignee });
}

// Effort/Story Points Editor
function toggleEffortEditor(button, workItemId) {
    const card = button.closest('.card');
    const currentEffort = card.dataset.effort || '';

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'card-title-editable';
    input.value = currentEffort;
    input.style.width = '100%';
    input.style.textAlign = 'center';
    input.placeholder = 'Enter points';

    button.replaceWith(input);
    input.focus();
    input.select();

    function saveEffort() {
        const newEffort = input.value.trim();
        vscode.postMessage({
            command: 'updateWorkItemEffort',
            workItemId: workItemId,
            effort: newEffort ? parseFloat(newEffort) : null
        });

        const newButton = document.createElement('button');
        newButton.className = 'card-effort-toggle';
        newButton.onclick = (e) => { e.stopPropagation(); toggleEffortEditor(newButton, workItemId); };
        newButton.title = 'Story Points';
        newButton.innerHTML = `<span class="effort-icon">▲</span><span class="effort-value">${newEffort || 'Story Points'}</span>`;
        input.replaceWith(newButton);

        card.dataset.effort = newEffort;
    }

    input.addEventListener('blur', saveEffort);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEffort();
        } else if (e.key === 'Escape') {
            const newButton = document.createElement('button');
            newButton.className = 'card-effort-toggle';
            newButton.onclick = (ev) => { ev.stopPropagation(); toggleEffortEditor(newButton, workItemId); };
            newButton.title = 'Story Points';
            newButton.innerHTML = `<span class="effort-icon">▲</span><span class="effort-value">${currentEffort || 'Story Points'}</span>`;
            input.replaceWith(newButton);
        }
    });
}

// Card Effort Editor (for effort display in card)
function editCardEffort(valueSpan, workItemId, currentEffort) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'card-effort-input';
    input.value = currentEffort || '';
    input.min = '0';
    input.step = '0.5';

    valueSpan.replaceWith(input);
    input.focus();
    input.select();

    // Prevent clicks on the input (including spinner arrows) from bubbling to card
    input.addEventListener('click', (e) => {
        e.stopPropagation();
    });

    // Prevent mousedown on spinner arrows from bubbling
    input.addEventListener('mousedown', (e) => {
        e.stopPropagation();
    });

    function saveEffort() {
        const newEffort = input.value.trim();
        const card = input.closest('.card');

        vscode.postMessage({
            command: 'updateWorkItemEffort',
            workItemId: workItemId,
            effort: newEffort ? parseFloat(newEffort) : null
        });

        const newSpan = document.createElement('span');
        newSpan.className = 'card-effort-value';
        newSpan.onclick = (e) => { e.stopPropagation(); editCardEffort(newSpan, workItemId, parseFloat(newEffort)); };
        newSpan.textContent = newEffort || currentEffort;
        input.replaceWith(newSpan);

        if (card) {
            card.dataset.effort = newEffort;
        }
    }

    input.addEventListener('blur', saveEffort);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveEffort();
        } else if (e.key === 'Escape') {
            const newSpan = document.createElement('span');
            newSpan.className = 'card-effort-value';
            newSpan.onclick = (ev) => { ev.stopPropagation(); editCardEffort(newSpan, workItemId, currentEffort); };
            newSpan.textContent = currentEffort;
            input.replaceWith(newSpan);
        }
    });
}

// Checklist functions
function toggleChildChecklist(parentWorkItemId, typeId) {
    const checklistId = 'checklist-' + parentWorkItemId + '-' + typeId;
    const checklist = document.getElementById(checklistId);

    if (checklist) {
        const isExpanded = checklist.classList.contains('expanded');

        // Close all other checklists for this parent
        const allChecklists = document.querySelectorAll('[id^="checklist-' + parentWorkItemId + '-"]');
        allChecklists.forEach(function(cl) {
            if (cl.id !== checklistId) {
                cl.classList.remove('expanded');
            }
        });

        if (isExpanded) {
            // Collapse this checklist
            checklist.classList.remove('expanded');
        } else {
            // Expand this checklist
            checklist.classList.add('expanded');
            // Apply avatar colors to newly visible avatars
            setTimeout(function() {
                applyAvatarColors();
            }, 50);
        }
    }
}

function toggleChildState(childWorkItemId, parentWorkItemId, isChecked) {
    // Update the visual state immediately
    const checklistItem = document.querySelector('.checklist-item input[data-child-id="' + childWorkItemId + '"]')?.closest('.checklist-item');
    const titleElement = checklistItem?.querySelector('.checklist-title');

    if (checklistItem && titleElement) {
        if (isChecked) {
            checklistItem.classList.add('done');
            titleElement.classList.add('done');
        } else {
            checklistItem.classList.remove('done');
            titleElement.classList.remove('done');
        }
    }

    // Send command to update work item state
    const newState = isChecked ? 'Closed' : 'Active';
    vscode.postMessage({
        command: 'updateChildWorkItemState',
        workItemId: childWorkItemId,
        parentWorkItemId: parentWorkItemId,
        state: newState,
        isChecked: isChecked
    });
}

function addChildWorkItem(parentWorkItemId, childType) {
    vscode.postMessage({
        command: 'addChildWorkItem',
        parentWorkItemId: parentWorkItemId,
        childType: childType
    });
}

function assignToMe(workItemId, event) {
    event.stopPropagation();
    vscode.postMessage({ command: 'assignToMe', workItemId: workItemId });
}

// Board actions
function refresh() {
    vscode.postMessage({ command: 'refresh' });
}

function openInBrowser() {
    vscode.postMessage({ command: 'openInBrowser' });
}

// Add item form - toggle open/close
function showAddForm(columnName) {
    const formId = 'add-form-' + columnName.replace(/\s/g, '-');
    const form = document.getElementById(formId);
    if (form) {
        if (form.classList.contains('active')) {
            // Close the form with slide animation
            form.classList.remove('active');
            const titleInput = document.getElementById('add-item-title-input');
            if (titleInput) titleInput.value = '';
            // Also close type dropdown if open
            const typeDropdown = document.getElementById('add-item-type-dropdown');
            if (typeDropdown) typeDropdown.classList.remove('open');
        } else {
            // Open the form with slide animation
            form.classList.add('active');
            setTimeout(() => {
                const input = form.querySelector('.add-item-input');
                if (input) input.focus();
            }, 100);
        }
    }
}

function hideAddForm(columnName) {
    const formId = 'add-form-' + columnName.replace(/\s/g, '-');
    const form = document.getElementById(formId);
    if (form) {
        form.classList.remove('active');
        const titleInput = document.getElementById('add-item-title-input');
        if (titleInput) titleInput.value = '';
    }
}

function handleAddKeydown(event, columnName) {
    if (event.key === 'Enter') {
        createItem(columnName);
    } else if (event.key === 'Escape') {
        hideAddForm(columnName);
    }
}

function createItem(columnName) {
    const typeValue = document.getElementById('add-item-type-value');
    const titleInput = document.getElementById('add-item-title-input');
    const title = titleInput ? titleInput.value.trim() : '';
    const workItemType = typeValue ? typeValue.value : 'User Story';

    if (title) {
        vscode.postMessage({
            command: 'createWorkItem',
            columnName: columnName,
            title: title,
            workItemType: workItemType
        });
        hideAddForm(columnName);
    }
}

// Type dropdown functions
function toggleTypeDropdown(event) {
    event.stopPropagation();
    const dropdown = document.getElementById('add-item-type-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('open');
    }
}

function selectWorkItemType(type) {
    const typeValue = document.getElementById('add-item-type-value');
    const typeBtn = document.getElementById('add-item-type-btn');
    const dropdown = document.getElementById('add-item-type-dropdown');
    const menu = document.getElementById('add-item-type-menu');

    if (typeValue) typeValue.value = type;
    if (typeBtn) {
        typeBtn.title = type;
        const iconSpan = typeBtn.querySelector('.type-icon');
        if (iconSpan) {
            iconSpan.innerHTML = getTypeIcon(type);
        }
    }

    // Update selected state in menu
    if (menu) {
        menu.querySelectorAll('.type-menu-item').forEach(item => {
            item.classList.toggle('selected', item.dataset.type === type);
        });
    }

    // Close dropdown
    if (dropdown) dropdown.classList.remove('open');
}

function getTypeIcon(type) {
    const icons = {
        'User Story': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>',
        'Product Backlog Item': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>',
        'Requirement': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#4396C2" d="M320 352c-22.846 0-60.713 5.861-80 16.588V55.635C257.752 40.563 296.084 32 320 32h64v320h-64zm-192 32H32V64H0v352h208s-16-32-80-32zM64 32v320h64c22.848 0 60.707 5.865 80 16.594V55.635C190.244 40.561 151.902 32 128 32H64zm352 32v320h-96c-64 0-80 32-80 32h208V64h-32z" /></svg>',
        'Feature': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#773B93" d="M145.619 384H128c-17.674 0-32 14.326-32 32v32h256v-32c0-17.674-14.327-32-32-32h-17.619c-7.434-36.47-39.75-64-78.381-64s-70.947 27.53-78.381 64zM224 352c20.832 0 38.425 13.418 45.053 32h-90.106c6.627-18.582 24.221-32 45.053-32zM352 64V32H96v32H32v80c0 40.051 29.686 73.018 68.153 78.8C114.003 278.531 163.984 320 224 320c60.016 0 109.997-41.469 123.846-97.2C386.313 217.018 416 184.051 416 144V64h-64zM96 189.053C77.417 182.426 64 164.832 64 144V96h32v93.053zM384 144c0 20.832-13.418 38.426-32 45.053V96h32v48z" /></svg>',
        'Epic': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#FF8C00" d="M448 96c0 17.672-14.326 32-32 32v288H32V128c-17.674 0-32-14.328-32-32 0-17.674 14.326-32 32-32s32 14.326 32 32c0 11.191-6.094 20.564-14.797 26.283L136.727 256 216.79 94.543C202.699 91.191 192 79.113 192 64c0-17.674 14.326-32 32-32s32 14.326 32 32c0 15.113-10.699 27.191-24.789 30.543L311.273 256l87.523-133.717C390.094 116.564 384 107.191 384 96c0-17.674 14.326-32 32-32s32 14.326 32 32z" /></svg>',
        'Bug': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#CC293D" d="M352 224c0-17.672 14.328-32 32-32h32v-32h-32c-8.828 0-16.938 2.797-23.656 7.516C350.391 140.234 324.078 120 293 120.781 287.016 108.297 275.547 99.828 262 96.781V64h32V32h-96v32h32v32.781c-13.547 3.047-25.016 11.516-31 24-31.078.781-57.391 21.016-67.344 48.297C125.938 163.797 117.828 161 109 161H77v32h32c17.672 0 32 14.328 32 32v32c0 17.672-14.328 32-32 32H77v32h32c8.828 0 16.938-2.797 23.656-7.516C142.609 340.766 168.922 361 200 360.219c5.984 12.484 17.453 20.953 31 24V417h-32v32h96v-32h-32v-32.781c13.547-3.047 25.016-11.516 31-24 31.078-.781 57.391-21.016 67.344-48.297C366.062 317.203 374.172 320 383 320h32v-32h-32c-17.672 0-32-14.328-32-32v-32zm-80 48c-26.469 0-48-21.531-48-48s21.531-48 48-48 48 21.531 48 48-21.531 48-48 48z" /></svg>',
        'Task': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#FFC107" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm56 287.758l-79.844-79.828 31.688-31.688L184 320.414l128.156-128.172 31.688 31.688L184 383.758z" /></svg>',
        'Issue': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#28A745" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zm-71.469 352h-49.063v-49.094h49.063V416zm0-84.109h-49.063V164.109h49.063v167.782zM320 128H128V96h64V64c0-17.643 14.357-32 32-32 17.641 0 32 14.357 32 32v32h64v32z" /></svg>',
        'Impediment': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#E74C3C" d="M224 0C100.29 0 0 100.29 0 224s100.29 224 224 224 224-100.29 224-224S347.71 0 224 0zm0 416c-105.87 0-192-86.13-192-192S118.13 32 224 32s192 86.13 192 192-86.13 192-192 192zm96-240v64H128v-64h192z" /></svg>',
        'Risk': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#F39C12" d="M224 0L0 448h448L224 0zm0 128l144 288H80L224 128zm-24 104v96h48v-96h-48zm0 128v48h48v-48h-48z" /></svg>',
        'Change Request': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#3498DB" d="M384 224c0-17.672-14.328-32-32-32H256V96c0-17.672-14.328-32-32-32s-32 14.328-32 32v96H96c-17.672 0-32 14.328-32 32s14.328 32 32 32h96v96c0 17.672 14.328 32 32 32s32-14.328 32-32v-96h96c17.672 0 32-14.328 32-32z" /></svg>',
        'Review': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#1ABC9C" d="M224 96c-106.039 0-192 85.961-192 192s85.961 192 192 192 192-85.961 192-192S330.039 96 224 96zm0 352c-88.366 0-160-71.634-160-160s71.634-160 160-160 160 71.634 160 160-71.634 160-160 160zm80-192c0 44.183-35.817 80-80 80s-80-35.817-80-80 35.817-80 80-80 80 35.817 80 80z" /></svg>',
        'Test Case': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#9B59B6" d="M320 64h-32c0-35.297-28.703-64-64-64s-64 28.703-64 64H64v384h320V64h-64zM128 96h64V64c0-17.641 14.359-32 32-32s32 14.359 32 32v32h64v32H128V96zm192 320H128V192h192v224z" /></svg>',
        'Test Plan': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#8E44AD" d="M384 0H64C28.65 0 0 28.65 0 64v320c0 35.35 28.65 64 64 64h320c35.35 0 64-28.65 64-64V64c0-35.35-28.65-64-64-64zm0 384H64V64h320v320zm-64-256H128v32h192v-32zm0 64H128v32h192v-32zm0 64H128v32h192v-32z" /></svg>',
        'Test Suite': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#9B59B6" d="M416 32H32C14.336 32 0 46.336 0 64v320c0 17.664 14.336 32 32 32h384c17.664 0 32-14.336 32-32V64c0-17.664-14.336-32-32-32zm0 352H32V64h384v320zM128 160h192v32H128v-32zm0 64h192v32H128v-32zm0 64h128v32H128v-32z" /></svg>'
    };
    return icons[type] || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 448" width="16" height="16"><path fill="#666666" d="M384 0H64C28.65 0 0 28.65 0 64v320c0 35.35 28.65 64 64 64h320c35.35 0 64-28.65 64-64V64c0-35.35-28.65-64-64-64zm32 384c0 17.64-14.36 32-32 32H64c-17.64 0-32-14.36-32-32V64c0-17.64 14.36-32 32-32h320c17.64 0 32 14.36 32 32v320z"/><rect x="96" y="96" width="256" height="32" fill="#666666"/><rect x="96" y="160" width="192" height="32" fill="#666666"/><rect x="96" y="224" width="224" height="32" fill="#666666"/></svg>';
}

// Toast notifications
function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast show ' + type;

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Close dropdown when clicking outside
document.addEventListener('click', (event) => {
    if (!event.target.closest('.board-selector')) {
        const boardDropdown = document.getElementById('boardDropdown');
        if (boardDropdown) boardDropdown.classList.remove('show');
    }
    if (!event.target.closest('.filter-dropdown')) {
        document.querySelectorAll('.filter-dropdown-content').forEach(d => d.classList.remove('show'));
    }
    // Close type dropdown when clicking outside
    if (!event.target.closest('.add-item-type-dropdown')) {
        const typeDropdown = document.getElementById('add-item-type-dropdown');
        if (typeDropdown) typeDropdown.classList.remove('open');
    }
    // Close add item form when clicking outside (but not on the add button)
    if (!event.target.closest('.add-item-form-container') && !event.target.closest('.add-item-header-btn')) {
        document.querySelectorAll('.add-item-form-container.active').forEach(form => {
            form.classList.remove('active');
            const titleInput = form.querySelector('.add-item-input');
            if (titleInput) titleInput.value = '';
        });
    }
});

function toggleDropdown(id) {
    // Close all other dropdowns
    document.querySelectorAll('.filter-dropdown-content').forEach(d => {
        if (d.id !== id) d.classList.remove('show');
    });
    document.getElementById(id).classList.toggle('show');
}

function handleFilterChange(type, checkbox) {
    updateDropdownButton(type);
    applyFilters();
}

function updateDropdownButton(type) {
    const dropdownId = type + 'DropdownContent';
    const btnId = type + 'DropdownBtn';
    const clearBtnId = type + 'ClearBtn';
    const container = document.getElementById(dropdownId);
    const btn = document.getElementById(btnId);
    const clearBtn = document.getElementById(clearBtnId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    
    const labels = {
        assignee: 'Assigned to',
        type: 'Type',
        priority: 'Priority',
        state: 'States',
        area: 'Area',
        iteration: 'Iteration'
    };
    
    if (checkboxes.length === 0) {
        btn.textContent = labels[type];
        if (clearBtn) clearBtn.disabled = true;
    } else if (checkboxes.length === 1) {
        const label = checkboxes[0].parentElement.textContent.trim();
        btn.textContent = label;
        if (clearBtn) clearBtn.disabled = false;
    } else {
        const firstLabel = checkboxes[0].parentElement.textContent.trim();
        btn.textContent = firstLabel + ' (+' + (checkboxes.length - 1) + ')';
        if (clearBtn) clearBtn.disabled = false;
    }
}

function clearFilter(type) {
    const dropdownId = type + 'DropdownContent';
    const container = document.getElementById(dropdownId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(cb => cb.checked = false);
    updateDropdownButton(type);
    applyFilters();
}

function getSelectedValues(type) {
    const dropdownId = type + 'DropdownContent';
    const container = document.getElementById(dropdownId);
    const checkboxes = container.querySelectorAll('input[type="checkbox"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
}

// ========== FILTER FUNCTIONALITY ==========
let currentUserEmail = ''; // Will be set when user info is available
let hideDoneActive = false; // Show all items by default
const currentIterationPath = BOARD_DATA.currentIterationPath;

// Initialize filters on load
document.addEventListener('DOMContentLoaded', () => {
    updateFilterCounts();
    // Request current user info from extension
    vscode.postMessage({ command: 'getCurrentUser' });
});

function toggleFilterBar() {
    const filterBar = document.getElementById('filterBar');
    const filterBtn = document.getElementById('filterToggleBtn');
    filterBar.classList.toggle('collapsed');
    filterBtn.classList.toggle('active', !filterBar.classList.contains('collapsed'));
}

function applyFilters() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase().trim();
    const assigneeValues = getSelectedValues('assignee');
    const typeValues = getSelectedValues('type');
    const priorityValues = getSelectedValues('priority');
    const stateValues = getSelectedValues('state');
    const areaValues = getSelectedValues('area');
    const iterationValues = getSelectedValues('iteration');

    const assigneeAll = assigneeValues.length === 0;
    const typeAll = typeValues.length === 0;
    const priorityAll = priorityValues.length === 0;
    const stateAll = stateValues.length === 0;
    const areaAll = areaValues.length === 0;
    const iterationAll = iterationValues.length === 0;

    const cards = document.querySelectorAll('.card');

    cards.forEach(card => {
        let visible = true;

        // Search filter (ID or title)
        if (searchTerm) {
            const cardId = card.dataset.id.toLowerCase();
            const cardTitle = card.dataset.title.toLowerCase();
            if (!cardId.includes(searchTerm) && !cardTitle.includes(searchTerm)) {
                visible = false;
            }
        }

        // Assignee filter
        if (visible && !assigneeAll) {
            const assignee = card.dataset.assignee; // uniqueName
            let match = false;

            if (assigneeValues.includes('me')) {
                 // Exact match comparison (case-insensitive)
                 if (assignee && currentUserEmail) {
                     // Log first 3 match attempts for debugging
                     if (!window._meFilterLogCount) {
                         window._meFilterLogCount = 0;
                     }
                     if (window._meFilterLogCount < 3) {
                         vscode.postMessage({
                             command: 'debugLog',
                             text: '[@Me Filter] Current user uniqueName: "' + currentUserEmail + '"'
                         });
                         vscode.postMessage({
                             command: 'debugLog',
                             text: '[@Me Filter] Card assignee uniqueName: "' + assignee + '"'
                         });
                         vscode.postMessage({
                             command: 'debugLog',
                             text: '[@Me Filter] Match: ' + (assignee.toLowerCase() === currentUserEmail.toLowerCase())
                         });
                         window._meFilterLogCount++;
                     }
                     if (assignee.toLowerCase() === currentUserEmail.toLowerCase()) {
                         match = true;
                     }
                 } else {
                     // Log if we're missing required data
                     if (!window._meFilterWarningLogged) {
                         vscode.postMessage({
                             command: 'debugLog',
                             text: '[@Me Filter] WARNING - Missing data: assignee=' + (!!assignee) + ', currentUserEmail=' + (!!currentUserEmail) + ', value="' + currentUserEmail + '"'
                         });
                         window._meFilterWarningLogged = true;
                     }
                 }
            }
            if (assigneeValues.includes('unassigned')) {
                if (!assignee) match = true;
            }

            // Check specific assignees
            if (!match && assignee) {
                if (assigneeValues.includes(assignee)) {
                    match = true;
                }
            }

            if (!match) visible = false;
        }

        // Type filter
        if (visible && !typeAll) {
            if (!typeValues.includes(card.dataset.type)) {
                visible = false;
            }
        }

        // Priority filter
        if (visible && !priorityAll) {
            const cardPriority = card.dataset.priority;
            if (!priorityValues.includes(cardPriority)) {
                visible = false;
            }
        }

        // State filter
        if (visible && !stateAll) {
            const cardState = card.dataset.state;
            if (!stateValues.includes(cardState)) {
                visible = false;
            }
        }

        // Area filter
        if (visible && !areaAll) {
            const cardArea = card.dataset.areapath;
            if (!areaValues.includes(cardArea)) {
                visible = false;
            }
        }

        // Iteration filter
        if (visible && !iterationAll) {
            const cardIteration = card.dataset.iterationpath;
            let match = false;

            // Check for @CurrentIteration special value
            if (iterationValues.includes('@currentiteration')) {
                if (cardIteration && currentIterationPath && cardIteration === currentIterationPath) {
                    match = true;
                }
            }

            // Check specific iterations
            if (!match && iterationValues.includes(cardIteration)) {
                match = true;
            }

            if (!match) {
                visible = false;
            }
        }

        // Hide Done toggle
        if (visible && hideDoneActive) {
            const state = card.dataset.state.toLowerCase();
            if (state === 'done' || state === 'closed' || state === 'completed') {
                visible = false;
            }
        }

        if (visible) {
            card.classList.remove('filtered-out');
        } else {
            card.classList.add('filtered-out');
        }
    });

    updateFilterCounts();
    updateColumnVisibleCounts();

    // Save filter state so it persists across board updates
    saveFilterState();
}

function saveFilterState() {
    const filterState = {
        search: document.getElementById('searchInput').value,
        assignee: getSelectedValues('assignee'),
        type: getSelectedValues('type'),
        priority: getSelectedValues('priority'),
        state: getSelectedValues('state'),
        area: getSelectedValues('area'),
        iteration: getSelectedValues('iteration'),
        hideDone: hideDoneActive
    };
    vscode.postMessage({ command: 'saveFilterState', filterState });
}

function updateFilterCounts() {
    const cards = document.querySelectorAll('.card');
    const visibleCards = document.querySelectorAll('.card:not(.filtered-out)');
    document.getElementById('visibleCount').textContent = visibleCards.length;
    document.getElementById('totalCount').textContent = cards.length;
}

function updateColumnVisibleCounts() {
    document.querySelectorAll('.column').forEach(column => {
        const visibleCards = column.querySelectorAll('.card:not(.filtered-out)');
        const badge = column.querySelector('.wip-badge');
        const limit = parseInt(column.dataset.limit) || 0;

        // Update badge to show visible count
        badge.textContent = limit > 0 ? visibleCards.length + '/' + limit : visibleCards.length;

        // Update badge color based on visible count
        badge.classList.remove('warning', 'danger');
        if (limit > 0) {
            if (visibleCards.length >= limit) {
                badge.classList.add('danger');
            } else if (visibleCards.length >= limit * 0.8) {
                badge.classList.add('warning');
            }
        }
    });
}

function isAnyFilterActive() {
    const assigneeChecked = document.querySelectorAll('#assigneeDropdownContent input[type="checkbox"]:checked').length > 0;
    const typeChecked = document.querySelectorAll('#typeDropdownContent input[type="checkbox"]:checked').length > 0;
    const priorityChecked = document.querySelectorAll('#priorityDropdownContent input[type="checkbox"]:checked').length > 0;
    const stateChecked = document.querySelectorAll('#stateDropdownContent input[type="checkbox"]:checked').length > 0;
    const areaChecked = document.querySelectorAll('#areaDropdownContent input[type="checkbox"]:checked').length > 0;
    const iterationChecked = document.querySelectorAll('#iterationDropdownContent input[type="checkbox"]:checked').length > 0;

    return document.getElementById('searchInput').value.trim() !== '' ||
           assigneeChecked ||
           typeChecked ||
           priorityChecked ||
           stateChecked ||
           areaChecked ||
           iterationChecked ||
           hideDoneActive;
}

function clearSearch() {
    document.getElementById('searchInput').value = '';
    applyFilters();
}

function toggleHideDone() {
    hideDoneActive = !hideDoneActive;
    const toggle = document.getElementById('hideDoneToggle');
    toggle.classList.toggle('active', hideDoneActive);
    applyFilters();
}

// Add 'F' keyboard shortcut to toggle filter bar
const originalKeydownHandler = handleGlobalKeydown;
function handleGlobalKeydownWithFilter(event) {
    if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
    }
    if (event.key === 'f' || event.key === 'F') {
        if (!event.ctrlKey && !event.metaKey) {
            toggleFilterBar();
            // Focus search input if filter bar is now visible
            const filterBar = document.getElementById('filterBar');
            if (!filterBar.classList.contains('collapsed')) {
                document.getElementById('searchInput').focus();
            }
            return;
        }
    }
    // Call original handler for other keys
    originalKeydownHandler(event);
}
// Replace the keydown handler
document.removeEventListener('keydown', handleGlobalKeydown);
document.addEventListener('keydown', handleGlobalKeydownWithFilter);

// Handle current user response from extension
window.addEventListener('message', event => {
    const message = event.data;
    if (message.command === 'setCurrentUser') {
        currentUserEmail = message.email || '';
        vscode.postMessage({
            command: 'debugLog',
            text: '[@Me Filter] Current user set to: "' + currentUserEmail + '"'
        });
        // Re-apply filters now that we have the current user info
        // This ensures @Me works correctly even if data arrives late
        applyFilters();
    } else if (message.command === 'restoreFilterState') {
        restoreFilterState(message.filterState);
    }
});

function restoreFilterState(filterState) {
    if (!filterState) return;

    // Restore search
    if (filterState.search) {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) searchInput.value = filterState.search;
    }

    // Restore checkboxes for each filter type
    const filterTypes = ['assignee', 'type', 'priority', 'state', 'area', 'iteration'];
    filterTypes.forEach(type => {
        if (filterState[type] && filterState[type].length > 0) {
            const container = document.getElementById(type + 'DropdownContent');
            if (container) {
                const checkboxes = container.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    cb.checked = filterState[type].includes(cb.value);
                });
                updateDropdownButton(type);
            }
        }
    });

    // Restore hide done toggle (default is true, so only change if explicitly false)
    if (filterState.hideDone !== undefined) {
        hideDoneActive = filterState.hideDone;
        const toggle = document.getElementById('hideDoneToggle');
        if (toggle) {
            if (hideDoneActive) {
                toggle.classList.add('active');
            } else {
                toggle.classList.remove('active');
            }
        }
    }

    // Apply the restored filters
    applyFilters();
}

// Keep scroll positions, collapsed columns and the filter bar across refreshes, and tell
// the extension while the person is dragging, editing or has a menu open, so an automatic
// refresh doesn't redraw the board under them.
(function () {
    // Saved per board, so switching boards doesn't carry one board's layout to another
    const boardKey = BOARD_DATA.boardKey;
    function persistView(view) {
        const state = vscode.getState() || {};
        const views = Object.assign({}, state.views || {});
        views[boardKey] = view;
        vscode.setState(Object.assign({}, state, { views: views }));
    }

    function captureView() {
        const container = document.getElementById('boardContainer');
        const columnScroll = {};
        const collapsed = [];
        document.querySelectorAll('.column').forEach(col => {
            const name = col.dataset.column;
            const body = col.querySelector('.column-body');
            if (body && body.scrollTop) columnScroll[name] = body.scrollTop;
            if (col.classList.contains('collapsed')) collapsed.push(name);
        });
        const filterBar = document.getElementById('filterBar');
        const search = document.getElementById('searchInput');
        persistView({
            x: window.scrollX,
            y: window.scrollY,
            boardX: container ? container.scrollLeft : 0,
            columnScroll: columnScroll,
            collapsed: collapsed,
            filterBarCollapsed: filterBar ? filterBar.classList.contains('collapsed') : undefined,
            searchFocused: !!search && document.activeElement === search,
            searchCaret: search && document.activeElement === search ? search.selectionStart : null
        });
    }

    function restoreView(view) {
        if (!view) return;
        (view.collapsed || []).forEach(name => {
            const col = Array.from(document.querySelectorAll('.column')).find(c => c.dataset.column === name);
            if (col && !col.classList.contains('collapsed')) toggleColumn(col);
        });
        const filterBar = document.getElementById('filterBar');
        if (filterBar && typeof view.filterBarCollapsed === 'boolean'
            && filterBar.classList.contains('collapsed') !== view.filterBarCollapsed) {
            toggleFilterBar();
        }
        const container = document.getElementById('boardContainer');
        if (container && view.boardX) container.scrollLeft = view.boardX;
        document.querySelectorAll('.column').forEach(col => {
            const top = (view.columnScroll || {})[col.dataset.column];
            const body = col.querySelector('.column-body');
            if (body && top) body.scrollTop = top;
        });
        if (view.x || view.y) window.scrollTo(view.x || 0, view.y || 0);
        const search = document.getElementById('searchInput');
        if (search && view.searchFocused) {
            search.focus();
            if (typeof view.searchCaret === 'number') search.setSelectionRange(view.searchCaret, view.searchCaret);
        }
    }

    restoreView(((vscode.getState() || {}).views || {})[boardKey]);

    let captureTimer = null;
    function scheduleCapture() {
        clearTimeout(captureTimer);
        captureTimer = setTimeout(captureView, 150);
    }
    window.addEventListener('scroll', scheduleCapture, true);
    document.addEventListener('click', scheduleCapture, true);
    document.addEventListener('focusin', scheduleCapture);
    document.addEventListener('keyup', scheduleCapture);

    function isBusy() {
        if (draggedCard || keyboardMoveMode) return true;
        if (document.querySelector('.context-menu.show, .card-menu.show, .board-dropdown.show, .filter-dropdown-content.show')) return true;
        const active = document.activeElement;
        if (active && active.id !== 'searchInput'
            && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT' || active.isContentEditable)) {
            return true;
        }
        return false;
    }

    // Unset at first, so a new page always reports its state; a page that replaced a busy
    // one would otherwise leave automatic refreshes waiting.
    let lastBusy = null;
    setInterval(function () {
        const busy = isBusy();
        if (busy !== lastBusy) {
            lastBusy = busy;
            vscode.postMessage({ command: 'uiBusy', busy: busy });
        }
    }, 500);
})();

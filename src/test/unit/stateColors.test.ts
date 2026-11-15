import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AVATAR_COLORS, STATE_COLORS, avatarColor, contrastRatio, stateColor } from '../../utils/stateColors';

test('every state badge color keeps white text at 4.5:1 or better', () => {
    for (const [name, color] of Object.entries(STATE_COLORS)) {
        assert.ok(contrastRatio(color, '#ffffff') >= 4.5, `${name} ${color}: ${contrastRatio(color, '#ffffff').toFixed(2)}`);
    }
});

test('states map by name without regard to case, with a neutral fallback', () => {
    assert.equal(stateColor('Done'), STATE_COLORS.completed);
    assert.equal(stateColor('in progress'), STATE_COLORS.inProgress);
    assert.equal(stateColor('Custom'), STATE_COLORS.other);
    assert.equal(stateColor(undefined), STATE_COLORS.other);
});


test('avatar fills keep white initials at 4.5:1, and the board uses the same list', () => {
    for (const color of AVATAR_COLORS) {
        assert.ok(contrastRatio(color, '#ffffff') >= 4.5, `${color}: ${contrastRatio(color, '#ffffff').toFixed(2)}`);
    }
    assert.equal(avatarColor('Ann Lee'), avatarColor('Ann Lee'));
    const boardJs = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'board', 'board.js'), 'utf8');
    const list = boardJs.match(/const AVATAR_COLORS = \[([^\]]*)\]/);
    assert.ok(list, 'board.js declares AVATAR_COLORS');
    assert.deepEqual(list[1].match(/#[0-9a-f]{6}/gi), [...AVATAR_COLORS]);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { decideStartupView, RELEASE_NOTES, releaseId } from '../../onboarding/releaseNotes';

const current = releaseId(RELEASE_NOTES);

test('new installs and empty configurations get the wizard', () => {
    assert.equal(decideStartupView({ configured: false, onboardingDismissed: false, lastShownRelease: undefined }), 'onboarding');
    // Even when this release's notes were already shown.
    assert.equal(decideStartupView({ configured: false, onboardingDismissed: false, lastShownRelease: current }), 'onboarding');
});

test('a skipped wizard stays skipped', () => {
    assert.equal(decideStartupView({ configured: false, onboardingDismissed: true, lastShownRelease: 'v0.0.1' }), 'none');
});

test('configured users get What\'s new once per release', () => {
    assert.equal(decideStartupView({ configured: true, onboardingDismissed: false, lastShownRelease: 'nov-2026-v0.3.0-ado-boards' }), 'whatsNew');
    assert.equal(decideStartupView({ configured: true, onboardingDismissed: true, lastShownRelease: undefined }), 'whatsNew');
    assert.equal(decideStartupView({ configured: true, onboardingDismissed: false, lastShownRelease: current }), 'none');
});

test('release notes are well formed', () => {
    assert.match(RELEASE_NOTES.version, /^\d+\.\d+\.\d+$/);
    assert.ok(RELEASE_NOTES.highlights.length > 0);
    for (const item of RELEASE_NOTES.highlights) {
        assert.ok(['new', 'improved', 'fixed'].includes(item.kind), item.title);
        assert.match(item.icon, /^[a-z0-9-]+$/, item.title);
        assert.ok(item.title && item.text, item.title);
    }
});


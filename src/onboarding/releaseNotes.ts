/**
 * Release highlights shown in the "What's new" view of the Get Started tab, and the rule for
 * when that tab opens on startup. No `vscode` import, so it is unit tested in plain Node.
 *
 * When preparing a release, update RELEASE_NOTES (see CONTRIBUTING.md). Changing `version`
 * shows the view once to everyone who has a configuration.
 */

export type HighlightKind = 'new' | 'improved' | 'fixed';

export interface ReleaseHighlight {
    kind: HighlightKind;
    /** A Codicon name, e.g. "rocket". */
    icon: string;
    title: string;
    text: string;
}

export interface ReleaseNotes {
    version: string;
    highlights: ReleaseHighlight[];
}

export const RELEASE_NOTES: ReleaseNotes = {
    version: '0.4.0',
    highlights: [
        {
            kind: 'new',
            icon: 'rocket',
            title: 'Get Started wizard',
            text: 'Sign in with your Microsoft account or a personal access token, and ADO Boards fills in your directory, organization, project and teams for you.'
        },
        {
            kind: 'new',
            icon: 'organization',
            title: 'More than one team',
            text: 'Pick every team you work in. The primary team drives boards, backlogs and sprints.'
        },
        {
            kind: 'new',
            icon: 'pulse',
            title: 'Connection check',
            text: 'The status bar shows when Azure DevOps can’t be reached or your sign-in has expired, and views reload when the connection is back. Use Check Connection or Sign In Again at any time.'
        },
        {
            kind: 'fixed',
            icon: 'key',
            title: 'Expired sign-ins renew themselves',
            text: 'An expired Microsoft sign-in is refreshed silently and the request retried, instead of failing.'
        },
        {
            kind: 'fixed',
            icon: 'bell',
            title: 'One prompt instead of many',
            text: 'When a sign-in or token can’t be renewed, you get a single prompt to sign in again instead of an error for every request.'
        }
    ]
};

/** The globalState key that remembers which release's notes were shown (kept from earlier versions). */
export const LAST_SHOWN_RELEASE_KEY = 'lastShownAnnouncementId';

export function releaseId(notes: ReleaseNotes): string {
    return `v${notes.version}`;
}

export type StartupView = 'onboarding' | 'whatsNew' | 'none';

export interface StartupContext {
    /** An organization URL is configured. */
    configured: boolean;
    /** The user chose "Skip setup" in the wizard. */
    onboardingDismissed: boolean;
    /** The release id last shown, from globalState. */
    lastShownRelease: string | undefined;
}

/**
 * New installs and empty configurations get the wizard (which includes What's new).
 * Configured users get only What's new, once per release.
 */
export function decideStartupView(ctx: StartupContext, notes: ReleaseNotes = RELEASE_NOTES): StartupView {
    if (!ctx.configured) {
        return ctx.onboardingDismissed ? 'none' : 'onboarding';
    }
    return ctx.lastShownRelease === releaseId(notes) ? 'none' : 'whatsNew';
}
